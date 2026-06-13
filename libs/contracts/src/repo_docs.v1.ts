import { z } from "zod";

// Zod port of contracts/repo_docs/v1.py (Sprint 10 / S10.2.1).
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in repo_docs.v1.parity.test.ts.
//
// Source models / constants ported (every public one):
//  - MAX_DOC_BYTES       (Final int, 256 KiB)   → MAX_DOC_BYTES
//  - MAX_DOCS_PER_REPO   (Final int, 500)        → MAX_DOCS_PER_REPO
//  - RepoDocV1                  (extra=forbid, frozen) → .strict()
//  - DiscoveredRepoDocsV1       (extra=forbid, frozen) → .strict()
//  - EmbedDocChunksResultV1     (extra=forbid, frozen) → .strict()
//  - RefreshRepoDocsResultV1    (extra=forbid, frozen) → .strict()
//
// NOTE on `schema_version`: the Python contract types it as a plain `int = 1` (NOT a Literal),
// so any int is accepted. Mirror with z.number().int().default(1) — z.literal(1) would wrongly
// reject schema_version=2 and diverge from Pydantic.

// Per-file size cap. Markdown over 256 KiB is almost always auto-generated and not the kind of
// team-practice context retrieval is for.
export const MAX_DOC_BYTES = 256 * 1024;

// Per-repo cap. Surfaces as a degradation reason when hit.
export const MAX_DOCS_PER_REPO = 500;

// RepoDocV1 — one in-scope markdown file discovered in the workspace.
// `content_sha256` is the lowercase hex digest over the file's raw bytes (exactly 64 hex chars).
export const RepoDocV1 = z
  .object({
    relative_path: z.string().min(1).max(500),
    byte_size: z.number().int().gte(0).lte(MAX_DOC_BYTES),
    content_sha256: z.string().min(64).max(64),
  })
  .strict();
export type RepoDocV1 = z.infer<typeof RepoDocV1>;

// DiscoveredRepoDocsV1 — result of ``discover_repo_docs`` for one workspace.
export const DiscoveredRepoDocsV1 = z
  .object({
    schema_version: z.number().int().default(1),
    // tuple[RepoDocV1, ...] = default_factory=tuple → z.array(...).default([]).
    docs: z.array(RepoDocV1).default([]),
    docs_cap_hit: z.boolean().default(false),
  })
  .strict();
export type DiscoveredRepoDocsV1 = z.infer<typeof DiscoveredRepoDocsV1>;

// EmbedDocChunksResultV1 — result of ``embed_doc_chunks`` for one repo (S10.2.3).
export const EmbedDocChunksResultV1 = z
  .object({
    schema_version: z.number().int().default(1),
    embedded: z.number().int().gte(0),
    skipped_unchanged: z.number().int().gte(0),
    deleted_orphans: z.number().int().gte(0),
  })
  .strict();
export type EmbedDocChunksResultV1 = z.infer<typeof EmbedDocChunksResultV1>;

// RefreshRepoDocsResultV1 — result of ``refresh_repo_docs`` orchestration (S10.2.4).
export const RefreshRepoDocsResultV1 = z
  .object({
    schema_version: z.number().int().default(1),
    docs_discovered: z.number().int().gte(0),
    docs_cap_hit: z.boolean().default(false),
    chunks_emitted: z.number().int().gte(0),
    embedded: z.number().int().gte(0),
    skipped_unchanged: z.number().int().gte(0),
    deleted_orphans: z.number().int().gte(0),
    retrieval_degraded: z.boolean().default(false),
    degradation_reason: z.string().max(200).default(""),
  })
  .strict();
export type RefreshRepoDocsResultV1 = z.infer<typeof RefreshRepoDocsResultV1>;
