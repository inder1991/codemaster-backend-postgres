import { z } from "zod";

// Zod port of contracts/secret_detection/v1.py::SecretFindingV1.
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not
// wire). Parity-validated in secret_detection.v1.parity.test.ts.
//
// `snippet_redacted` shows enough of the value (first/last 4 chars) for a human to recognize which
// credential leaked, without exposing the full secret to logs / Langfuse traces.
//
// NOTE on `confidence`: the Python contract types it as a bare `float`. Pydantic
// `model_dump(mode="json")` preserves the float type, so it serializes as e.g. `0.99` while a JS
// number serializes its shortest form — for whole values `1.0` (Python) vs `1` (JS). These forms
// are not byte-equal in canonical JSON, so `confidence` must be compared structurally (not
// byte-for-byte) when round-tripping between Python and JS.

export const SecretFindingV1 = z
  .object({
    schema_version: z.number().int().default(1),
    kind: z.string().min(1),
    snippet_redacted: z.string().min(1),
    start_offset: z.number().int().gte(0),
    end_offset: z.number().int().gte(0),
    confidence: z.number().gte(0).lte(1),
  })
  .strict();

export type SecretFindingV1 = z.infer<typeof SecretFindingV1>;
