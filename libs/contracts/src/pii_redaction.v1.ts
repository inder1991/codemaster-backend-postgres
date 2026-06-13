import { z } from "zod";

// Zod port of contracts/pii_redaction/v1.py::PiiFindingV1.
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not
// wire). Parity-validated in pii_redaction.v1.parity.test.ts.
//
// `replacement` is the literal placeholder that overwrote the match in the rewritten text (e.g.
// `[REDACTED:email]`); `start_offset` / `end_offset` point at the match inside the *original*
// (pre-redaction) text so callers can correlate audits without reprocessing.
//
// NOTE on `confidence`: the Python contract types it as a bare `float`. Pydantic
// `model_dump(mode="json")` preserves the float type, so it serializes as e.g. `0.95` while a JS
// number serializes its shortest form — for whole values `1.0` (Python) vs `1` (JS). These forms
// are not byte-equal in canonical JSON, so `confidence` must be compared structurally (not
// byte-for-byte) when round-tripping between Python and JS.

export const PiiFindingV1 = z
  .object({
    schema_version: z.number().int().default(1),
    kind: z.string().min(1),
    replacement: z.string().min(1),
    start_offset: z.number().int().gte(0),
    end_offset: z.number().int().gte(0),
    confidence: z.number().gte(0).lte(1),
  })
  .strict();

export type PiiFindingV1 = z.infer<typeof PiiFindingV1>;
