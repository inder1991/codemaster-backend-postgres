/**
 * `aggregateFindings` activity — Phase-2.1 first core-loop activity port. 1:1 in intent with the frozen
 * Python `@activity.defn aggregate_findings` + `_do_aggregate`
 * (vendor/codemaster-py/codemaster/review/aggregate_activity.py): chain the three aggregation stages
 * (scope-consistency → exact-dedup → semantic-merge → rank+cap) into one entry point and return an
 * `AggregatedFindingsV1` envelope with per-stage statistics.
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047 closure
 *
 * The frozen Python activity dispatches with TWO positional arguments
 * (`aggregate_findings(findings, policy_revision)`) — the only known live invariant-11 violation
 * (head-of-eng-audit-2 R-14). This port CLOSES that violation: the single positional input is the
 * {@link AggregateFindingsInputV1} envelope (findings + policy_revision + schema_version). There is no
 * Python Pydantic counterpart for the envelope — it is introduced during the port.
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. The aggregation core
 * is nonetheless PURE + DETERMINISTIC (no clock, no random, no DB): `_doAggregate` is sandbox-safe by
 * construction, which is why this activity touches no Postgres (the aggregate stage operates entirely on
 * the in-memory findings tuple) and registers no clock/random seam.
 *
 * ## Semantic stage — deferred Qwen merge (skip path only)
 *
 * The activity constructs the pipeline with NO embedder, so `aggregateSemantic` always takes the
 * fail-open skip path: `after_semantic = after_exact`, `semantic_merged = 0`, and `semantic_skipped`
 * mirrors the frozen Python's `len < 2 ? false : true` flag exactly. The real Qwen cosine-merge is
 * deferred (needs the Qwen EmbeddingsPort adapter — a separate sub-project, FOLLOW-UP-aggregate-semantic-
 * qwen). See aggregation_semantic.ts for the seam.
 */

import {
  aggregateExact,
  assertFindingScopeConsistency,
  rankAndCap,
} from "#backend/review/aggregation.js";
import { aggregateSemantic } from "#backend/review/aggregation_semantic.js";

import type { AggregateFindingsInputV1 } from "#contracts/aggregate_findings.v1.js";
import type { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

/**
 * The `_do_aggregate` pipeline, ported EXACTLY (stage order + stat accumulation):
 *
 *   input_count    = findings.length
 *   [after_scope]  = assertFindingScopeConsistency(findings)            (drops non-chunk_observed)
 *   after_exact    = aggregateExact(after_scope)
 *   exact_dropped  = after_scope.length - after_exact.length
 *   [after_sem, semantic_skipped] = aggregateSemantic(after_exact)      (no embedder → skip path)
 *   semantic_merged = after_exact.length - after_sem.length             (always 0 on the skip path)
 *   [after_cap, capped] = rankAndCap(after_sem)
 *
 * Returns the `AggregatedFindingsV1` envelope. Exported so the Tier-1 parity oracle can drive the same
 * pipeline the activity runs (mirrors the frozen Python exporting `_do_aggregate` from the activity
 * module). No embedder is threaded — the semantic stage takes the skip path by construction.
 */
export function doAggregate(
  findings: ReadonlyArray<ReviewFindingV1>,
  policyRevision: number,
): AggregatedFindingsV1 {
  const inputCount = findings.length;

  // v9-MINIMAL R-3 structural scope-consistency check (drops findings whose scope != chunk_observed).
  const [afterScope] = assertFindingScopeConsistency(findings);

  const afterExact = aggregateExact(afterScope);
  const exactDropped = afterScope.length - afterExact.length;

  // No embedder → fail-open skip path (deferred Qwen merge). semantic_merged is always 0 here.
  const [afterSemantic, semanticSkipped] = aggregateSemantic(afterExact, undefined);
  const semanticMerged = afterExact.length - afterSemantic.length;

  const [afterCap, capped] = rankAndCap(afterSemantic);

  return {
    schema_version: 1,
    findings: afterCap,
    dedupe_stats: {
      input_count: inputCount,
      exact_dropped: exactDropped,
      semantic_merged: semanticMerged,
      capped,
      semantic_skipped: semanticSkipped,
    },
    policy_revision: policyRevision,
  };
}

/**
 * The registered activity. Takes the single typed {@link AggregateFindingsInputV1} envelope (invariant
 * 11) and runs {@link doAggregate} over its findings + policy_revision. Async to match the Temporal
 * activity signature (`Promise<AggregatedFindingsV1>`) and the sibling persist activity, even though the
 * pure aggregation core is synchronous (no I/O, no embedder).
 */
export async function aggregateFindings(
  input: AggregateFindingsInputV1,
): Promise<AggregatedFindingsV1> {
  return doAggregate(input.findings, input.policy_revision);
}
