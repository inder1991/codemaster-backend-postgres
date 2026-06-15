import { describe, it, expect, vi, afterEach } from "vitest";

import { RecordingEmbeddingsClient, EMBEDDING_DIM } from "#backend/adapters/embeddings_port.js";

// The deterministic dev/test stub must emit vectors of the CONFIGURED width (EMBEDDING_DIM), so that
// stub-backed runs match the pgvector column width regardless of CODEMASTER_EMBEDDING_DIMENSION.
describe("RecordingEmbeddingsClient honors EMBEDDING_DIM", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("emits EMBEDDING_DIM-length vectors (default 1024)", async () => {
    const client = new RecordingEmbeddingsClient();
    const out = await client.embed({ texts: ["hello"], model_name: "stub", purpose: "review_query" });
    expect(out.vectors).toHaveLength(1);
    expect(out.vectors[0]).toHaveLength(EMBEDDING_DIM);
    expect(EMBEDDING_DIM).toBe(1024);
  });

  it("tracks a configured CODEMASTER_EMBEDDING_DIMENSION", async () => {
    vi.stubEnv("CODEMASTER_EMBEDDING_DIMENSION", "512");
    vi.resetModules();
    const mod = await import("#backend/adapters/embeddings_port.js");
    const out = await new mod.RecordingEmbeddingsClient().embed({
      texts: ["hello"],
      model_name: "stub",
      purpose: "review_query",
    });
    expect(mod.EMBEDDING_DIM).toBe(512);
    expect(out.vectors[0]).toHaveLength(512);
  });
});
