import { describe, it, expect, vi, afterEach } from "vitest";

import {
  resolveGenerationDimension,
  EmbeddingDimensionInvariantError,
} from "#backend/domain/services/embedder_generation_service.js";
import { EMBEDDING_DIM } from "#backend/adapters/embeddings_port.js";

// A new generation's dimension must follow the CONFIGURED EMBEDDING_DIM, not a hardcoded 1024 — else a
// non-1024 deploy creates a generation the embedder cache then rejects.
describe("resolveGenerationDimension follows the configured EMBEDDING_DIM", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to EMBEDDING_DIM when none is requested", () => {
    expect(resolveGenerationDimension(undefined)).toBe(EMBEDDING_DIM);
  });

  it("accepts a requested dimension equal to EMBEDDING_DIM", () => {
    expect(resolveGenerationDimension(EMBEDDING_DIM)).toBe(EMBEDDING_DIM);
  });

  it("rejects a requested dimension that differs from EMBEDDING_DIM", () => {
    expect(() => resolveGenerationDimension(EMBEDDING_DIM + 1)).toThrow(EmbeddingDimensionInvariantError);
  });

  it("defaults to a configured CODEMASTER_EMBEDDING_DIMENSION (e.g. 768), not 1024", async () => {
    vi.stubEnv("CODEMASTER_EMBEDDING_DIMENSION", "768");
    vi.resetModules();
    const mod = await import("#backend/domain/services/embedder_generation_service.js");
    expect(mod.resolveGenerationDimension(undefined)).toBe(768);
    expect(() => mod.resolveGenerationDimension(1024)).toThrow();
  });
});
