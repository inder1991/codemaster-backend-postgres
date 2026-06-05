/**
 * Unit tests for {@link RecordingEmbeddingsClient} — the deterministic dev/test {@link EmbeddingsPort}
 * double.
 *
 * Pins:
 *   - DETERMINISM: same input text → identical vector (within AND across client instances; the FNV-1a
 *     seed has no salt). This is the property the aggregation semantic-merge relies on.
 *   - SHAPE: one vector per input; vector length === EMBEDDING_DIM; every component in [-1, 1].
 *   - DIFFERENT inputs → different vectors (no accidental collision on small inputs).
 *   - RECORDING: every call is appended to `.calls`; `callCount()` tracks it.
 *   - RESULT METADATA: model_name echoes the request; model_version === "test-v1"; cache_hits === 0.
 *   - SIMULATED ERRORS: simulateUnreachable / simulateRateLimited raise the typed errors.
 *   - VALIDATION: an empty texts batch raises EmbeddingsValidationError (the Pydantic min_length=1).
 *
 * The exact vector algorithm (the verifier's reference) is documented on RecordingEmbeddingsClient:
 * FNV-1a-32 seed → xorshift32 → (x / 0xFFFFFFFF)*2 - 1, EMBEDDING_DIM draws.
 */

import { describe, expect, it } from "vitest";

import {
  type EmbedRequest,
  EMBEDDING_DIM,
  EmbeddingsConnectivityError,
  EmbeddingsRateLimitedError,
  EmbeddingsValidationError,
  RecordingEmbeddingsClient,
} from "#backend/adapters/embeddings_port.js";

function req(texts: Array<string>): EmbedRequest {
  return { texts, model_name: "qwen3-embed-0.6b", purpose: "review_query" };
}

describe("RecordingEmbeddingsClient", () => {
  it("returns one vector per input text, EMBEDDING_DIM wide, components in [-1, 1]", async () => {
    const client = new RecordingEmbeddingsClient();
    const result = await client.embed(req(["alpha", "beta", "gamma"]));
    expect(result.vectors.length).toBe(3);
    for (const vec of result.vectors) {
      expect(vec.length).toBe(EMBEDDING_DIM);
      for (const component of vec) {
        expect(component).toBeGreaterThanOrEqual(-1);
        expect(component).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is deterministic: same input → identical vector across separate client instances", async () => {
    const a = new RecordingEmbeddingsClient();
    const b = new RecordingEmbeddingsClient();
    const ra = await a.embed(req(["the quick brown fox"]));
    const rb = await b.embed(req(["the quick brown fox"]));
    expect(ra.vectors[0]).toEqual(rb.vectors[0]);
  });

  it("maps different inputs to different vectors", async () => {
    const client = new RecordingEmbeddingsClient();
    const result = await client.embed(req(["cat", "dog"]));
    expect(result.vectors[0]).not.toEqual(result.vectors[1]);
  });

  it("matches the documented FNV-1a-32 → xorshift32 reference for a known input", async () => {
    // Independent reimplementation of the documented algorithm — proves the vector is reproducible
    // from the spec alone (the verifier can reuse this exact code).
    const expectFirstThree = (text: string): Array<number> => {
      const bytes = new TextEncoder().encode(text);
      let h = 2166136261;
      for (const byte of bytes) {
        h ^= byte;
        h = Math.imul(h, 16777619) >>> 0;
      }
      let x = (h | 1) >>> 0;
      const out: Array<number> = [];
      for (let i = 0; i < 3; i += 1) {
        x ^= x << 13;
        x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        out.push((x / 0xffffffff) * 2 - 1);
      }
      return out;
    };
    const client = new RecordingEmbeddingsClient();
    const result = await client.embed(req(["hello"]));
    const vec = result.vectors[0];
    expect(vec).toBeDefined();
    const reference = expectFirstThree("hello");
    expect([vec![0], vec![1], vec![2]]).toEqual(reference);
  });

  it("records every call in order and tracks callCount()", async () => {
    const client = new RecordingEmbeddingsClient();
    await client.embed(req(["one"]));
    await client.embed(req(["two", "three"]));
    expect(client.callCount()).toBe(2);
    expect(client.calls[0]?.texts).toEqual(["one"]);
    expect(client.calls[1]?.texts).toEqual(["two", "three"]);
  });

  it("echoes model_name, fixes model_version='test-v1', cache_hits=0", async () => {
    const client = new RecordingEmbeddingsClient();
    const result = await client.embed({
      texts: ["x"],
      model_name: "custom-model",
      purpose: "symbol",
    });
    expect(result.model_name).toBe("custom-model");
    expect(result.model_version).toBe("test-v1");
    expect(result.cache_hits).toBe(0);
  });

  it("raises EmbeddingsConnectivityError when simulateUnreachable()", async () => {
    const client = new RecordingEmbeddingsClient();
    client.simulateUnreachable();
    await expect(client.embed(req(["x"]))).rejects.toBeInstanceOf(EmbeddingsConnectivityError);
  });

  it("raises EmbeddingsRateLimitedError when simulateRateLimited()", async () => {
    const client = new RecordingEmbeddingsClient();
    client.simulateRateLimited();
    await expect(client.embed(req(["x"]))).rejects.toBeInstanceOf(EmbeddingsRateLimitedError);
  });

  it("raises EmbeddingsValidationError on an empty texts batch (Pydantic min_length=1)", async () => {
    const client = new RecordingEmbeddingsClient();
    await expect(client.embed(req([]))).rejects.toBeInstanceOf(EmbeddingsValidationError);
  });
});
