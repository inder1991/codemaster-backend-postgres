import { z } from "zod";

// Zod port of contracts/file_classification/v1.py::FileClassificationV1.
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// `schema_version: int = 1` is a plain int field with default 1 (NOT a Literal in Python — any int is
// accepted), so it maps to z.number().int().default(1), not z.literal(1).
// `language: str | None = None` dumps as null when omitted → .nullable().default(null) mirrors that.
// Parity-validated in file_classification.v1.parity.test.ts.
export const FileClassificationV1 = z
  .object({
    schema_version: z.number().int().default(1),
    path: z.string().min(1),
    byte_size: z.number().int().gte(0),
    magika_label: z.string().min(1),
    language: z.string().nullable().default(null),
    is_binary: z.boolean(),
    is_generated: z.boolean(),
  })
  .strict();

export type FileClassificationV1 = z.infer<typeof FileClassificationV1>;
