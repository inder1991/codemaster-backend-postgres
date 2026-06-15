import { describe, it, expect } from "vitest";

import { resolveEmbeddingDim } from "#backend/adapters/embeddings_port.js";

describe("resolveEmbeddingDim", () => {
  it("defaults to 1024 when unset or empty", () => {
    expect(resolveEmbeddingDim({})).toBe(1024);
    expect(resolveEmbeddingDim({ CODEMASTER_EMBEDDING_DIMENSION: "" })).toBe(1024);
    expect(resolveEmbeddingDim({ CODEMASTER_EMBEDDING_DIMENSION: "  " })).toBe(1024);
  });

  it("reads a valid configured dimension", () => {
    expect(resolveEmbeddingDim({ CODEMASTER_EMBEDDING_DIMENSION: "768" })).toBe(768);
    expect(resolveEmbeddingDim({ CODEMASTER_EMBEDDING_DIMENSION: "2000" })).toBe(2000);
    expect(resolveEmbeddingDim({ CODEMASTER_EMBEDDING_DIMENSION: "1" })).toBe(1);
  });

  it("rejects non-integers, <1, and >2000 (the pgvector HNSW cap) loudly", () => {
    expect(() => resolveEmbeddingDim({ CODEMASTER_EMBEDDING_DIMENSION: "1024.5" })).toThrow(/integer/i);
    expect(() => resolveEmbeddingDim({ CODEMASTER_EMBEDDING_DIMENSION: "0" })).toThrow(/1\.\.2000/);
    expect(() => resolveEmbeddingDim({ CODEMASTER_EMBEDDING_DIMENSION: "4096" })).toThrow(/2000/);
    expect(() => resolveEmbeddingDim({ CODEMASTER_EMBEDDING_DIMENSION: "abc" })).toThrow();
  });
});
