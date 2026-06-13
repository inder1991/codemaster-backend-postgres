import { z } from "zod";

// Zod port of contracts/retrieval/retrieval_trace/v1.py. Parity-validated in
// retrieval_trace.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - PriorityTierStr (Python Literal[...])            → z.enum
//  - DetectorTrace   (ConfigDict extra=forbid, frozen) → .strict()
//  - Stage1Trace     (ConfigDict extra=forbid, frozen) → .strict()
//  - Stage2Trace     (ConfigDict extra=forbid, frozen) → .strict()
//  - Stage3TrackTrace(ConfigDict extra=forbid, frozen) → .strict()
//  - Stage3Trace     (ConfigDict extra=forbid, frozen) → .strict()  [carries the bare-float lambda_mmr]
//  - TokenAccounting (ConfigDict extra=forbid, frozen) → .strict()
//  - RetrievalTraceV1(ConfigDict extra=forbid, frozen) → .strict() + _require_tz captured_at validator
//
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// The `__contract_internal__ = True` class attribute is not a model field, so it never serializes —
// nothing to port on the wire.
//
// NOTE on `lambda_mmr` (Stage3Trace) — typed as a bare Python `float` (default 0.7, ge=0.0, le=1.0).
// Pydantic `model_dump(mode="json")` preserves the float type (e.g. `0.7`, or `1.0` for an int input),
// whereas a JS number `1` serializes as `1`. The repo canonicalizer (test/parity/canonical.ts) REJECTS
// bare floats, so the parity test strips `lambda_mmr` from the canonical diff and asserts it
// structurally (Zod keeps the [0,1] bound; Python emits the float form). See the parity test.
//
// UUID fields (trace_id / review_id / pr_id / selected_chunk_ids / dropped_chunk_ids) are emitted by
// Pydantic model_dump(mode="json") as lowercase RFC4122 strings; on the wire they are strings, so the
// Zod port validates the string form via z.string().uuid(). Parity payloads use canonical-lowercase
// UUIDs (Pydantic lowercases input; Zod .uuid() does not — keep inputs canonical to avoid a spurious
// diff).
//
// `captured_at` is Annotated[datetime, AfterValidator(_require_tz)] — Pydantic raises on a naive
// (tz-unaware) datetime. z.string().datetime({ offset: true }) requires an explicit offset, so a
// naive RFC3339 string is rejected on BOTH sides.

// PriorityTierStr = Literal["SECURITY_POLICY", "REPO_ADR", "FRAMEWORK_GUIDANCE", "LANG_GUIDANCE", "DEFAULT_ONLY"]
export const PriorityTierStr = z.enum([
  "SECURITY_POLICY",
  "REPO_ADR",
  "FRAMEWORK_GUIDANCE",
  "LANG_GUIDANCE",
  "DEFAULT_ONLY",
]);
export type PriorityTierStr = z.infer<typeof PriorityTierStr>;

// DetectorTrace — one detector's contribution to the union of effective_labels.
export const DetectorTrace = z
  .object({
    schema_version: z.number().int().default(1),
    name: z.string().min(1).max(64),
    version: z.number().int().gte(1),
    emitted: z.array(z.string()).max(200).default([]),
  })
  .strict();
export type DetectorTrace = z.infer<typeof DetectorTrace>;

// Stage1Trace — per-label filter + cap funnel stats.
export const Stage1Trace = z
  .object({
    schema_version: z.number().int().default(1),
    candidates_in: z.number().int().gte(0),
    candidates_out: z.number().int().gte(0),
    per_label_cap_applied: z.boolean(),
  })
  .strict();
export type Stage1Trace = z.infer<typeof Stage1Trace>;

// Stage2Trace — per-tier preservation quota stats. per_tier_quotas: dict[str, int] (required).
export const Stage2Trace = z
  .object({
    schema_version: z.number().int().default(1),
    per_tier_quotas: z.record(z.string(), z.number().int()),
    tier_pool_size: z.number().int().gte(0),
  })
  .strict();
export type Stage2Trace = z.infer<typeof Stage2Trace>;

// Stage3TrackTrace — per-track (default or non-default) outcome.
export const Stage3TrackTrace = z
  .object({
    schema_version: z.number().int().default(1),
    selection_basis: z.string().min(1).max(200),
    selected_chunk_ids: z.array(z.string().uuid()).max(200).default([]),
    dropped_chunk_ids: z.array(z.string().uuid()).max(2000).default([]),
  })
  .strict();
export type Stage3TrackTrace = z.infer<typeof Stage3TrackTrace>;

// Stage3Trace — dual-track rerank + floor reservation outcome.
// lambda_mmr is a bare Python float (default 0.7, ge=0.0, le=1.0) — see the header note on the
// canonicalizer + parity-test stripping of the float column.
export const Stage3Trace = z
  .object({
    schema_version: z.number().int().default(1),
    track_a_default: Stage3TrackTrace,
    track_b_non_default: Stage3TrackTrace,
    starvation_observed: z.boolean().default(false),
    starvation_tiers: z.array(PriorityTierStr).default([]),
    lambda_mmr: z.number().gte(0).lte(1).default(0.7),
  })
  .strict();
export type Stage3Trace = z.infer<typeof Stage3Trace>;

// TokenAccounting — token-budget allocation outcome.
// reserved_floors_consumed: dict[str, int] (default_factory=dict) → z.record(...).default({}).
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

// RetrievalTraceV1 — full per-review retrieval trace persisted to core.retrieval_traces.trace (JSONB).
// captured_at: Annotated[datetime, AfterValidator(_require_tz)] → require an explicit offset.
export const RetrievalTraceV1 = z
  .object({
    schema_version: z.number().int().default(1),
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
    stage3: Stage3Trace,
    token_accounting: TokenAccounting,
  })
  .strict();
export type RetrievalTraceV1 = z.infer<typeof RetrievalTraceV1>;
