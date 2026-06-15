import { describe, it, expect, vi, afterEach } from "vitest";

// PLATFORM_EMBEDDING_DIMENSION must be a single source of truth derived from the configured
// EMBEDDING_DIM (CODEMASTER_EMBEDDING_DIMENSION), not an independent hardcoded literal.
describe("PLATFORM_EMBEDDING_DIMENSION derives from the configured EMBEDDING_DIM", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to 1024 and equals EMBEDDING_DIM", async () => {
    vi.resetModules();
    const cache = await import("#backend/adapters/embedder_cache.js");
    const port = await import("#backend/adapters/embeddings_port.js");
    expect(cache.PLATFORM_EMBEDDING_DIMENSION).toBe(port.EMBEDDING_DIM);
    expect(cache.PLATFORM_EMBEDDING_DIMENSION).toBe(1024);
  });

  it("reflects a configured CODEMASTER_EMBEDDING_DIMENSION", async () => {
    vi.stubEnv("CODEMASTER_EMBEDDING_DIMENSION", "768");
    vi.resetModules();
    const cache = await import("#backend/adapters/embedder_cache.js");
    expect(cache.PLATFORM_EMBEDDING_DIMENSION).toBe(768);
  });
});
