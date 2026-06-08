import { z } from "zod";

// Zod port of the frozen Python dataclass `EmbedderRuntimeStateRow`
// (vendor/codemaster-py/codemaster/embedder/runtime_state_repo.py lines 20-29).
//
// DIVERGENCE — NO pyRef JSON parity: the Python source is a PLAIN
// `@dataclass(frozen=True, slots=True)`, NOT a Pydantic v2 `BaseModel`, so there is no
// `model_validate` / `model_dump` JSON round-trip to cross-check. This contract tests the Zod
// shape directly (embedder_runtime_state.v1.contract.test.ts).
//
// Field mapping (1:1 with the dataclass, field order preserved):
//   active_generation   int                                   → z.number().int()
//   active_model_name   str                                   → z.string()
//   pending_generation  int | None                            → z.number().int().nullable()
//   pending_model_name  str | None                            → z.string().nullable()
//   config_version      int                                   → z.number().int()  (monotonic; bumped
//                                                                on every write — workers poll it)
//   retrieval_mode      Literal["fallback","generation_only"] → z.enum([...])
//   updated_at          datetime                              → z.date()
//   updated_by_email    str | None                            → z.string().nullable()
//
// The (pending_generation, pending_model_name) pair is biconditional at the DB layer
// (embedder_runtime_state_pending_pair_biconditional CHECK): both NULL or both NOT NULL. The Zod
// shape does not (and cannot, per-field) encode the cross-field invariant — the DB CHECK is the
// structural backstop, asserted directly in the repo integration test.

/** The retrieval-mode vocabulary (1:1 with the Python `Literal[...]`; spec v4 §8). */
export const RetrievalMode = z.enum(["fallback", "generation_only"]);
export type RetrievalMode = z.infer<typeof RetrievalMode>;

/**
 * The singleton `core.embedder_runtime_state` row (1:1 with the frozen Python
 * `EmbedderRuntimeStateRow`).
 *
 * `.strict()` mirrors the frozen dataclass's fixed field set (`slots=True`).
 */
export const EmbedderRuntimeStateRowV1 = z
  .object({
    active_generation: z.number().int(),
    active_model_name: z.string(),
    pending_generation: z.number().int().nullable(),
    pending_model_name: z.string().nullable(),
    config_version: z.number().int(),
    retrieval_mode: RetrievalMode,
    updated_at: z.date(),
    updated_by_email: z.string().nullable(),
  })
  .strict();
export type EmbedderRuntimeStateRowV1 = z.infer<typeof EmbedderRuntimeStateRowV1>;
