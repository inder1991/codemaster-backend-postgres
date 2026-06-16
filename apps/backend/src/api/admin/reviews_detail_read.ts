// Reviews detail read — 1:1 in intent with review_detail.py + postgres_review_detail_repo.py.
// Joins pull_request_reviews + repositories + pull_requests + review_runs + posted_reviews +
// review_findings + audit.workflow_events. Returns ReviewDetailV1 with findings/activities + deep-links.
//
// Schema notes (vs the Python reference): core.pull_request_reviews has NO `title` column (the title is
// COALESCEd from core.pull_requests via repository_id+pr_number, mirroring admin_read_repo.searchReviews);
// the review→repo join is repo.github_repo_id = pr.repo_id; review_findings PK is review_finding_id;
// audit.workflow_events.event_type is CHECK-constrained (no 'STARTED' — 'ANALYSIS_STARTED' etc.).

import { type Kysely, sql } from "kysely";

import type {
  ActivityEventV1,
  FixPromptSummaryV1,
  GovernancePanelV1,
  GovernanceRuleV1,
  ReviewDetailV1,
  ReviewFindingItemV1,
  WalkthroughSummaryV1,
} from "#contracts/admin.v1.js";
import { ResolvedGuidanceBundleV1 } from "#contracts/resolved_guidance.v1.js";
import { WalkthroughV1 } from "#contracts/walkthrough.v1.js";
import { SUPER_ADMIN_PLATFORM_VIEW_UUID } from "#backend/infra/sentinels.js";

const FINDINGS_LIMIT = 500;
const ACTIVITIES_LIMIT = 200;

export class ReviewDetailNotFoundError extends Error {
  public constructor(reviewId: string) {
    super(`review not found: ${reviewId}`);
    this.name = "ReviewDetailNotFoundError";
  }
}

function isoOrNull(d: Date | null): string | null {
  return d === null ? null : new Date(d).toISOString();
}

function iso(d: Date): string {
  return new Date(d).toISOString();
}

type HeadRow = {
  review_id: string;
  repo: string;
  repository_id: string;
  pr_number: number;
  pr_title: string;
  state: "queued" | "in_progress" | "complete" | "failed";
  pr_id: string | null;
  current_run_id: string | null;
  posted_at: Date | null;
  // P1-A PR meta-row + publication verdict.
  pr_author: string | null;
  base_ref: string | null;
  head_ref: string | null;
  draft: boolean;
  pr_description: string | null;
  publication_outcome: "inline_posted" | "body_only_posted" | "degraded_unposted" | null;
};

type FindingRow = {
  review_finding_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  severity: "blocker" | "issue" | "suggestion" | "nit";
  title: string;
  body: string;
  suggestion: string | null;
  source_tool: string | null;
  // citations JSONB cast to text — drives the P2 governance scorecard (policy_rule locators).
  citations: string | null;
};

type ActivityRow = {
  sequence_no: number;
  event_type: string;
  received_at: Date;
};

type BundleRow = { applied_bundle: string };
type WalkthroughRow = { walkthrough: string };
type TraceRow = { trace_id: string };
type FixPromptRow = {
  prompt: string;
  generation_mode: "llm" | "deterministic_fallback";
  finding_count: number;
  truncated: boolean;
  generated_at: Date;
};

/** Parse the `citations` JSONB (cast to text) and return the set of policy-rule locators a finding
 *  cites. Mirrors postgres_review_detail_repo._parse_citations' policy_rule extraction: malformed /
 *  non-policy_rule / locator-less entries are skipped defensively so one bad citation can't 500 the
 *  page. */
function policyRuleLocators(raw: string | null): Set<string> {
  const out = new Set<string>();
  if (raw === null || raw === "") return out;
  let items: unknown;
  try {
    items = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    if (typeof it !== "object" || it === null) continue;
    const rec = it as Record<string, unknown>;
    if (rec["kind"] !== "policy_rule") continue;
    const locator = rec["locator"];
    if (typeof locator === "string" && locator.length > 0) out.add(locator);
  }
  return out;
}

/** Cross-reference the persisted applied policy bundle against findings' policy_rule citations to
 *  build the governance scorecard (P2). null when no bundle was persisted. Violated = applied
 *  rule_ids cited by a finding; satisfied = the rest. Violated rules sort first, then by rule_id, for
 *  stable rendering. 1:1 with postgres_review_detail_repo._build_governance. A bundle that fails to
 *  parse is treated as absent (fail-soft — never 500 the page on one bad row). */
function buildGovernance(bundleJson: string | null, violated: Set<string>): GovernancePanelV1 | null {
  if (bundleJson === null || bundleJson === "") return null;
  const parsed = ResolvedGuidanceBundleV1.safeParse(JSON.parse(bundleJson));
  if (!parsed.success) return null;
  const rules: Array<GovernanceRuleV1> = parsed.data.applicable_rules
    .map((d) => ({
      rule_id: d.rule.rule_id,
      title: d.rule.title,
      source_file: d.rule.source_file,
      category: d.rule.category,
      intent: d.rule.intent,
      status: (violated.has(d.rule.rule_id) ? "violated" : "satisfied") as "violated" | "satisfied",
    }))
    .sort((a, b) => {
      // Violated first (false<true on the "not violated" key), then rule_id ascending.
      const av = violated.has(a.rule_id) ? 0 : 1;
      const bv = violated.has(b.rule_id) ? 0 : 1;
      if (av !== bv) return av - bv;
      return a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0;
    });
  const violatedCount = rules.filter((r) => r.status === "violated").length;
  return {
    policy_rules: rules,
    applied_count: rules.length,
    violated_count: violatedCount,
    satisfied_count: rules.length - violatedCount,
  };
}

/** Project the persisted WalkthroughV1 into the slim admin summary (P3). null when no walkthrough was
 *  persisted. configuration_section_md + sanitization_event are intentionally dropped (operator
 *  detail). 1:1 with postgres_review_detail_repo._build_walkthrough_summary. Fail-soft on parse. */
function buildWalkthroughSummary(walkthroughJson: string | null): WalkthroughSummaryV1 | null {
  if (walkthroughJson === null || walkthroughJson === "") return null;
  const parsed = WalkthroughV1.safeParse(JSON.parse(walkthroughJson));
  if (!parsed.success) return null;
  const wt = parsed.data;
  return {
    tldr: wt.tldr,
    file_rows: wt.file_rows.map((r) => ({
      path: r.path,
      change_summary: r.change_summary,
      severity_max: r.severity_max,
      finding_count: r.finding_count,
    })),
    degradation_note: wt.degradation_note,
    suggested_reviewers: [...wt.suggested_reviewers],
    linked_issues: wt.linked_issues.map((li) => ({
      issue_number: li.issue_number,
      linkage_kind: li.linkage_kind,
      title: li.title,
      state: li.state,
    })),
  };
}

/** Project a core.fix_prompts row into the slim admin summary. null when no fix prompt was generated
 *  (reviews before the feature, or zero-finding reviews). 1:1 with
 *  postgres_review_detail_repo._build_fix_prompt_summary. */
function buildFixPromptSummary(row: FixPromptRow | undefined): FixPromptSummaryV1 | null {
  if (row === undefined) return null;
  return {
    prompt: row.prompt,
    generation_mode: row.generation_mode,
    finding_count: row.finding_count,
    truncated: row.truncated,
    generated_at: iso(row.generated_at),
  };
}

/** Map audit.workflow_events.event_type to the activity state enum; default 'started' for unmapped types. */
const EVENT_TYPE_TO_STATE = new Map<string, ActivityEventV1["state"]>([
  ["SCHEDULED", "scheduled"],
  ["ANALYSIS_STARTED", "started"],
  ["RETRY_STARTED", "retrying"],
  ["ANALYZED", "completed"],
  ["COMMENT_POSTED", "completed"],
  ["FINDINGS_PERSISTED", "completed"],
]);

function mapEventTypeToState(eventType: string): ActivityEventV1["state"] {
  return EVENT_TYPE_TO_STATE.get(eventType) ?? "started";
}

export async function buildReviewDetail(
  db: Kysely<unknown>,
  args: { installationId: string; reviewId: string },
): Promise<ReviewDetailV1> {
  // Head query: join to get repo, pr, review_run, posted_review data. Mirrors searchReviews' join shape:
  // pull_request_reviews → repositories (github_repo_id) → pull_requests (repository_id+pr_number) →
  // review_runs (current_run_id) → posted_reviews (prr.pr_id).
  const headResult = await sql<HeadRow>`
    SELECT
      pr.review_id,
      repo.full_name AS repo,
      repo.repository_id,
      pr.pr_number,
      COALESCE(prr.title, 'PR #' || pr.pr_number::text) AS pr_title,
      CASE
        WHEN rr.lifecycle_state IS NULL                        THEN 'queued'
        WHEN rr.lifecycle_state = 'PENDING'                    THEN 'queued'
        WHEN rr.lifecycle_state IN ('RUNNING','WAITING_RETRY') THEN 'in_progress'
        WHEN rr.lifecycle_state IN ('COMPLETED','PARTIAL')     THEN 'complete'
        WHEN rr.lifecycle_state IN ('FAILED','CANCELLED')      THEN 'failed'
        ELSE 'queued'
      END AS state,
      prr.pr_id,
      pr.current_run_id,
      posted.posted_at,
      gh.login                   AS pr_author,
      prr.base_ref               AS base_ref,
      prr.head_ref               AS head_ref,
      COALESCE(prr.draft, false) AS draft,
      prr.body                   AS pr_description,
      posted.publication_outcome AS publication_outcome
    FROM core.pull_request_reviews pr
    JOIN core.repositories repo
      ON repo.github_repo_id = pr.repo_id
    LEFT JOIN core.pull_requests prr
      ON prr.repository_id = repo.repository_id
     AND prr.pr_number = pr.pr_number
    LEFT JOIN core.review_runs rr
      ON rr.run_id = pr.current_run_id
    LEFT JOIN core.posted_reviews posted
      ON posted.pr_id = prr.pr_id
    LEFT JOIN core.gh_users gh
      ON gh.gh_user_id = prr.author_gh_user_id
    WHERE pr.review_id = ${args.reviewId}
      AND (${args.installationId} = CAST(${SUPER_ADMIN_PLATFORM_VIEW_UUID} AS uuid)
           OR repo.installation_id = ${args.installationId})
  `.execute(db);

  const headRow = headResult.rows[0];
  if (headRow === undefined) {
    throw new ReviewDetailNotFoundError(args.reviewId);
  }

  // Findings query: filter suppression_state='NONE', order by severity desc then file_path asc.
  const findingsResult = await sql<FindingRow>`
    SELECT
      review_finding_id,
      file_path,
      start_line,
      end_line,
      severity,
      title,
      body,
      suggestion,
      source_tool,
      citations::text AS citations
    FROM core.review_findings
    WHERE (${args.installationId} = CAST(${SUPER_ADMIN_PLATFORM_VIEW_UUID} AS uuid)
           OR installation_id = ${args.installationId})
      AND pr_id = ${headRow.pr_id}
      AND suppression_state = 'NONE'
    ORDER BY
      CASE severity
        WHEN 'blocker'    THEN 4
        WHEN 'issue'      THEN 3
        WHEN 'suggestion' THEN 2
        WHEN 'nit'        THEN 1
        ELSE 0
      END DESC,
      file_path ASC,
      start_line ASC
    LIMIT ${FINDINGS_LIMIT}
  `.execute(db);

  // Activities query: join audit.workflow_events, tenancy via installation_id column.
  const activitiesResult = await sql<ActivityRow>`
    SELECT
      we.sequence_no,
      we.event_type,
      we.received_at
    FROM audit.workflow_events we
    WHERE we.review_id = ${args.reviewId}
      AND (${args.installationId} = CAST(${SUPER_ADMIN_PLATFORM_VIEW_UUID} AS uuid)
           OR we.installation_id = ${args.installationId})
    ORDER BY we.sequence_no ASC
    LIMIT ${ACTIVITIES_LIMIT}
  `.execute(db);

  // P2 — the per-review applied policy bundle. Tenancy via the installation_id token in the SQL.
  const bundleResult = await sql<BundleRow>`
    SELECT applied_bundle::text AS applied_bundle
    FROM core.review_policy_bundles
    WHERE review_id = ${args.reviewId}
      AND (${args.installationId} = CAST(${SUPER_ADMIN_PLATFORM_VIEW_UUID} AS uuid)
           OR installation_id = ${args.installationId})
  `.execute(db);

  // P3 — the per-review structured walkthrough. Tenancy via the installation_id token in the SQL.
  const walkthroughResult = await sql<WalkthroughRow>`
    SELECT walkthrough::text AS walkthrough
    FROM core.review_walkthroughs
    WHERE review_id = ${args.reviewId}
      AND (${args.installationId} = CAST(${SUPER_ADMIN_PLATFORM_VIEW_UUID} AS uuid)
           OR installation_id = ${args.installationId})
  `.execute(db);

  // fix-prompt — the per-review fix prompt (core.fix_prompts, keyed by review_id). Tenancy via the
  // installation_id token in the SQL.
  const fixPromptResult = await sql<FixPromptRow>`
    SELECT prompt, generation_mode, finding_count, truncated, generated_at
    FROM core.fix_prompts
    WHERE review_id = ${args.reviewId}
      AND (${args.installationId} = CAST(${SUPER_ADMIN_PLATFORM_VIEW_UUID} AS uuid)
           OR installation_id = ${args.installationId})
  `.execute(db);

  // P4 — the review's retrieval-trace id for the operator deep-link (most recent by captured_at).
  // core.retrieval_traces carries no installation_id column; the review_id is already tenant-verified
  // by the head row above (same basis as the Python reference's P4 trace read), so no tenancy token.
  const traceResult = await sql<TraceRow>`
    SELECT trace_id::text AS trace_id
    FROM core.retrieval_traces
    WHERE review_id = ${args.reviewId}
    ORDER BY captured_at DESC
    LIMIT 1
  `.execute(db);

  const findings: Array<ReviewFindingItemV1> = findingsResult.rows.map((r) => ({
    schema_version: 1,
    finding_id: r.review_finding_id,
    file_path: r.file_path,
    start_line: r.start_line,
    end_line: r.end_line,
    severity: r.severity,
    title: r.title,
    body: r.body,
    suggestion: r.suggestion,
    tool_source: r.source_tool,
  }));

  const activities: Array<ActivityEventV1> = activitiesResult.rows.map((r) => ({
    seq: r.sequence_no,
    activity_name: r.event_type,
    state: mapEventTypeToState(r.event_type),
    started_at: iso(r.received_at),
    completed_at: iso(r.received_at),
    detail: "",
  }));

  // Temporal workflow deep-link: only when a run is live (gated on current_run_id).
  let temporalUrl: string | null = null;
  if (headRow.current_run_id !== null) {
    const workflowId = `review/${args.installationId}/${headRow.repository_id}/${headRow.pr_number}`;
    temporalUrl = `https://temporal.internal/namespaces/codemaster/workflows/${workflowId}`;
  }

  // Langfuse URL: null (Phase 2 follow-up; trace_id not in schema today).
  const langfuseUrl: string | null = null;

  // P2 governance: violated = applied rule_ids cited by any finding (kind='policy_rule'). Aggregate
  // policy-rule locators across every finding, then cross-reference against the applied bundle.
  const violatedRuleIds = new Set<string>();
  for (const r of findingsResult.rows) {
    for (const loc of policyRuleLocators(r.citations)) violatedRuleIds.add(loc);
  }
  const governance = buildGovernance(bundleResult.rows[0]?.applied_bundle ?? null, violatedRuleIds);
  const walkthrough = buildWalkthroughSummary(walkthroughResult.rows[0]?.walkthrough ?? null);
  const fixPrompt = buildFixPromptSummary(fixPromptResult.rows[0]);
  const retrievalTraceId = traceResult.rows[0]?.trace_id ?? null;

  return {
    schema_version: 1,
    review_id: headRow.review_id,
    repo: headRow.repo,
    pr_number: headRow.pr_number,
    pr_title: headRow.pr_title,
    state: headRow.state,
    findings,
    activities,
    langfuse_url: langfuseUrl,
    temporal_url: temporalUrl,
    posted_at: isoOrNull(headRow.posted_at),
    pr_author: headRow.pr_author,
    base_ref: headRow.base_ref,
    head_ref: headRow.head_ref,
    draft: headRow.draft,
    pr_description: headRow.pr_description,
    publication_outcome: headRow.publication_outcome,
    governance,
    walkthrough,
    retrieval_trace_id: retrievalTraceId,
    fix_prompt: fixPrompt,
  };
}
