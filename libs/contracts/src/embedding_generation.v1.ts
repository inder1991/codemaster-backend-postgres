import { z } from "zod";

// Zod port of the frozen Python dataclass `EmbeddingGenerationRow`
// (vendor/codemaster-py/codemaster/embedder/generations_repo.py lines 24-54).
//
// DIVERGENCE — NO pyRef JSON parity: the Python source is a PLAIN
// `@dataclass(frozen=True, slots=True)`, NOT a Pydantic v2 `BaseModel`. It has no
// `model_validate` / `model_dump` JSON round-trip, so there is no canonical
// Python-emitted payload to cross-check. This contract therefore tests the Zod shape
// directly (embedding_generation.v1.contract.test.ts) rather than via the parity harness.
//
// Field mapping (1:1 with the dataclass, field order preserved):
//   generation_id           int                                  → z.number().int()
//   state                   Literal["backfilling","ready",       → z.enum([...])  (the state
//                                   "active","retired"]                machine vocabulary)
//   generation_label        str | None                           → .nullable()
//   generation_reason       str | None                           → .nullable()
//   provider_name           str                                  → z.string()
//   provider_version        str | None                           → .nullable()
//   model_name              str                                  → z.string()
//   embedding_dimension     int                                  → z.number().int()
//   created_from_generation int | None                           → .nullable()
//   chunker_version         str                                  → z.string()
//   preprocessing_version   str                                  → z.string()
//   normalization_version   str                                  → z.string()
//   created_at              datetime                             → z.date()  (the TS repo hands
//                                                                    back a JS Date — the absolute
//                                                                    UTC instant analogue of the
//                                                                    Python tz-aware datetime)
//   created_by_email        str | None                           → .nullable()
//   backfill_started_at     datetime | None                      → z.date().nullable()
//   backfill_completed_at   datetime | None                      → z.date().nullable()
//   validation_started_at   datetime | None                      → z.date().nullable()
//   validation_completed_at datetime | None                      → z.date().nullable()
//   validation_report_json  str | None                           → .nullable()  (the repo re-encodes
//                                                                    asyncpg's parsed JSONB back to a
//                                                                    canonical JSON string, mirroring
//                                                                    the Python _row_to_dataclass)
//   validation_passed       bool | None                          → z.boolean().nullable()
//   activated_at            datetime | None                      → z.date().nullable()
//   retired_at              datetime | None                      → z.date().nullable()
//   retire_reason           Literal["cancelled","demoted",       → z.enum([...]).nullable()
//                                   "manual_retire"] | None
//   gc_started_at           datetime | None                      → z.date().nullable()
//   gc_completed_at         datetime | None                      → z.date().nullable()
//   total_chunks            int                                  → z.number().int()
//   chunks_backfilled       int                                  → z.number().int()
//   chunks_failed           int                                  → z.number().int()
//   last_error              str | None                           → .nullable()

/** The state-machine vocabulary (1:1 with the Python `Literal[...]` on `state`). */
export const EmbeddingGenerationState = z.enum(["backfilling", "ready", "active", "retired"]);
export type EmbeddingGenerationState = z.infer<typeof EmbeddingGenerationState>;

/** The retire-reason vocabulary (1:1 with the Python `Literal[...]` on `retire_reason`; spec v4 §5.0). */
export const RetireReason = z.enum(["cancelled", "demoted", "manual_retire"]);
export type RetireReason = z.infer<typeof RetireReason>;

/**
 * One row of `core.embedding_generations` (1:1 with the frozen Python `EmbeddingGenerationRow`).
 *
 * `.strict()` mirrors the frozen dataclass's fixed field set (`slots=True` forbids extra attrs at
 * the Python layer; `.strict()` is the Zod analogue — an unexpected key fails parse).
 */
export const EmbeddingGenerationRowV1 = z
  .object({
    generation_id: z.number().int(),
    state: EmbeddingGenerationState,
    generation_label: z.string().nullable(),
    generation_reason: z.string().nullable(),
    provider_name: z.string(),
    provider_version: z.string().nullable(),
    model_name: z.string(),
    embedding_dimension: z.number().int(),
    created_from_generation: z.number().int().nullable(),
    chunker_version: z.string(),
    preprocessing_version: z.string(),
    normalization_version: z.string(),
    created_at: z.date(),
    created_by_email: z.string().nullable(),
    backfill_started_at: z.date().nullable(),
    backfill_completed_at: z.date().nullable(),
    validation_started_at: z.date().nullable(),
    validation_completed_at: z.date().nullable(),
    validation_report_json: z.string().nullable(),
    validation_passed: z.boolean().nullable(),
    activated_at: z.date().nullable(),
    retired_at: z.date().nullable(),
    retire_reason: RetireReason.nullable(),
    gc_started_at: z.date().nullable(),
    gc_completed_at: z.date().nullable(),
    total_chunks: z.number().int(),
    chunks_backfilled: z.number().int(),
    chunks_failed: z.number().int(),
    last_error: z.string().nullable(),
  })
  .strict();
export type EmbeddingGenerationRowV1 = z.infer<typeof EmbeddingGenerationRowV1>;
