// Reviews detail read — 1:1 in intent with review_detail.py + postgres_review_detail_repo.py.
// Joins pull_request_reviews + repositories + pull_requests + review_runs + posted_reviews +
// review_findings + audit.workflow_events. Returns ReviewDetailV1 with findings/activities + deep-links.
//
// Schema notes (vs the Python reference): core.pull_request_reviews has NO `title` column (the title is
// COALESCEd from core.pull_requests via repository_id+pr_number, mirroring admin_read_repo.searchReviews);
// the review→repo join is repo.github_repo_id = pr.repo_id; review_findings PK is review_finding_id;
// audit.workflow_events.event_type is CHECK-constrained (no 'STARTED' — 'ANALYSIS_STARTED' etc.).

import { type Kysely, sql } from "kysely";

import type { ActivityEventV1, ReviewDetailV1, ReviewFindingItemV1 } from "#contracts/admin.v1.js";
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
};

type ActivityRow = {
  sequence_no: number;
  event_type: string;
  received_at: Date;
};

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
      posted.posted_at
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
      source_tool
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
  };
}
