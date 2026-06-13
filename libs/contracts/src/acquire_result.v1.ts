import { z } from "zod";

// Zod port of the `AcquireResult` Pydantic contract (codemaster.concurrency.pr_mutex).
// Parity-validated in acquire_result.v1.parity.test.ts.
//
// Source model / fields ported (every public one):
//  - AcquireResult (ConfigDict extra="forbid", frozen=True) → .strict().
//    Fields:
//      - schema_version: int = 1                  → z.number().int().default(1)
//        (a PLAIN int with a default, NOT z.literal(1) — z.literal would wrongly reject a future
//         schema_version bump, mirroring the dropped_classification / posted_review templates).
//      - acquired: bool                           → z.boolean() (REQUIRED, no default).
//      - mutex_id: uuid.UUID | None = None        → z.string().uuid().nullable().default(null);
//        Pydantic model_dump(mode="json") emits a UUID as its canonical lowercase string form.
//      - holder_workflow_id: str | None = None    → z.string().nullable().default(null).
//
// No float fields, no enum, no cross-contract dependency, no @model_validator — a flat result shape.

// AcquireResult — ConfigDict(extra="forbid", frozen=True) → .strict().
export const AcquireResultV1 = z
  .object({
    schema_version: z.number().int().default(1),
    acquired: z.boolean(),
    mutex_id: z.string().uuid().nullable().default(null),
    holder_workflow_id: z.string().nullable().default(null),
  })
  .strict();
export type AcquireResultV1 = z.infer<typeof AcquireResultV1>;
