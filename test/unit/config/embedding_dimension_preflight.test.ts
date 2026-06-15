import { describe, it, expect } from "vitest";

import { evaluateEmbeddingDimension } from "#backend/deploy_preflight.js";

const ok = {
  configuredDim: 1024,
  activeGenerationDim: 1024,
  activeEmbeddingDimension: 1024,
  columnDims: [
    { column: "core.chunk_embeddings.embedding", dim: 1024 },
    { column: "core.knowledge_chunks.vector", dim: 1024 },
  ],
};

describe("evaluateEmbeddingDimension", () => {
  it("no failures when env, generation, runtime-state, and all columns agree", () => {
    expect(evaluateEmbeddingDimension(ok)).toEqual([]);
  });

  it("flags an active generation embedding at a different dimension", () => {
    const f = evaluateEmbeddingDimension({ ...ok, activeGenerationDim: 768 });
    expect(f).toHaveLength(1);
    expect(f[0]!.what).toMatch(/active generation/i);
  });

  it("flags active_embedding_dimension disagreeing with EMBEDDING_DIM", () => {
    expect(evaluateEmbeddingDimension({ ...ok, activeEmbeddingDimension: 768 })).toHaveLength(1);
  });

  it("flags any pgvector column at the wrong width", () => {
    const f = evaluateEmbeddingDimension({
      ...ok,
      columnDims: [{ column: "core.chunk_embeddings.embedding", dim: 768 }],
    });
    expect(f).toHaveLength(1);
    expect(f[0]!.what).toMatch(/pgvector column/i);
  });

  it("tolerates null observations (fresh / unobservable DB)", () => {
    expect(
      evaluateEmbeddingDimension({
        configuredDim: 1024,
        activeGenerationDim: null,
        activeEmbeddingDimension: null,
        columnDims: [],
      }),
    ).toEqual([]);
  });
});
