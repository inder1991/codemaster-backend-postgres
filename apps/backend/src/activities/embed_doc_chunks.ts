// embedDocChunks (Sprint 10 / S10.2.3, extended Sprint 26 / B-1 + R-5/R-12/R-13 multi-lens audit
// fixes 2026-05-22).
//
// Persist in-repo doc chunk embeddings to `core.knowledge_chunks`. Idempotent on `content_sha256` per
// `(installation_id, repo_id, relative_path, chunk_index)` — chunks whose stored hash matches the
// discovered hash are kept as-is, sparing both the embed service and the database.
//
// ── R-5 ORPHAN-SWEEP EMPTY-CHUNKS GUARD (load-bearing safety check) ──
// Pass 3 refuses the orphan-sweep when `chunks` is empty. The pre-fix path called
// `deleteOrphanChunks(keepKeys=∅)`, which the repo treats as "DELETE every row for this
// (installation_id, repository_id)" — WIPING the entire repo's knowledge index. Common trigger:
// `discoverKnowledgeDocs` returns 0 docs (clone race, `docs/` removed in this push, bad custom pattern),
// or every doc read failed. The default-safe behaviour is to KEEP the prior index intact until a refresh
// with non-empty `chunks` actually runs. Ported EXACTLY — see the empty-fetch integration test.
//
// PURE-of-side-effects beyond the injected ports: no clock, no random (the chunk_id is a deterministic
// UUIDv5 of the natural key — content-addressable, replay-safe).

import { EMBEDDING_DIM, type EmbeddingsPort } from "#backend/adapters/embeddings_port.js";
import {
  type ChunkKey,
  chunkKeyToStr,
  type KnowledgeChunkRepoPort,
  type KnowledgeChunkRow,
} from "#backend/domain/repos/knowledge_chunks_repo.js";
import { deriveDocKind } from "#backend/policy/doc_kind_heuristic.js";
import { deriveDocStatus } from "#backend/policy/doc_status_heuristic.js";

import type { MarkdownChunkV1 } from "#contracts/markdown_chunk.v1.js";
import { EmbedDocChunksResultV1 } from "#contracts/repo_docs.v1.js";

import { uuid5 } from "#platform/randomness.js";

// Embed service batch size. Aligned with EmbedRequest.texts max=128.
const BATCH_SIZE = 128;
const EMBED_PURPOSE = "in_repo_doc";

/** F10 / P1-J: the configured embedder returned a vector whose dim ≠ the vector(1024) column. Fail loud +
 *  actionable rather than silently skipping every chunk (which empties the knowledge index with no signal). */
export class EmbedDimensionMismatchError extends Error {
  public constructor(actual: number, expected: number, model: string) {
    super(
      `embedder returned a ${actual}-dim vector but core.knowledge_chunks.embedding is vector(${expected}) ` +
        `(model=${model}); the doc-chunk write path requires the platform ${expected}-dim model — check ` +
        `CODEMASTER_EMBEDDINGS_PROVIDER / the configured embedder output dimension.`,
    );
    this.name = "EmbedDimensionMismatchError";
  }
}

/**
 * Stable surrogate id for a chunk slot. Computed deterministically from the natural key so
 * re-embedding the same key keeps the same id — review comments cite this as the locator and the
 * citation must remain stable across re-indexes.
 *
 * Derived as `uuid5(repo_id, f"{relative_path}#{chunk_index}")` — the NAMESPACE is `repo_id` ITSELF
 * (a UUID), not a fixed RFC-4122 namespace. The TS `uuid5(namespaceHex, name)` takes the namespace
 * as a hex string; `repoId` is already a UUID string so it is passed straight through.
 */
function chunkIdFor(args: { repoId: string; relativePath: string; chunkIndex: number }): string {
  return uuid5(args.repoId, `${args.relativePath}#${args.chunkIndex}`);
}

/**
 * Index `chunks` into `chunkRepo` using `embeddings`.
 *
 * Three passes:
 *   1. Partition into "needs embedding" vs "skip" via a bulk hash-lookup (R-12).
 *   2. Embed the survivors in batches of {@link BATCH_SIZE}; bulk-upsert one batch per transaction (R-13).
 *      A vector whose dimensionality ≠ {@link EMBEDDING_DIM} is logged + skipped (defensive — embed-service
 *      contract violation; we don't poison the index with a wrong-shape vector).
 *   3. R-5 orphan-sweep — SKIPPED ENTIRELY when `chunks` is empty (the load-bearing index-wipe guard).
 *
 * Propagates whatever the embed port raises (connectivity / rate-limit / validation) — the activity above
 * catches the degradation classes and returns `retrieval_degraded=True`.
 */
export async function embedDocChunks(args: {
  installationId: string;
  repoId: string;
  chunks: ReadonlyArray<MarkdownChunkV1>;
  /** map from `chunkKeyToStr(relativePath, chunkIndex)` → the file's discovered `content_sha256`. */
  chunkHashes: ReadonlyMap<string, string>;
  embeddings: EmbeddingsPort;
  chunkRepo: KnowledgeChunkRepoPort;
  modelName: string;
}): Promise<EmbedDocChunksResultV1> {
  const { installationId, repoId, chunks, chunkHashes, embeddings, chunkRepo, modelName } = args;

  // ── Pass 1 — partition into "needs embedding" vs "skip" by hash (R-12 bulk lookup) ─────────────────
  const toEmbed: Array<MarkdownChunkV1> = [];
  let skippedUnchanged = 0;
  const lookupKeys: Array<ChunkKey> = chunks.map((c) => [c.relative_path, c.chunk_index] as const);
  const existingByKey = await chunkRepo.getExistingHashes({ installationId, repoId, keys: lookupKeys });
  for (const c of chunks) {
    const keyStr = chunkKeyToStr(c.relative_path, c.chunk_index);
    const newHash = chunkHashes.get(keyStr);
    if (newHash === undefined) {
      // Chunker emitted a chunk for which we have no file hash — programmer error upstream. Be defensive:
      // embed so we don't silently drop content.
      toEmbed.push(c);
      continue;
    }
    const existing = existingByKey.get(keyStr) ?? null;
    if (existing === newHash) {
      skippedUnchanged += 1;
      continue;
    }
    toEmbed.push(c);
  }

  // ── Pass 2 — embed the survivors in batches; bulk-upsert one batch per transaction (R-13) ──────────
  let embedded = 0;
  for (let batchStart = 0; batchStart < toEmbed.length; batchStart += BATCH_SIZE) {
    const batch = toEmbed.slice(batchStart, batchStart + BATCH_SIZE);
    if (batch.length === 0) {
      continue;
    }
    const result = await embeddings.embed({
      texts: batch.map((c) => c.body),
      model_name: modelName,
      purpose: EMBED_PURPOSE,
    });
    const upsertRows: Array<KnowledgeChunkRow> = [];
    // zip(batch, result.vectors, strict=True): the port invariant is len(vectors) === len(texts), so `i`
    // is a bounded numeric index into a same-length array — not an attacker-controlled object key.
    batch.forEach((c, i) => {
      // eslint-disable-next-line security/detect-object-injection -- bounded numeric index into a same-length array (port invariant len(vectors)===len(texts))
      const vec = result.vectors[i];
      if (vec === undefined) {
        // Count contract violation (len(vectors) !== len(texts)) — defensive skip of the missing slot.
        return;
      }
      if (vec.length !== EMBEDDING_DIM) {
        // F10 / P1-J: a wrong-dim vector cannot go into the vector(1024) column. The pre-fix code SILENTLY
        // skipped it (return), so a misconfigured embedder emptied the index with NO signal. Fail LOUD with
        // an actionable message — every vector will be wrong (systematic), so one clear throw beats N silent
        // skips. (The dim here is the COLUMN's, intentionally fixed; only the dim-agnostic cosine-merge path
        // is exempt from the 1024 check — embeddings_port.ts — NOT this pgvector WRITE path.)
        throw new EmbedDimensionMismatchError(vec.length, EMBEDDING_DIM, modelName);
      }
      const newHash = chunkHashes.get(chunkKeyToStr(c.relative_path, c.chunk_index));
      if (newHash === undefined) {
        // Cannot happen for a survivor that came from the hashed set, but skip rather than write a
        // NULL content_sha256.
        return;
      }
      upsertRows.push({
        chunkId: chunkIdFor({ repoId, relativePath: c.relative_path, chunkIndex: c.chunk_index }),
        installationId,
        repoId,
        relativePath: c.relative_path,
        chunkIndex: c.chunk_index,
        contentSha256: newHash,
        headingPath: c.heading_path,
        body: c.body,
        vector: [...vec],
        docKind: deriveDocKind(c.relative_path),
        docStatus: deriveDocStatus(c.relative_path, c.body),
      });
    });
    if (upsertRows.length > 0) {
      await chunkRepo.upsertChunks(upsertRows);
      embedded += upsertRows.length;
    }
  }

  // ── Pass 3 — orphan sweep (R-5 EMPTY-CHUNKS GUARD) ─────────────────────────────────────────────────
  //
  // Refuse the orphan-sweep when `chunks` is empty. The intentional "customer removed all docs, sweep
  // stale rows" case is rare and best handled by a separate scheduled cleanup or admin operator command.
  // The default-safe behaviour here is to keep the prior index intact until a refresh with non-empty
  // `chunks` actually runs.
  let deletedOrphans: number;
  if (chunks.length === 0) {
    // chunks=() — skip orphan-sweep to avoid wiping the entire index; prior rows retained.
    deletedOrphans = 0;
  } else {
    const keepKeys = new Set<string>(chunks.map((c) => chunkKeyToStr(c.relative_path, c.chunk_index)));
    deletedOrphans = await chunkRepo.deleteOrphanChunks({ installationId, repoId, keepKeys });
  }

  return EmbedDocChunksResultV1.parse({
    schema_version: 1,
    embedded,
    skipped_unchanged: skippedUnchanged,
    deleted_orphans: deletedOrphans,
  });
}
