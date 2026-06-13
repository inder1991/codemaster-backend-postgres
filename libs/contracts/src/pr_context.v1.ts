import { z } from "zod";

// Zod port of contracts/retrieval/pr_context/v1.py. Parity-validated in
// pr_context.v1.parity.test.ts.
//
// `PRContext` is the single typed boundary into the detector pipeline (ADR-0047). The module is
// self-contained — every model/enum below is defined in the same Python file (no cross-contract
// imports), so this port redefines nothing from sibling Zod schemas.
//
// Source models / enums / constants ported (every public one):
//  - ManifestFetchStatus            (StrEnum)  → z.enum on the .value strings
//  - ManifestContentType            (StrEnum)  → z.enum on the .value strings
//  - ManifestDependencyParsingState (StrEnum)  → z.enum on the .value strings
//  - ParsedDependencyV1 (ConfigDict extra=forbid, frozen) → .strict()
//  - FileClassification (ConfigDict extra=forbid, frozen) → .strict()
//  - ChangedFile        (ConfigDict extra=forbid, frozen) → .strict()
//  - ManifestSnapshot   (ConfigDict extra=forbid, frozen) → .strict()
//  - PRContext          (ConfigDict extra=forbid, frozen) → .strict()
//
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// `schema_version: int = 1` is a plain int default (NOT a Literal), so z.number().int().default(1)
// — z.literal(1) would wrongly reject schema_version=2. UUID fields dump lowercased (mode="json");
// payloads spell them lowercase so Pydantic's lowercasing matches Zod's pass-through.

// ManifestFetchStatus(StrEnum) — model_dump(mode="json") emits the .value strings.
export const ManifestFetchStatus = z.enum([
  "success",
  "not_found",
  "too_large",
  "fetch_failed",
  "decode_failed",
  "truncated",
]);
export type ManifestFetchStatus = z.infer<typeof ManifestFetchStatus>;

// ManifestContentType(StrEnum) — emits the .value strings.
export const ManifestContentType = z.enum(["text", "binary", "unknown"]);
export type ManifestContentType = z.infer<typeof ManifestContentType>;

// ManifestDependencyParsingState(StrEnum) — emits the .value strings.
export const ManifestDependencyParsingState = z.enum([
  "not_attempted",
  "parsed",
  "partial",
  "failed",
  "truncated",
  "unsupported_format",
]);
export type ManifestDependencyParsingState = z.infer<typeof ManifestDependencyParsingState>;

// ParsedDependencyV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const ParsedDependencyV1 = z
  .object({
    schema_version: z.number().int().default(1),
    ecosystem: z.enum(["pip", "npm", "go", "cargo", "composer"]),
    name: z.string().min(1).max(256),
    // version_spec: str | None = Field(default=None, max_length=256)
    version_spec: z.string().max(256).nullable().default(null),
    dependency_type: z.enum(["prod", "dev", "optional", "test", "unknown"]).default("unknown"),
    source_manifest: z.string().min(1).max(4096),
  })
  .strict();
export type ParsedDependencyV1 = z.infer<typeof ParsedDependencyV1>;

// FileClassification — ConfigDict(extra="forbid", frozen=True) → .strict().
export const FileClassification = z
  .object({
    is_generated: z.boolean().default(false),
    is_vendored: z.boolean().default(false),
    is_test: z.boolean().default(false),
    // reason: str | None = None
    reason: z.string().nullable().default(null),
  })
  .strict();
export type FileClassification = z.infer<typeof FileClassification>;

// ChangedFile — ConfigDict(extra="forbid", frozen=True) → .strict().
// classification: FileClassification = Field(default_factory=FileClassification) — the Python default
// is a fully-defaulted FileClassification instance; mirror with the parsed-default object so an omitted
// `classification` dumps identically to Python.
export const ChangedFile = z
  .object({
    path: z.string().min(1).max(4096),
    additions: z.number().int().gte(0),
    deletions: z.number().int().gte(0),
    classification: FileClassification.default(() => FileClassification.parse({})),
  })
  .strict();
export type ChangedFile = z.infer<typeof ChangedFile>;

// ManifestSnapshot — ConfigDict(extra="forbid", frozen=True) → .strict().
export const ManifestSnapshot = z
  .object({
    path: z.string().min(1).max(4096),
    // raw_body: str = Field(default="", max_length=32_768)
    raw_body: z.string().max(32_768).default(""),
    // parsed_dependencies: tuple[str, ...] = Field(default=(), max_length=2000)
    parsed_dependencies: z.array(z.string()).max(2000).default([]),
    // parsed_dependency_records: tuple[ParsedDependencyV1, ...] = Field(default=(), max_length=5000)
    parsed_dependency_records: z.array(ParsedDependencyV1).max(5000).default([]),
    // ── v2 additive fields ───────────────────────────────────────────────
    fetch_status: ManifestFetchStatus.default("success"),
    content_type: ManifestContentType.default("text"),
    byte_length: z.number().int().gte(0).default(0),
    // sha256: str = Field(default="", min_length=0, max_length=64)
    sha256: z.string().min(0).max(64).default(""),
    truncated: z.boolean().default(false),
    // detected_ecosystem: str | None = Field(default=None, max_length=32)
    detected_ecosystem: z.string().max(32).nullable().default(null),
    dependency_parsing_state: ManifestDependencyParsingState.default("not_attempted"),
  })
  .strict();
export type ManifestSnapshot = z.infer<typeof ManifestSnapshot>;

// PRContext — ConfigDict(extra="forbid", frozen=True) → .strict().
export const PRContext = z
  .object({
    schema_version: z.number().int().default(1),
    // pr_id: UUID — required; Pydantic accepts a UUID string and dumps it lowercased (mode="json").
    pr_id: z.string().uuid(),
    // head_sha: str = Field(min_length=40, max_length=40) — full 40-char git SHA.
    head_sha: z.string().min(40).max(40),
    // changed_files: tuple[ChangedFile, ...] = Field(default=(), max_length=2000)
    changed_files: z.array(ChangedFile).max(2000).default([]),
    // manifests: tuple[ManifestSnapshot, ...] = Field(default=(), max_length=50)
    manifests: z.array(ManifestSnapshot).max(50).default([]),
    repo_default_branch: z.string().min(1).max(255),
  })
  .strict();
export type PRContext = z.infer<typeof PRContext>;
