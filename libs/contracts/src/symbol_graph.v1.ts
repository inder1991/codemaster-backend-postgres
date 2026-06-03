import { z } from "zod";

// Zod port of contracts/symbol_graph/v1.py (frozen Python — Sprint 11 S11.1.3 + S11.2.1 + S11.3.1).
// Parity-validated in symbol_graph.v1.parity.test.ts.
//
// Source models / enums ported (every public one):
//  - SymbolLanguage     (Python Literal)                 → z.enum
//  - SymbolKind         (Python Literal, imported from   → z.enum
//                        codemaster.symbols.extractor_port)
//  - ReferenceConfidence(Python Literal)                 → z.enum
//  - ReferenceKind      (Python Literal)                 → z.enum
//  - ChangeKind         (Python Literal)                 → z.enum
//  - RefreshSymbolGraphResultV1 (ConfigDict extra=forbid, frozen) → .strict()
//  - RepoSymbolV1               (ConfigDict extra=forbid, frozen) → .strict() + @model_validator
//                               (mode="after") _check_line_range → .superRefine()
//  - SymbolReferenceV1          (ConfigDict extra=forbid, frozen) → .strict()
//  - RemovedOrChangedSymbolV1   (ConfigDict extra=forbid, frozen) → .strict()
//  - ConsumerHitV1              (ConfigDict extra=forbid, frozen) → .strict()
//  - RetrievedConsumersV1       (ConfigDict extra=forbid, frozen) → .strict(); nests
//                               RemovedOrChangedSymbolV1 (target) + ConsumerHitV1 (hits tuple)
//
// Notes:
//  - `schema_version: int = 1` is a plain int default (NOT a Literal), so any int is accepted.
//    Mirror with z.number().int().default(1) — z.literal(1) would wrongly reject schema_version=2.
//  - uuid.UUID fields accept a UUID string and Pydantic model_dump(mode="json") emits the canonical
//    lowercase RFC4122 string; the Zod port validates the string form. Keep parity payloads lowercase.
//  - `= None` defaults → .nullable().default(null) (Pydantic dumps the absent field as explicit null,
//    so the Zod default must inject null too).
//  - No bare-float fields here, so canonical JSON byte-matches without any column-stripping.

// SymbolLanguage = Literal["typescript", "javascript", "python"]
export const SymbolLanguage = z.enum(["typescript", "javascript", "python"]);
export type SymbolLanguage = z.infer<typeof SymbolLanguage>;

// SymbolKind = Literal[...] (Python: codemaster.symbols.extractor_port.SymbolKind)
export const SymbolKind = z.enum([
  "function",
  "class",
  "method",
  "type_alias",
  "interface",
  "enum",
  "constant",
  "default_export",
]);
export type SymbolKind = z.infer<typeof SymbolKind>;

// ReferenceConfidence = Literal["high", "medium", "low"]
export const ReferenceConfidence = z.enum(["high", "medium", "low"]);
export type ReferenceConfidence = z.infer<typeof ReferenceConfidence>;

// ReferenceKind = Literal["import_match", "call_shape_match", "comment_mention"]
export const ReferenceKind = z.enum(["import_match", "call_shape_match", "comment_mention"]);
export type ReferenceKind = z.infer<typeof ReferenceKind>;

// ChangeKind = Literal["removed", "signature_changed"]
export const ChangeKind = z.enum(["removed", "signature_changed"]);
export type ChangeKind = z.infer<typeof ChangeKind>;

// RefreshSymbolGraphResultV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const RefreshSymbolGraphResultV1 = z
  .object({
    schema_version: z.number().int().default(1),
    files_scanned: z.number().int().gte(0),
    symbols_extracted: z.number().int().gte(0),
    upserted: z.number().int().gte(0),
    skipped_unchanged: z.number().int().gte(0),
    deleted_orphans: z.number().int().gte(0),
    extractor_failures: z.number().int().gte(0),
  })
  .strict();
export type RefreshSymbolGraphResultV1 = z.infer<typeof RefreshSymbolGraphResultV1>;

// RepoSymbolV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// @model_validator(mode="after") _check_line_range re-authored below as .superRefine().
export const RepoSymbolV1 = z
  .object({
    schema_version: z.number().int().default(1),
    symbol_id: z.string().uuid(),
    repo_id: z.string().uuid(),
    language: SymbolLanguage,
    kind: SymbolKind,
    qualified_name: z.string().min(1).max(500),
    is_public: z.boolean(),
    relative_path: z.string().min(1).max(500),
    start_line: z.number().int().gte(1),
    end_line: z.number().int().gte(1),
    signature: z.string().max(500),
    docstring: z.string().max(1000).nullable().default(null),
    content_sha256: z.string().min(64).max(64),
  })
  .strict()
  // @model_validator(mode="after") _check_line_range: end_line must be >= start_line.
  .superRefine((val, ctx) => {
    if (val.end_line < val.start_line) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `end_line (${val.end_line}) must be >= start_line (${val.start_line})`,
        path: ["end_line"],
      });
    }
  });
export type RepoSymbolV1 = z.infer<typeof RepoSymbolV1>;

// SymbolReferenceV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const SymbolReferenceV1 = z
  .object({
    schema_version: z.number().int().default(1),
    reference_id: z.string().uuid(),
    target_symbol_id: z.string().uuid(),
    consumer_repo_id: z.string().uuid(),
    consumer_relative_path: z.string().min(1).max(500),
    consumer_line: z.number().int().gte(1),
    kind: ReferenceKind,
    confidence: ReferenceConfidence,
    excerpt: z.string().max(300).nullable().default(null),
  })
  .strict();
export type SymbolReferenceV1 = z.infer<typeof SymbolReferenceV1>;

// RemovedOrChangedSymbolV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const RemovedOrChangedSymbolV1 = z
  .object({
    target_symbol_id: z.string().uuid(),
    qualified_name: z.string().min(1).max(500),
    change_kind: ChangeKind,
    new_signature: z.string().max(500).nullable().default(null),
  })
  .strict();
export type RemovedOrChangedSymbolV1 = z.infer<typeof RemovedOrChangedSymbolV1>;

// ConsumerHitV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const ConsumerHitV1 = z
  .object({
    consumer_repo_id: z.string().uuid(),
    consumer_relative_path: z.string().min(1).max(500),
    consumer_line: z.number().int().gte(1),
    confidence: ReferenceConfidence,
    excerpt: z.string().max(300).nullable().default(null),
  })
  .strict();
export type ConsumerHitV1 = z.infer<typeof ConsumerHitV1>;

// RetrievedConsumersV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// Nests RemovedOrChangedSymbolV1 (target) + a tuple[ConsumerHitV1, ...] (hits, default ()).
export const RetrievedConsumersV1 = z
  .object({
    schema_version: z.number().int().default(1),
    target: RemovedOrChangedSymbolV1,
    // tuple[ConsumerHitV1, ...] = default_factory=tuple → z.array(...).default([]).
    hits: z.array(ConsumerHitV1).default([]),
    truncated: z.boolean().default(false),
  })
  .strict();
export type RetrievedConsumersV1 = z.infer<typeof RetrievedConsumersV1>;
