import { z } from "zod";

import { ArbitrationIntentV1 } from "./arbitration_intent.v1.js";
import { ReviewFindingV1 } from "./review_findings.v1.js";

// Zod port of contracts/review_chunk_response/v1.py::ReviewChunkResponseV1 plus its
// sibling module contracts/review_chunk_response/sanitization_event_v1.py::OutputSafetySanitizationEventV1.
// Parity-validated in review_chunk_response.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - ORIGINAL_TEXT_MAX_BYTES (sanitization_event_v1 module-level Final[int]) → ORIGINAL_TEXT_MAX_BYTES.
//  - OutputSafetySanitizationEventV1 (ConfigDict extra=forbid, frozen) → .strict().
//      sanitization_event_v1 has NO standalone Zod sibling, so it is ported inline here (its only
//      consumer is ReviewChunkResponseV1.sanitization_event). Both are re-exported.
//  - ReviewChunkResponseV1 (ConfigDict extra=forbid, frozen) → .strict().
//      findings / arbitration_intents reference the sibling Zod schemas (ReviewFindingV1,
//      ArbitrationIntentV1) — IMPORTED above, not redefined.
//
// schema_version GOTCHA: ReviewChunkResponseV1.schema_version is Python `Literal[1]` → z.literal(1),
// whereas OutputSafetySanitizationEventV1.schema_version is a bare Python `int = 1` →
// z.number().int().default(1) (no literal pin — the Python contract permits any int there).

// sanitization_event_v1: Final[int] = 64 * 1024. The original_text field caps at this + 32 (truncation
// marker headroom), mirroring `Field(max_length=ORIGINAL_TEXT_MAX_BYTES + 32)`.
export const ORIGINAL_TEXT_MAX_BYTES = 64 * 1024;

// OutputSafetySanitizationEventV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const OutputSafetySanitizationEventV1 = z
  .object({
    // Python `int = 1` (NOT Literal): any int accepted, default 1.
    schema_version: z.number().int().default(1),
    // Pydantic uuid.UUID: validates UUID syntax, model_dump emits lowercase canonical form.
    installation_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    request_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    original_text: z.string().max(ORIGINAL_TEXT_MAX_BYTES + 32),
    redacted_text: z.string(),
    spans_redacted: z.number().int().gte(1),
    detector_kinds: z.array(z.string()).min(1),
    stage: z.string().min(1).max(64),
  })
  .strict();
export type OutputSafetySanitizationEventV1 = z.infer<typeof OutputSafetySanitizationEventV1>;

// ReviewChunkResponseV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// schema_version is Python `Literal[1]` → z.literal(1).default(1).
// findings / arbitration_intents are `tuple[..., ...] = ()` → z.array(...).default([]).
// sanitization_event is `OutputSafetySanitizationEventV1 | None = None` → .nullable().default(null).
export const ReviewChunkResponseV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    findings: z.array(ReviewFindingV1).default([]),
    arbitration_intents: z.array(ArbitrationIntentV1).default([]),
    sanitization_event: OutputSafetySanitizationEventV1.nullable().default(null),
  })
  .strict();
export type ReviewChunkResponseV1 = z.infer<typeof ReviewChunkResponseV1>;
