import { z } from "zod";

// Zod port of contracts/review_findings/v1.py. Parity-validated in
// review_findings.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - Severity      (Python Literal)        → z.enum
//  - Category      (Python Literal)        → z.enum
//  - CitationKind  (Python Literal)        → z.enum
//  - FindingScope  (Python Enum, .value)   → z.enum on the .value strings
//  - _EV_ID_PATTERN (module-level regex)   → EV_ID_PATTERN
//  - CitationV1     (ConfigDict extra=forbid, frozen) → .strict()
//  - ReviewFindingV1(ConfigDict extra=forbid, frozen) → .strict() + two @model_validator(mode="after")
//    re-authored as .superRefine(): _check_line_range + _check_evidence_refs_pattern.
//
// NOTE on `confidence`: the Python contract types it as a bare `float`. Pydantic
// `model_dump(mode="json")` preserves the float type, so it serializes as e.g. `1.0`,
// whereas a JS number `1` serializes as `1`. These forms are not byte-equal in canonical JSON,
// so `confidence` must be compared structurally (not byte-for-byte) when round-tripping between
// Python and JS (Python-side float-serialization quirk, documented in StructuredOutput notes).

// Module-level compiled pattern in Python (`_EV_ID_PATTERN`); mirrors the LLM tool-schema
// `evidence_refs` regex (ADR-0051).
export const EV_ID_PATTERN = /^ev_[0-9a-f]{16}$/;

// Severity = Literal["nit", "suggestion", "issue", "blocker"]
export const Severity = z.enum(["nit", "suggestion", "issue", "blocker"]);
export type Severity = z.infer<typeof Severity>;

// Category = Literal[...]
export const Category = z.enum([
  "bug",
  "security",
  "performance",
  "style",
  "test",
  "docs",
  "config",
  "context_breaks_consumer",
  "other",
]);
export type Category = z.infer<typeof Category>;

// CitationKind = Literal["repo_path", "knowledge_chunk", "linter_rule", "policy_rule"]
export const CitationKind = z.enum(["repo_path", "knowledge_chunk", "linter_rule", "policy_rule"]);
export type CitationKind = z.infer<typeof CitationKind>;

// FindingScope(Enum) — model_dump(mode="json") emits the .value strings.
export const FindingScope = z.enum(["chunk_observed", "cross_chunk", "pr_global"]);
export type FindingScope = z.infer<typeof FindingScope>;

// CitationV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const CitationV1 = z
  .object({
    kind: CitationKind,
    locator: z.string().min(1).max(500),
    excerpt: z.string().max(300).nullable().default(null),
  })
  .strict();
export type CitationV1 = z.infer<typeof CitationV1>;

// ReviewFindingV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// Two @model_validator(mode="after") re-authored below as .superRefine().
export const ReviewFindingV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    file: z.string().min(1),
    start_line: z.number().int().gte(1),
    end_line: z.number().int().gte(1),
    severity: Severity,
    category: Category,
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(2000),
    suggestion: z.string().nullable().default(null),
    // Python: confidence: float = Field(ge=0.0, le=1.0). Bare float — required.
    confidence: z.number().gte(0).lte(1),
    // tuple[CitationV1, ...] = default_factory=tuple → z.array(...).default([]).
    sources: z.array(CitationV1).default([]),
    // FindingScope default CHUNK_OBSERVED.
    scope: FindingScope.default("chunk_observed"),
    // tuple[str, ...] = default_factory=tuple, max_length=20.
    evidence_refs: z.array(z.string()).max(20).default([]),
  })
  .strict()
  // @model_validator(mode="after") _check_line_range: end_line >= start_line.
  .superRefine((v, ctx) => {
    if (v.end_line < v.start_line) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end_line"],
        message: `end_line (${v.end_line}) must be >= start_line (${v.start_line})`,
      });
    }
    // @model_validator(mode="after") _check_evidence_refs_pattern: each ref ~ ^ev_[0-9a-f]{16}$.
    v.evidence_refs.forEach((ref, i) => {
      if (!EV_ID_PATTERN.test(ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidence_refs", i],
          message: `evidence_refs[${i}] = ${JSON.stringify(ref)} does not match ^ev_[0-9a-f]{16}$ (orchestration-issued ev_id shape). See ADR-0051 for the contract.`,
        });
      }
    });
  });
export type ReviewFindingV1 = z.infer<typeof ReviewFindingV1>;
