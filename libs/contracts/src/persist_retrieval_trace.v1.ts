import { z } from "zod";

// Zod port of contracts/retrieval/persist_retrieval_trace/v1.py (Sub-spec B T13).
// Parity-validated in persist_retrieval_trace.v1.parity.test.ts.
//
// PersistRetrievalTraceInputV1 embeds RetrievalTraceV2 (contracts/retrieval/retrieval_trace/v2.py),
// which in turn reuses several v1 sub-models (contracts/retrieval/retrieval_trace/v1.py). NONE of
// the retrieval_trace tree is ported to libs/contracts/src/ yet, and this port may only touch its
// own two files, so the FULL embedded RetrievalTraceV2 subtree is ported inline here as named
// exports. When the retrieval_trace.v2 contract is ported on its own, these definitions move to a
// `./retrieval_trace.v2.js` sibling and this file imports them — for now they live here so the
// embedded shape is enforceable without an unresolvable import.
//
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() on every model (frozen is a TS-side
// concern, not wire). UUID fields are emitted by model_dump(mode="json") as lowercase RFC4122
// strings → z.string().uuid(). `= None` defaults → .nullable().default(null) (Pydantic dumps absent
// optionals as explicit null, so the Zod default injects null too). `default=()` tuples →
// z.array(...).default([]). schema_version is a bare int default (NOT z.literal) so forward wire
// versions are accepted by both sides.
//
// FLOAT NOTE: several fields are bare Python `float` (freshness_score, lambda_mmr, and the
// Stage-3 score components). model_dump(mode="json") emits e.g. `1.0` / `0.7` while a JS number
// emits `1` / `0.7`; the repo canonicalizer (test/parity/canonical.ts) REJECTS bare floats outright.
// So those columns cannot byte-match in a canonical diff — the parity test strips every bare-float
// field before the diff and asserts them structurally (same pattern as review_findings.v1's
// `confidence`). The Zod schema still enforces the numeric bounds.

// PriorityTierStr = Literal[...] (retrieval_trace/v1.py).
export const PriorityTierStr = z.enum([
  "SECURITY_POLICY",
  "REPO_ADR",
  "FRAMEWORK_GUIDANCE",
  "LANG_GUIDANCE",
  "DEFAULT_ONLY",
]);
export type PriorityTierStr = z.infer<typeof PriorityTierStr>;

// DropReason = Literal[...] (retrieval_trace/v2.py) — closed drop-reason vocabulary.
export const DropReason = z.enum([
  "mmr_redundant",
  "page_cap_exceeded",
  "default_scope_mismatch",
  "default_corpus_token_cap",
  "priority_tier_truncated",
  "token_budget_exhausted",
  "quarantined",
  "lifecycle_excluded",
]);
export type DropReason = z.infer<typeof DropReason>;

// `ev_<16-hex>` evidence-ref pattern minted by contracts.retrieved_evidence.v1::mint_evidence_id
// (ADR-0051 / CLAUDE.md Invariant 15). Mirrors RetrievedKnowledgeDecisionV1.evidence_ref's regex.
export const EV_REF_PATTERN = /^ev_[0-9a-f]{16}$/;

// DetectorTrace — retrieval_trace/v1.py. One detector's contribution to effective_labels.
export const DetectorTrace = z
  .object({
    schema_version: z.number().int().default(1),
    name: z.string().min(1).max(64),
    version: z.number().int().gte(1),
    emitted: z.array(z.string()).max(200).default([]),
  })
  .strict();
export type DetectorTrace = z.infer<typeof DetectorTrace>;

// Stage1Trace — retrieval_trace/v1.py. Per-label filter + cap funnel stats.
export const Stage1Trace = z
  .object({
    schema_version: z.number().int().default(1),
    candidates_in: z.number().int().gte(0),
    candidates_out: z.number().int().gte(0),
    per_label_cap_applied: z.boolean(),
  })
  .strict();
export type Stage1Trace = z.infer<typeof Stage1Trace>;

// Stage2Trace — retrieval_trace/v1.py. Per-tier preservation quota stats.
// per_tier_quotas: dict[str, int] → z.record of int (JSON keys are always str).
export const Stage2Trace = z
  .object({
    schema_version: z.number().int().default(1),
    per_tier_quotas: z.record(z.string(), z.number().int()),
    tier_pool_size: z.number().int().gte(0),
  })
  .strict();
export type Stage2Trace = z.infer<typeof Stage2Trace>;

// TokenAccounting — retrieval_trace/v1.py. Token-budget allocation outcome.
// reserved_floors_consumed: dict[str, int] = default_factory=dict → z.record(...).default({}).
export const TokenAccounting = z
  .object({
    schema_version: z.number().int().default(1),
    budget_total: z.number().int().gte(0),
    default_pool_used: z.number().int().gte(0),
    non_default_pool_used: z.number().int().gte(0),
    remaining: z.number().int().gte(0),
    reserved_floors_consumed: z.record(z.string(), z.number().int()).default({}),
  })
  .strict();
export type TokenAccounting = z.infer<typeof TokenAccounting>;

// RetrievedKnowledgeDecisionV1 — retrieval_trace/v2.py. Per-chunk decision record (selected OR
// dropped). drop_reason is set ONLY on dropped chunks; selected_because on selected ones.
// freshness_score is a bare float (default 0.0, [0,1]); the Stage-3 score components are
// `float | None` (default null). evidence_ref ~ ^ev_[0-9a-f]{16}$ (optional, default null).
export const RetrievedKnowledgeDecisionV1 = z
  .object({
    schema_version: z.number().int().default(1),
    chunk_id: z.string().uuid(),
    matched_labels: z.array(z.string()).max(100).default([]),
    emitting_detectors: z.array(z.string()).max(20).default([]),
    priority_tier: PriorityTierStr,
    match_specificity_score: z.number().int().gte(0),
    // Bare float, [0,1] — canonical-diff-excluded (see FLOAT NOTE), bound still enforced.
    freshness_score: z.number().gte(0).lte(1).default(0),
    // Selected-chunk-only fields (null on a dropped record).
    selected_because: z.string().max(200).nullable().default(null),
    // Bare float | None — canonical-diff-excluded when non-null.
    stage3_base_score: z.number().nullable().default(null),
    cosine_component: z.number().nullable().default(null),
    freshness_component: z.number().nullable().default(null),
    specificity_component: z.number().nullable().default(null),
    mmr_diversity_penalty: z.number().nullable().default(null),
    final_score: z.number().nullable().default(null),
    rank_after_mmr: z.number().int().gte(1).nullable().default(null),
    // Confluence-only locator (null for repo-knowledge chunks).
    default_scope: z.string().max(64).nullable().default(null),
    // Dropped-chunk-only fields (null on a selected record).
    drop_reason: DropReason.nullable().default(null),
    drop_context: z.string().max(400).nullable().default(null),
    // F-44: per-chunk provenance evidence reference (ADR-0051). Optional for back-compat.
    evidence_ref: z.string().regex(EV_REF_PATTERN).nullable().default(null),
  })
  .strict();
export type RetrievedKnowledgeDecisionV1 = z.infer<typeof RetrievedKnowledgeDecisionV1>;

// Stage3TrackTraceV2 — retrieval_trace/v2.py. Per-track outcome with per-chunk decision detail.
// Extends v1's Stage3TrackTrace (schema_version=2) — the chunk-id arrays are preserved for
// back-compat readers; the detail arrays carry RetrievedKnowledgeDecisionV1 records.
export const Stage3TrackTraceV2 = z
  .object({
    schema_version: z.number().int().default(2),
    selection_basis: z.string().min(1).max(200),
    selected_chunk_ids: z.array(z.string().uuid()).max(200).default([]),
    dropped_chunk_ids: z.array(z.string().uuid()).max(2000).default([]),
    selected_chunks_detail: z.array(RetrievedKnowledgeDecisionV1).max(200).default([]),
    dropped_chunks_detail: z.array(RetrievedKnowledgeDecisionV1).max(2000).default([]),
  })
  .strict();
export type Stage3TrackTraceV2 = z.infer<typeof Stage3TrackTraceV2>;

// Stage3TraceV2 — retrieval_trace/v2.py. Dual-track Stage-3 outcome.
// lambda_mmr is a bare float (default 0.7, [0,1]) — canonical-diff-excluded (see FLOAT NOTE).
export const Stage3TraceV2 = z
  .object({
    schema_version: z.number().int().default(2),
    track_a_default: Stage3TrackTraceV2,
    track_b_non_default: Stage3TrackTraceV2,
    starvation_observed: z.boolean().default(false),
    starvation_tiers: z.array(PriorityTierStr).default([]),
    lambda_mmr: z.number().gte(0).lte(1).default(0.7),
  })
  .strict();
export type Stage3TraceV2 = z.infer<typeof Stage3TraceV2>;

// RetrievalTraceV2 — retrieval_trace/v2.py. Full per-review retrieval trace (schema_version=2).
// Drop-in replacement for v1's outer envelope; only Stage3 was extended.
// captured_at: Annotated[datetime, AfterValidator(_require_tz)] — Pydantic emits the timezone-aware
// datetime as an RFC3339 offset string; the AfterValidator rejects naive (offset-less) datetimes.
// Re-authored as .superRefine() so a naive RFC3339 string (no Z / no ±HH:MM) is rejected on both
// sides; the canonicalizer normalizes the offset form so the instant compares equal.
export const RetrievalTraceV2 = z
  .object({
    schema_version: z.number().int().default(2),
    trace_id: z.string().uuid(),
    review_id: z.string().uuid(),
    pr_id: z.string().uuid(),
    captured_at: z.string().datetime({ offset: true }),
    taxonomy_version: z.number().int().gte(0),
    pipeline_version: z.number().int().gte(1),
    detectors: z.array(DetectorTrace).max(20).default([]),
    effective_labels: z.array(z.string()).max(500).default([]),
    platform_exposed_labels_count: z.number().int().gte(0),
    repo_include_attempts_filtered: z.array(z.string()).max(100).default([]),
    stage1: Stage1Trace,
    stage2: Stage2Trace,
    stage3: Stage3TraceV2,
    token_accounting: TokenAccounting,
  })
  .strict();
export type RetrievalTraceV2 = z.infer<typeof RetrievalTraceV2>;

// PersistRetrievalTraceInputV1 — persist_retrieval_trace/v1.py. Single typed activity input (ADR-0047).
export const PersistRetrievalTraceInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    trace: RetrievalTraceV2,
  })
  .strict();
export type PersistRetrievalTraceInputV1 = z.infer<typeof PersistRetrievalTraceInputV1>;

// PersistRetrievalTraceOutputV1 — persist_retrieval_trace/v1.py. Activity result — persistence outcome.
export const PersistRetrievalTraceOutputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    persisted: z.boolean(),
  })
  .strict();
export type PersistRetrievalTraceOutputV1 = z.infer<typeof PersistRetrievalTraceOutputV1>;
