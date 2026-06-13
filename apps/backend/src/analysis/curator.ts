// AnalysisCurator — promotes AnalysisFindingV1s (linter output) to ReviewFindingV1s
// (reviewer-facing comments) via two paths:
//
//   1. ALWAYS-PROMOTE: gitleaks + trivy findings translate directly to
//      ReviewFindingV1(severity="blocker", category="security") with NO LLM invocation.
//   2. CURATED: eslint / ruff findings are sent to Haiku via the CURATE_TOOL_SCHEMA. The model
//      decides which to promote; non-promoted findings are dropped.
//
// Degradation (curator_skipped):
//   * zero findings → skipped (empty result, no LLM call).
//   * only always-promote tools present (nothing curatable) → skipped (no Haiku call).
//   * ANY failure during the Haiku path EXCEPT LlmOutputUnsafeError → FAIL-OPEN (W1.9b / C1): WARN
//     log + return the always-promote findings only + curator_skipped=True.
//
// W1.9b (C1) HARDENING DIVERGENCE — the original implementation re-raised budget / output-unsafe /
// invocation errors as ApplicationError, which made a Tier-1 curator hiccup review-fatal: an org at
// its daily cost cap had EVERY review die on the cheap Haiku call before the expensive Tier-2 fan-out
// ran (priority inversion against the documented contract — "Tier 1 is an optimization layer for
// Tier 2 quality, not a correctness dependency"). The TS curator now fails OPEN on
// BedrockBudgetExceededError and the whole retryable LlmInvocationError family (throttle / 5xx /
// timeout / auth / role-resolution); ONLY LlmOutputUnsafeError still re-raises (output safety is not
// negotiable — and the orchestrator's static_analysis stageOutcome wrap degrades even that to a
// review-level note rather than a dead review).
//
// The curator holds an injected LlmClientCache and resolves the curator's LlmClient per call via the
// SECONDARY role (Haiku — the secondary slot per the primary/secondary contract). The model is sourced
// from the central purpose→model seed (analysis_curator → claude-haiku-4-5; ADR-0060 step 0); the
// DB-backed async resolve is out of scope here, so the pure seed resolver IS the unconfigured
// fallback.
//
// Runtime context: this runs inside the static_analysis ACTIVITY (the normal Node runtime, NOT the
// workflow V8-isolate sandbox).

import { createHash } from "node:crypto";

import { purposeChunkId } from "#backend/integrations/llm/invocation_ledger.js";
import { buildSystemPrompt } from "#backend/llm/review_prompt.js";
import { modelForPurpose } from "#backend/llm/model_router.js";
import { wrapUntrusted } from "#backend/security/trust_tier_wrapping.js";

import type { LlmClient } from "#backend/integrations/llm/client.js";
import { LlmOutputUnsafeError } from "#backend/integrations/llm/errors.js";

import {
  CURATE_TOOL_SCHEMA,
  CurateParseError,
  parseCurateToolUse,
} from "#backend/analysis/curator_schema.js";

import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import type { LlmMessage } from "#contracts/llm_message.v1.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import type { PrMetaV1 } from "#contracts/walkthrough.v1.js";

/** The cache the curator resolves the Haiku LlmClient from. Mirrors `LlmClientCache.forRole`. */
export type LlmClientCacheLike = {
  forRole(role: string): Promise<LlmClient>;
};

/**
 * de-Temporal Phase 2 (D2 / W2.2) — the tool-schema-version component of the curator's LLM-invocation
 * idempotency key. A content-addressable digest of CURATE_TOOL_SCHEMA: a tool-schema change (which changes
 * the SHAPE of the structured output, and therefore the parse) changes the key, so a stale stored response
 * is NOT replayed. `createHash` is the gate-sanctioned hashing primitive (clock_random gate bans random fns,
 * NOT createHash).
 */
export const CURATE_TOOL_SCHEMA_VERSION = `cts-${createHash("sha256")
  .update(Buffer.from(JSON.stringify(CURATE_TOOL_SCHEMA), "utf-8"))
  .digest("hex")
  .slice(0, 16)}`;

/**
 * Tools whose findings ALWAYS bypass the curator + go straight to ReviewFindingV1 at severity=blocker,
 * category=security. A ReadonlySet keeps the membership test off a dynamic object index.
 */
const ALWAYS_PROMOTE_TOOLS: ReadonlySet<string> = new Set<string>(["gitleaks", "trivy"]);

/**
 * Curator output.
 *
 * `findings` is the full curated set (always-promote + Haiku-promoted). `curator_skipped` is True when
 * the Haiku call was skipped (zero curatable input) or failed (degradation path); callers surface it
 * via the walkthrough degradation_note. Named `curator_skipped` (snake_case) to match the field the
 * downstream StaticAnalysisResultV1 envelope carries.
 */
export type CuratedResult = {
  readonly findings: ReadonlyArray<ReviewFindingV1>;
  readonly curator_skipped: boolean;
};

/** Translate an always-promote (gitleaks/trivy) finding directly to a ReviewFindingV1. */
function autoPromote(finding: AnalysisFindingV1): ReviewFindingV1 {
  return ReviewFindingV1.parse({
    file: finding.file,
    start_line: finding.start_line,
    end_line: finding.end_line,
    severity: "blocker",
    category: "security",
    title: `${finding.tool}: ${finding.rule_id}`,
    body: finding.message,
    suggestion: finding.fix_suggestion,
    confidence: 0.99,
  });
}

/**
 * Assemble the untrusted-wrapped user content for Haiku. Exported for the Tier-1 parity oracle —
 * char-for-char significant (the recorded LLM interaction is keyed on these exact bytes).
 */
export function buildCuratorUserMessage(args: {
  prMeta: PrMetaV1;
  findings: ReadonlyArray<AnalysisFindingV1>;
}): string {
  const { prMeta, findings } = args;
  const parts: Array<string> = [
    `# pull request: ${prMeta.repo}`,
    `## title\n${prMeta.pr_title}`,
    `## description\n${prMeta.pr_description}`,
    "",
    `## linter findings to triage (${findings.length})`,
    "Decide which findings are worth surfacing as reviewer " +
      "comments. Promote each kept finding via the curate_finding " +
      "tool exactly once. Drop the rest by NOT calling the tool " +
      "for them. Do not modify the file/line/range.",
    "",
  ];
  for (const f of findings) {
    parts.push(
      `- [${f.tool}:${f.rule_id}] ${f.file}:${f.start_line}-${f.end_line} ` +
        `(${f.severity_raw}) ${f.message}`,
    );
  }
  return wrapUntrusted(parts.join("\n"));
}

/**
 * Parse curate tool_use blocks one-at-a-time so a single malformed block doesn't poison the whole
 * response. Does NOT enforce v9-MINIMAL scope / v10 evidence_refs — curator findings are Tier-1
 * derivatives that are structurally chunk-local with no LLM-cited evidence, so the contract defaults
 * scope=chunk_observed + evidence_refs=[] are correct without enforcement. A CurateParseError on one
 * block is logged + skipped.
 */
function parseWithSkipMalformed(
  blocks: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<ReviewFindingV1> {
  const out: Array<ReviewFindingV1> = [];
  for (const block of blocks) {
    try {
      const chunk = parseCurateToolUse([block]);
      out.push(...chunk);
    } catch (e) {
      if (e instanceof CurateParseError) {
        // Skip the malformed block; the rest of the call survives. An observability-only WARN log
        // (block_id + reason) would have no return-value effect, so it is intentionally omitted.
        continue;
      }
      throw e;
    }
  }
  return out;
}

/**
 * Promote linter findings to reviewer-facing comments via Haiku.
 */
export class AnalysisCurator {
  private readonly cache: LlmClientCacheLike;
  private readonly modelOverride: string | undefined;
  private readonly policyRevision: number;

  public constructor(args: {
    cache: LlmClientCacheLike;
    // ADR-0060: the curator resolves its model via the purpose→model seed (analysis_curator →
    // claude-haiku-4-5) by default. An explicit model= still overrides (eval / tests).
    model?: string;
    policyRevision?: number;
  }) {
    this.cache = args.cache;
    this.modelOverride = args.model;
    this.policyRevision = args.policyRevision ?? 0;
  }

  /**
   * Curate `findings` against `prMeta`. Always-promote tools (gitleaks/trivy) bypass the LLM; the rest
   * go to Haiku via the curate_finding tool. Returns the full curated set + curator_skipped.
   */
  public async curate(
    findings: ReadonlyArray<AnalysisFindingV1>,
    args: { prMeta: PrMetaV1 },
  ): Promise<CuratedResult> {
    if (findings.length === 0) {
      return { findings: [], curator_skipped: true };
    }

    const alwaysPromote: Array<ReviewFindingV1> = [];
    const curatable: Array<AnalysisFindingV1> = [];
    for (const f of findings) {
      if (ALWAYS_PROMOTE_TOOLS.has(f.tool)) {
        alwaysPromote.push(autoPromote(f));
      } else {
        curatable.push(f);
      }
    }

    // Skip the Haiku call entirely when there's nothing to curate.
    if (curatable.length === 0) {
      return { findings: alwaysPromote, curator_skipped: true };
    }

    try {
      const curated = await this.invokeHaiku(curatable, { prMeta: args.prMeta });
      return { findings: [...alwaysPromote, ...curated], curator_skipped: false };
    } catch (e) {
      // W1.9b (C1) — HARDENING DIVERGENCE: an earlier typed-error re-raise inverted priorities.
      // The curator is an OPTIMIZATION layer for Tier-2 quality, not a correctness dependency, so a
      // re-raise here was wrong: a BedrockBudgetExceededError (a NORMAL steady-state
      // condition at per-org cost caps) or a retryable LlmInvocationError (throttle / 5xx / timeout —
      // routine under load) killed the whole static-analysis envelope, and — pre the orchestrator
      // fail-open wrap — the entire review, BEFORE the expensive Tier-2 fan-out ran.
      //
      // NEW CONTRACT: ONLY LlmOutputUnsafeError re-raises (the output-safety contract is not
      // negotiable; the orchestrator's static_analysis stageOutcome degrades it review-side).
      // EVERYTHING else — budget, the whole LlmInvocationError family, role-resolution failures,
      // parse errors, unknown classes — FAILS OPEN: WARN log (the operator signal; curator_skipped on
      // the output contract is the data signal) + the always-promote findings only.
      if (e instanceof LlmOutputUnsafeError) {
        throw e;
      }
      const errorClass = e instanceof Error ? e.constructor.name : typeof e;
      const errorMsg = (e instanceof Error ? e.message : String(e)).slice(0, 512);
      console.warn(
        `curator: Haiku curation failed open; promoting always-promote findings only ` +
          `error_class=${errorClass} error_msg=${JSON.stringify(errorMsg)} ` +
          `curatable_count=${curatable.length} always_promote_count=${alwaysPromote.length}`,
      );
      return { findings: alwaysPromote, curator_skipped: true };
    }
  }

  // ─── internals ───────────────────────────────────────────────────────────────────────────────

  private async invokeHaiku(
    curatable: ReadonlyArray<AnalysisFindingV1>,
    args: { prMeta: PrMetaV1 },
  ): Promise<ReadonlyArray<ReviewFindingV1>> {
    const role = "secondary";
    // Resolve the Haiku LlmClient via the SECONDARY role. A resolution failure (role-not-configured /
    // disabled — subclasses of LlmInvocationError) is a curator-degradation: it propagates to
    // curate()'s catch, which (W1.9b / C1) fails OPEN for everything except LlmOutputUnsafeError.
    const llmClient = await this.cache.forRole(role);

    const systemPrompt = buildSystemPrompt({ policyRevision: this.policyRevision });
    const messages: Array<LlmMessage> = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: buildCuratorUserMessage({ prMeta: args.prMeta, findings: curatable }),
      },
    ];
    // ADR-0060 step 0: source the curator model from the central purpose→model seed
    // (analysis_curator → claude-haiku-4-5). An explicit override wins (eval / tests).
    const model = this.modelOverride ?? modelForPurpose("analysis_curator");

    const result = await llmClient.invokeModel({
      role,
      model: model as Parameters<LlmClient["invokeModel"]>[0]["model"],
      messages,
      tools: [CURATE_TOOL_SCHEMA as unknown as Record<string, unknown>],
      // S17.X-tool-dispatch — purpose pins routing + cost-cap attribution to the analysis-curator
      // budget.
      purpose: "analysis_curator",
      // The REAL installation_id flows to the cost-cap (per-org isolation), blob put, and
      // telemetry/Langfuse rows — mirrors the walkthrough port. Unlike a platform-scoped call, the
      // curation is per-PR, so the PR's installation owns it.
      installationId: args.prMeta.installation_id,
      // de-Temporal Phase 2 (D2 / W2.2 / F9) — ledger this PR-level paid call by PURPOSE. The stable key is
      // review_id (prMeta.pr_id) + the purpose chunk-key surrogate (purposeChunkId("curator"), E8) + role +
      // model + prompt hash + CURATE_TOOL_SCHEMA_VERSION. run_id is deliberately NOT in the key (D2: output
      // need not change per run). On a retry the stored provider response replays instead of buying a second
      // paid Haiku completion. F9: the SAME "curator" token drives BOTH the chunk-key surrogate AND the
      // metric purpose label. No-op when the client has no ledger (unit tests / platform jobs).
      idempotency: {
        reviewId: args.prMeta.pr_id,
        chunkId: purposeChunkId("curator"),
        toolSchemaVersion: CURATE_TOOL_SCHEMA_VERSION,
        ledgerPurpose: "curator",
      },
    });

    return parseWithSkipMalformed([...result.raw_content_blocks]);
  }
}

