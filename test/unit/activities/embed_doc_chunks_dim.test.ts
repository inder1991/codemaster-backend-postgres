// F10 / P1-J — the doc-chunk embed WRITE path targets the fixed core.knowledge_chunks.embedding
// vector(1024) column. A misconfigured embedder returning a non-1024 vector previously caused a SILENT
// per-chunk skip → the knowledge index emptied with no signal. It must now FAIL LOUD with an actionable
// error. (The 1024 dim is the column's, intentionally NOT relaxable here — only the dim-agnostic
// cosine-merge path is exempt from the check; this is the pgvector write path.)

import { describe, expect, it } from "vitest";

import type { EmbedRequest, EmbedResult, EmbeddingsPort } from "#backend/adapters/embeddings_port.js";
import { EmbedDimensionMismatchError, embedDocChunks } from "#backend/activities/embed_doc_chunks.js";
import { chunkKeyToStr, type KnowledgeChunkRepoPort } from "#backend/domain/repos/knowledge_chunks_repo.js";

import { MarkdownChunkV1 } from "#contracts/markdown_chunk.v1.js";

const INST = "11111111-1111-1111-1111-111111111111";
const REPO = "22222222-2222-2222-2222-222222222222";

const chunk = MarkdownChunkV1.parse({
  relative_path: "docs/a.md",
  chunk_index: 0,
  body: "hello world doc body",
  start_line: 1,
  end_line: 1,
});

/** An embedder returning the WRONG dimension (768 ≠ the column's 1024). */
const wrongDimEmbedder: EmbeddingsPort = {
  async embed(req: EmbedRequest): Promise<EmbedResult> {
    return {
      vectors: req.texts.map(() => new Array<number>(768).fill(0.1)),
      model_name: req.model_name,
      model_version: "v1",
      cache_hits: 0,
    };
  },
};

const stubRepo = {
  getExistingHashes: async () => new Map<string, string>(), // nothing cached → the chunk needs embedding
  upsertChunks: async () => undefined,
  deleteOrphanChunks: async () => 0,
} as unknown as KnowledgeChunkRepoPort;

describe("embedDocChunks — dim mismatch fails loud (F10 / P1-J)", () => {
  it("throws EmbedDimensionMismatchError (NOT a silent empty index) when the embedder returns the wrong dim", async () => {
    await expect(
      embedDocChunks({
        installationId: INST,
        repoId: REPO,
        chunks: [chunk],
        chunkHashes: new Map([[chunkKeyToStr("docs/a.md", 0), "sha-abc"]]),
        embeddings: wrongDimEmbedder,
        chunkRepo: stubRepo,
        modelName: "qwen3-embedding-4096",
      }),
    ).rejects.toBeInstanceOf(EmbedDimensionMismatchError);
  });
});
