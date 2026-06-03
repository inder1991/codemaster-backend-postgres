import { z } from "zod";

// Zod port of contracts/knowledge_chunks/v1.py (frozen Python). Parity-validated in
// knowledge_chunks.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - KnowledgeDocKind     (Python StrEnum, .value)               → z.enum on the .value strings
//  - KnowledgeDocStatus   (Python StrEnum, .value)               → z.enum on the .value strings
//  - RetrievalStage       (module-level Python Literal)          → z.enum
//  - KnowledgeChunkV1     (ConfigDict extra=forbid, frozen)      → .strict()
//  - KnowledgeQueryV1     (ConfigDict extra=forbid, frozen)      → .strict()
//  - ScoredKnowledgeChunkV1 (ConfigDict extra=forbid, frozen)    → .strict()
//  - RetrievedKnowledgeV1 (ConfigDict extra=forbid, frozen)      → .strict()
//
// `schema_version` is a plain `int` (default 2 on the chunk/query, 1 on scored/retrieved), NOT a
// literal: z.number().int().default(N) so a future schema_version bump is not false-rejected
// (matching the embed_query / aggregated_findings ports).
//
// BARE-FLOAT COLUMNS (cannot byte-round-trip through the repo canonicalizer, which REJECTS bare
// floats — test/parity/canonical.ts):
//  - KnowledgeChunkV1.age_days                  : float (default 0.0)
//  - KnowledgeQueryV1.default_pool_token_reservation_pct : float (default 0.15)
//  - KnowledgeQueryV1.query_vector_override     : tuple[float, ...] | None
//  - ScoredKnowledgeChunkV1.score               : float (required)
// The parity test strips these (incl. nested) before the canonical diff and asserts them
// structurally + range-rejects them separately (see knowledge_chunks.v1.parity.test.ts).
//
// FROZENSET: KnowledgeQueryV1.effective_labels is a Python frozenset[str]; model_dump(mode="json")
// emits a list in nondeterministic hash order, so the parity test uses ≤1-element values (order-
// invariant) for byte-equal compare.

// Python: KnowledgeDocKind(StrEnum) — model_dump(mode="json") emits the .value strings.
export const KnowledgeDocKind = z.enum(["adr", "rfc", "architecture", "runbook", "other"]);
export type KnowledgeDocKind = z.infer<typeof KnowledgeDocKind>;

// Python: KnowledgeDocStatus(StrEnum) — model_dump(mode="json") emits the .value strings.
export const KnowledgeDocStatus = z.enum(["active", "deprecated", "superseded", "draft"]);
export type KnowledgeDocStatus = z.infer<typeof KnowledgeDocStatus>;

// Python: RetrievalStage = Literal["bm25", "ann", "rrf", "rerank"].
export const RetrievalStage = z.enum(["bm25", "ann", "rrf", "rerank"]);
export type RetrievalStage = z.infer<typeof RetrievalStage>;

// Python: source: Literal["repo_knowledge", "confluence"].
export const KnowledgeSource = z.enum(["repo_knowledge", "confluence"]);
export type KnowledgeSource = z.infer<typeof KnowledgeSource>;

// KnowledgeChunkV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const KnowledgeChunkV1 = z
  .object({
    // Python: schema_version: int = 2 (plain int default, NOT a Literal — any int accepted).
    schema_version: z.number().int().default(2),
    chunk_id: z.string().uuid(),
    installation_id: z.string().uuid(),
    repo_id: z.string().uuid(),
    relative_path: z.string().min(1).max(500),
    chunk_index: z.number().int().gte(0),
    // tuple[str, ...] = default_factory=tuple, max_length=3.
    heading_path: z.array(z.string()).max(3).default([]),
    body: z.string().min(1).max(6000),
    doc_kind: KnowledgeDocKind, // required (no default)
    doc_status: KnowledgeDocStatus.default("active"),
    source: KnowledgeSource.default("repo_knowledge"),
    // Confluence-only locator fields (None when source='repo_knowledge').
    space_key: z.string().nullable().default(null),
    page_id: z.string().nullable().default(null),
    page_version: z.number().int().nullable().default(null),
    // tuple[str, ...] = Field(default=(), max_length=100).
    labels: z.array(z.string()).max(100).default([]),
    // int = Field(default=0, ge=0).
    match_specificity_score: z.number().int().gte(0).default(0),
    // float = Field(default=0.0, ge=0.0). BARE FLOAT — stripped in the parity canonical diff.
    age_days: z.number().gte(0).default(0),
  })
  .strict();
export type KnowledgeChunkV1 = z.infer<typeof KnowledgeChunkV1>;

// KnowledgeQueryV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const KnowledgeQueryV1 = z
  .object({
    // Python: schema_version: int = 2.
    schema_version: z.number().int().default(2),
    query: z.string().min(1).max(8000),
    installation_id: z.string().uuid(),
    repo_id: z.string().uuid(),
    top_k: z.number().int().gte(1).lte(100).default(10),
    // tuple[float, ...] | None = None. BARE-FLOAT-bearing — stripped in the parity canonical diff.
    query_vector_override: z.array(z.number()).nullable().default(null),
    include_confluence: z.boolean().default(false),
    // frozenset[str] = default_factory=frozenset → z.array(...).default([]) (order-invariant payloads
    // in the parity test). max_length is not set on the Python field, so no .max() here.
    effective_labels: z.array(z.string()).default([]),
    // float = Field(default=0.15, ge=0.0, le=1.0). BARE FLOAT — stripped in the parity canonical diff.
    default_pool_token_reservation_pct: z.number().gte(0).lte(1).default(0.15),
  })
  .strict();
export type KnowledgeQueryV1 = z.infer<typeof KnowledgeQueryV1>;

// ScoredKnowledgeChunkV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const ScoredKnowledgeChunkV1 = z
  .object({
    // Python: schema_version: int = 1.
    schema_version: z.number().int().default(1),
    chunk: KnowledgeChunkV1,
    // float — required, unbounded. BARE FLOAT — stripped in the parity canonical diff.
    score: z.number(),
    stage: RetrievalStage,
  })
  .strict();
export type ScoredKnowledgeChunkV1 = z.infer<typeof ScoredKnowledgeChunkV1>;

// RetrievedKnowledgeV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const RetrievedKnowledgeV1 = z
  .object({
    // Python: schema_version: int = 1.
    schema_version: z.number().int().default(1),
    // tuple[ScoredKnowledgeChunkV1, ...] = default_factory=tuple.
    items: z.array(ScoredKnowledgeChunkV1).default([]),
    degraded: z.boolean().default(false),
    degradation_reason: z.string().max(200).default(""),
    // tuple[str, ...] = Field(default=(), max_length=10).
    starvation_tiers: z.array(z.string()).max(10).default([]),
    // dict[str, int] = default_factory=dict. JSON-safe str keys; both canonicalizers sort keys.
    source_counts: z.record(z.string(), z.number().int()).default({}),
  })
  .strict();
export type RetrievedKnowledgeV1 = z.infer<typeof RetrievedKnowledgeV1>;
