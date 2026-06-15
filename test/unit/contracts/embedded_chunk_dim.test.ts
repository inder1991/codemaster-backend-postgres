import { describe, it, expect } from "vitest";

import { EmbeddedChunkV1 } from "#contracts/confluence_sync.v1.js";

// The embedding is dimension-agnostic at the contract boundary; the configured width (EMBEDDING_DIM)
// is enforced at the pgvector WRITE path, not here.
describe("EmbeddedChunkV1.embedding is dimension-agnostic", () => {
  const base = {
    chunk_id: "00000000-0000-0000-0000-0000000000aa",
    chunk_index: 0,
    body: "hello",
    content_sha256: "a".repeat(64),
    token_count: 3,
  };

  it("accepts a 768-dim vector", () => {
    expect(EmbeddedChunkV1.safeParse({ ...base, embedding: Array(768).fill(0.1) }).success).toBe(true);
  });

  it("accepts a 2000-dim vector", () => {
    expect(EmbeddedChunkV1.safeParse({ ...base, embedding: Array(2000).fill(0.1) }).success).toBe(true);
  });

  it("still accepts the legacy 1024-dim vector", () => {
    expect(EmbeddedChunkV1.safeParse({ ...base, embedding: Array(1024).fill(0.1) }).success).toBe(true);
  });

  it("still rejects an empty vector", () => {
    expect(EmbeddedChunkV1.safeParse({ ...base, embedding: [] }).success).toBe(false);
  });
});
