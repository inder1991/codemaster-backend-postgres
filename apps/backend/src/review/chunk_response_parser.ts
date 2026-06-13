// `parseWithSkipMalformed` — deterministic activity-boundary enforcement seam for the
// `bedrock_review_chunk` activity. Parses
// LLM tool_use response blocks ONE-AT-A-TIME (so a single malformed block doesn't poison the whole
// response), then applies the two inv-14 / inv-15 structural enforcement layers:
//
//   inv-14 (v9-MINIMAL R-6) — SCOPE authority. `bedrock_review_chunk` is chunk-scoped, so any finding the
//   LLM emits with scope ∈ {cross_chunk, pr_global} is a protocol violation and is DROPPED at the
//   boundary (counter increments). The scope-violation counter is SINGLE-SOURCED HERE at the parser per
//   CLAUDE.md invariant 14 — the aggregator backstop drops via the same `activityMayEmitScope` oracle but
//   does NOT re-emit, to avoid double-counting.
//
//   inv-15 (v10 R-6) — EVIDENCE-grounding subset check. `allowedEvidenceIds` semantics:
//     * null          → validation DISABLED (back-compat with pre-v10 callers); no evidence counters fire.
//     * empty set      → no refs allowed; any non-empty refs dropped.
//     * non-empty set  → subset check: `set(finding.evidence_refs) ⊆ allowedEvidenceIds`.
//   Dual counters (architectural-review #1 — two semantically distinct failure modes):
//     * invalid-ref drop  → `codemaster_finding_evidence_ref_invalid_total{source="parser"}` (hallucinated
//       grounding; steady-state ZERO).
//     * empty-ref finding → `codemaster_findings_without_evidence_refs_total{source_present_in_manifest}`
//       (grounding-avoidance signal; empty refs PASS per the SHOULD-not-MUST schema wording).
//
// PURE — no clock, no random, no DB, no I/O. The counters route through the no-op-safe `getMeter` seam.
// Drops never RAISE (one bad finding must not poison the whole response — consistent with the
// malformed-skip semantics of the per-block loop).

import { activityMayEmitScope } from "#backend/review/aggregation.js";
import { parseToolUse, ReviewFindingParseError } from "#backend/review/tool_schema.js";

import type { ArbitrationIntentV1 } from "#contracts/arbitration_intent.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

import { type Counter, getMeter } from "#platform/observability/metrics.js";

// ─── counters (single-sourced at the parser; bounded-cardinality labels ONLY) ────────────────────────
//
// Names + descriptions are byte-identical to the Python pipeline_metrics.py equivalents so existing
// dashboards/alerts map unchanged. Instruments are cached at MODULE scope (created once at import) per
// the metrics-seam convention.

/** Counter name (byte-identical to the Python constant). */
const FINDING_SCOPE_VIOLATION_ATTEMPTED_COUNTER_NAME =
  "codemaster_finding_scope_violation_attempted_total";
/** Counter description (byte-identical text). */
const FINDING_SCOPE_VIOLATION_DESCRIPTION =
  "Findings dropped by the v9-MINIMAL activity-boundary parser " +
  "structural scope-consistency check " +
  "(codemaster/review/activities.py::_parse_with_skip_malformed). " +
  "Single-sourced at the parser per audit-remediation-2 R-2 " +
  "(aggregator backstop also drops via the same " +
  "`activity_may_emit_scope` oracle per audit-remediation-2 R-17 " +
  "but does NOT re-emit to avoid double-counting). A non-zero " +
  "rate is a PROTOCOL VIOLATION signal — the LLM emitted a scope " +
  "value the current activity is not authorized to emit. " +
  "Investigate the prompt + tool-schema instructions. Label " +
  "`scope_emitted` is bounded by the FindingScope enum " +
  "({chunk_observed, cross_chunk, pr_global}); `chunk_observed` " +
  "is unreachable in steady state because " +
  "`activity_may_emit_scope` always returns True for it. " +
  "No per-tenant labels per cardinality discipline. See plan " +
  "docs/superpowers/plans/2026-05-23-v9-scoped-findings-protocol.md " +
  "R-3 + R-13.";

/** Counter name (byte-identical to the Python constant). */
const FINDING_EVIDENCE_REF_INVALID_COUNTER_NAME = "codemaster_finding_evidence_ref_invalid_total";
/** Counter description (byte-identical text). */
const FINDING_EVIDENCE_REF_INVALID_DESCRIPTION =
  "Findings dropped because their evidence_refs cited an ev_id " +
  "NOT in the issued ReviewContextV1.retrieved_evidence manifest. " +
  "Steady-state expectation: ZERO. A non-zero rate is a PROTOCOL " +
  "VIOLATION: the LLM emitted a hallucinated grounding reference " +
  "(the v10 architectural defect class). Label `source` ∈ " +
  "{parser} post-Fix-C-2 (2026-05-24); aggregator backstop was " +
  "deleted as dead code (label space retained for forward-compat). " +
  "See plan docs/superpowers/plans/2026-05-24-v8-v9-v10-" +
  "remediation.md Fix C-2 + ADR-0051 § 4.";

/** Counter name (byte-identical to the Python constant). */
const FINDINGS_WITHOUT_EVIDENCE_REFS_COUNTER_NAME = "codemaster_findings_without_evidence_refs_total";
/** Counter description (byte-identical text). */
const FINDINGS_WITHOUT_EVIDENCE_REFS_DESCRIPTION =
  "Findings emitted with empty evidence_refs. Operational drift " +
  "signal — NOT a structural violation (v10 uses SHOULD-not-MUST " +
  "for evidence_refs per back-compat policy). Label " +
  "`source_present_in_manifest` ∈ {true, false} distinguishes " +
  "grounding-avoidance (manifest available; LLM chose empty refs) " +
  "from structurally-expected (no manifest available). Investigate " +
  "if rate-with-manifest-present sustained above baseline. See plan " +
  "docs/superpowers/plans/2026-05-23-v10-provenance-and-control-" +
  "loops.md R-11 + ADR-0051.";

// Meter name (byte-identical to the observability constant).
const METER = getMeter("codemaster.review.finding_filters");

const SCOPE_VIOLATION_COUNTER: Counter = METER.createCounter(
  FINDING_SCOPE_VIOLATION_ATTEMPTED_COUNTER_NAME,
  { description: FINDING_SCOPE_VIOLATION_DESCRIPTION },
);
const EVIDENCE_REF_INVALID_COUNTER: Counter = METER.createCounter(
  FINDING_EVIDENCE_REF_INVALID_COUNTER_NAME,
  { description: FINDING_EVIDENCE_REF_INVALID_DESCRIPTION },
);
const WITHOUT_EVIDENCE_REFS_COUNTER: Counter = METER.createCounter(
  FINDINGS_WITHOUT_EVIDENCE_REFS_COUNTER_NAME,
  { description: FINDINGS_WITHOUT_EVIDENCE_REFS_DESCRIPTION },
);

/** v9-MINIMAL R-13: increment the finding-scope violation counter. NO per-tenant labels. */
function recordFindingScopeViolationAttempted(scopeEmitted: string): void {
  SCOPE_VIOLATION_COUNTER.add(1, { scope_emitted: scopeEmitted });
}

/** v10 R-11: increment the invalid-evidence-ref counter (source='parser' is the only live value). */
function recordFindingEvidenceRefInvalid(source: string): void {
  EVIDENCE_REF_INVALID_COUNTER.add(1, { source });
}

/** v10 R-11: increment the missing-evidence-refs counter. The bool is pinned to "true"/"false" for
 *  label-stability, mirroring the Python Prometheus-exporter serialization. */
function recordFindingsWithoutEvidenceRefs(sourcePresentInManifest: boolean): void {
  WITHOUT_EVIDENCE_REFS_COUNTER.add(1, {
    source_present_in_manifest: sourcePresentInManifest ? "true" : "false",
  });
}

// Hardcoded upstream activity name — the ONLY caller of this parser.
const ACTIVITY_NAME = "bedrock_review_chunk";

/**
 * Parse blocks one-at-a-time so a single malformed block doesn't poison the whole response, then apply
 * the inv-14 scope-authority drop + inv-15 evidence-refs subset enforcement.
 *
 * @param blocks  the LLM `tool_use` response blocks.
 * @param options.allowedEvidenceIds
 *   * `null` (or omitted) → evidence validation DISABLED (back-compat; no evidence counters fire).
 *   * empty set            → no refs allowed; any non-empty refs dropped.
 *   * non-empty set        → subset check: `set(finding.evidence_refs) ⊆ allowedEvidenceIds`.
 * @param options.onMalformedSkip  optional hook fired once per skipped malformed finding block (carries
 *   the `blockId` + `reason` the Python `_LOG.warning(...)` emits); default no-op (keeps the parser pure).
 *
 * @returns `{ findings, intents }` — the kept findings (post-scope + post-evidence enforcement) and all
 *   parsed arbitration intents (intents bypass the finding-side enforcement, mirroring the Python).
 */
export function parseWithSkipMalformed(
  blocks: ReadonlyArray<Record<string, unknown>>,
  options: {
    readonly allowedEvidenceIds?: ReadonlySet<string> | null | undefined;
    readonly onMalformedSkip?: ((info: { readonly blockId: string; readonly reason: string }) => void) | undefined;
  } = {},
): { findings: Array<ReviewFindingV1>; intents: Array<ArbitrationIntentV1> } {
  const allowedEvidenceIds = options.allowedEvidenceIds ?? null;
  const onMalformedSkip = options.onMalformedSkip;

  // v10 R-6: precompute manifest-availability for the missing-refs counter label. `null` disables
  // evidence validation entirely. Mirrors the Python `evidence_enabled` / `manifest_present` locals
  // (Python `bool(allowed_evidence_ids)` is "non-empty set?"; an empty set → False).
  const evidenceEnabled = allowedEvidenceIds !== null;
  const manifestPresent = evidenceEnabled ? allowedEvidenceIds.size > 0 : false;

  const findings: Array<ReviewFindingV1> = [];
  const intents: Array<ArbitrationIntentV1> = [];

  for (const block of blocks) {
    let blockFindings: Array<ReviewFindingV1>;
    let blockIntents: Array<ArbitrationIntentV1>;
    try {
      [blockFindings, blockIntents] = parseToolUse([block]);
    } catch (e) {
      if (e instanceof ReviewFindingParseError) {
        // Mirrors the Python `_LOG.warning("...skipping malformed tool block", extra=...)`.
        onMalformedSkip?.({ blockId: e.blockId, reason: e.reason });
        continue;
      }
      throw e;
    }

    // inv-14 (v9-MINIMAL R-6): enforce activity-boundary scope authority. Drop + counter on violation;
    // do NOT raise.
    for (const finding of blockFindings) {
      if (!activityMayEmitScope(ACTIVITY_NAME, finding.scope)) {
        recordFindingScopeViolationAttempted(finding.scope);
        continue;
      }
      // inv-15 (v10 R-6): evidence-grounding subset check.
      if (evidenceEnabled) {
        const refs = finding.evidence_refs;
        if (refs.length === 0) {
          // Empty refs — PASS (SHOULD-not-MUST per schema wording) but emit the missing-refs counter
          // with the manifest-availability label.
          recordFindingsWithoutEvidenceRefs(manifestPresent);
        } else if (!isSubset(refs, allowedEvidenceIds)) {
          recordFindingEvidenceRefInvalid("parser");
          continue;
        }
      }
      findings.push(finding);
    }
    intents.push(...blockIntents);
  }

  return { findings, intents };
}

/** True iff every element of `refs` is in `allowed` — the Python `set(refs) <= allowed_evidence_ids`. */
function isSubset(refs: ReadonlyArray<string>, allowed: ReadonlySet<string>): boolean {
  for (const ref of refs) {
    if (!allowed.has(ref)) {
      return false;
    }
  }
  return true;
}
