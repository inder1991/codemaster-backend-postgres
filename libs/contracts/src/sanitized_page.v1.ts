import { z } from "zod";

// Zod port of contracts/confluence/sanitized_page/v1.py (frozen Python). Parity-validated in
// sanitized_page.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - PATTERN_CLASSES (frozenset[str] from codemaster.ingest.confluence.injection_patterns)
//      → PATTERN_CLASSES (ReadonlyArray<string>) — the allow-list the injection_flags validator checks.
//  - _validate_flags  (module-level AfterValidator)  → re-authored as a .superRefine() arm.
//  - _require_tz      (module-level AfterValidator)  → enforced via z.string().datetime({offset:true})
//      (an offset-bearing RFC3339 string is exactly a timezone-aware datetime; a naive datetime
//      lacks the offset and is rejected by both Pydantic's _require_tz and Zod's {offset:true}).
//  - SanitizedPageV1  (ConfigDict extra=forbid, frozen) → .strict() + one .superRefine() (injection_flags).
//
// `schema_version` is a plain Python `int` (default 1), NOT a Literal: z.number().int().default(1)
// so a future schema_version bump is not false-rejected (matching the knowledge_chunks / embed_query
// ports).
//
// FROZENSET: injection_flags is a Python frozenset[str]; model_dump(mode="json") emits a list in
// nondeterministic hash order, so the parity test uses ≤1-element values (order-invariant) for the
// byte-equal canonical compare. The field is REQUIRED (no Python default).
//
// No bare floats, no UUIDs, no Decimal columns — nothing the repo canonicalizer rejects.

// Mirrors codemaster.ingest.confluence.injection_patterns.PATTERN_CLASSES (the frozen module-level
// allow-list the Pydantic _validate_flags AfterValidator checks injection_flags against). Sorted here
// for a stable literal; set membership is order-invariant.
export const PATTERN_CLASSES: ReadonlyArray<string> = [
  "hidden_directive",
  "instruction_negation",
  "jailbreak_phrasing",
  "output_format_hijack",
  "role_override",
  "system_prompt_leak",
] as const;

const PATTERN_CLASS_SET: ReadonlySet<string> = new Set(PATTERN_CLASSES);

// SanitizedPageV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// The _validate_flags AfterValidator is re-authored as the .superRefine() arm below.
export const SanitizedPageV1 = z
  .object({
    // Python: schema_version: int = 1 (plain int default, NOT a Literal — any int accepted).
    schema_version: z.number().int().default(1),
    page_id: z.string().min(1).max(64),
    space_key: z.string().min(1).max(64),
    // Python: version: int = Field(ge=1).
    version: z.number().int().gte(1),
    title: z.string().min(1).max(1024),
    // Python: body: str = Field(max_length=2_000_000). No min_length — empty body permitted.
    body: z.string().max(2_000_000),
    // Python: labels: tuple[str, ...] = Field(default=(), max_length=100).
    labels: z.array(z.string()).max(100).default([]),
    // Python: injection_flags: Annotated[frozenset[str], AfterValidator(_validate_flags)] — REQUIRED.
    // frozenset → z.array (order-invariant payloads in the parity test).
    injection_flags: z.array(z.string()),
    status: z.string(),
    // Python: last_modified_at: Annotated[datetime, AfterValidator(_require_tz)] — must be tz-aware.
    // {offset:true} requires an explicit RFC3339 offset, mirroring the _require_tz tzinfo check.
    last_modified_at: z.string().datetime({ offset: true }),
    // Python: pattern_set_version: int = Field(ge=1).
    pattern_set_version: z.number().int().gte(1),
  })
  .strict()
  // _validate_flags AfterValidator: every injection_flag must be in PATTERN_CLASSES.
  .superRefine((v, ctx) => {
    const unknown = [...new Set(v.injection_flags)].filter((f) => !PATTERN_CLASS_SET.has(f)).sort();
    if (unknown.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["injection_flags"],
        message: `unknown injection_flags: ${JSON.stringify(unknown)}`,
      });
    }
  });
export type SanitizedPageV1 = z.infer<typeof SanitizedPageV1>;
