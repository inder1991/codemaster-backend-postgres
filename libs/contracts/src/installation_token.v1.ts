import { z } from "zod";

// Zod port of the `InstallationTokenV1` Pydantic model defined INLINE in the frozen Python module
// `codemaster/integrations/github/installation_token.py` (Sprint 4 / S4.1.1). It is NOT in
// `contracts/` on the Python side, but it IS a cross-time data envelope (the cached installation
// token), so we port it as a first-class contract here. Parity-validated in
// installation_token.v1.parity.test.ts.
//
// Source members ported (every field on the Python model):
//   - model_config = ConfigDict(extra="forbid", frozen=True)  → .strict()  (frozen is a Python-only
//     immutability flag with no Zod analogue; the type is `readonly` via the inferred type below).
//   - schema_version: int = 1                                 → z.number().int().default(1)
//                                                               (PLAIN int default, NOT Literal[1]).
//   - token: str = Field(min_length=1) + @field_validator("token") _no_whitespace_only
//                                                               → z.string().min(1) + .refine(non-whitespace).
//     The Python validator rejects a whitespace-only token (`not v.strip()`); min_length=1 rejects the
//     empty string. Both are mirrored: .min(1) is the empty-string guard, the .refine is the
//     whitespace-only guard (so "   " is rejected as on the Python side).
//   - expires_at: datetime                                    → z.string().datetime({ offset: true,
//     local: true }). This is a PLAIN `datetime` field (no `_require_tz` AfterValidator), so the Python
//     side ACCEPTS a naive (offset-less) value too — `{ local: true }` matches that permissiveness.
//     Pydantic dumps the value via isoformat (a `Z`-bearing aware value dumps as `...Z`); the parity
//     canonicalizer normalizes both `Z` and `+00:00` to `.ffffff+00:00` so the instant compares equal.

// InstallationTokenV1 — the cached installation token envelope.
export const InstallationTokenV1 = z
  .object({
    schema_version: z.number().int().default(1),
    // min(1) is the empty-string guard (Field(min_length=1)); the refine is the whitespace-only guard
    // (the Python @field_validator's `not v.strip()` rejection).
    token: z
      .string()
      .min(1)
      .refine((v) => v.trim().length > 0, { message: "token must be non-empty" }),
    expires_at: z.string().datetime({ offset: true, local: true }),
  })
  .strict();
export type InstallationTokenV1 = z.infer<typeof InstallationTokenV1>;
