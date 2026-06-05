/**
 * LIVE integration test for {@link OpenAICompatibleEmbeddingsAdapter} against a local Ollama serving
 * the OpenAI-compatible `/v1/embeddings` endpoint (http://localhost:11434, model `qwen3-embedding`).
 *
 * This proves the REAL adapter — with its DEFAULT global-`fetch` transport (NO injected double) —
 * really embeds over HTTP: the production wire shape, the response decode, and the deterministic
 * output of the qwen3-embedding model. The only thing scripted is NOTHING; the transport is the
 * shipped one.
 *
 * SKIP-IF-UNREACHABLE: a `beforeAll` probe pings the endpoint; if Ollama isn't running (CI, dev boxes
 * without it) the suite is skipped so validate-fast stays green. The model is 4096-dim on Ollama (the
 * prod platform model is 1024-dim) — we assert `vector.length > 0`, NOT `=== EMBEDDING_DIM`, because
 * the aggregation merge is cosine-based and dim-agnostic (only the platform pgvector write path, a
 * later slice, cares about the exact width).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OpenAICompatibleEmbeddingsAdapter } from "#backend/integrations/openai_compat/adapter.js";

const OLLAMA_BASE_URL = "http://localhost:11434";
const OLLAMA_MODEL = "qwen3-embedding";
const PROBE_TIMEOUT_MS = 3000;

let reachable = false;

beforeAll(async () => {
  // Probe the OpenAI-compat endpoint directly. Reachable iff a 200 comes back for a trivial embed.
  // AbortSignal.timeout here is in a TEST file (excluded from the check_clock_random gate, which only
  // scans libs/apps/*/src production sources) — fine to arm a raw probe timeout.
  try {
    const resp = await fetch(`${OLLAMA_BASE_URL}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
      body: JSON.stringify({ model: OLLAMA_MODEL, input: ["ping"] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    reachable = resp.status === 200;
  } catch {
    reachable = false;
  }
});

afterAll(() => {
  if (!reachable) {
    // Surface WHY the suite skipped so a green run isn't mistaken for a real pass.
    console.warn(
      `[skipped] Ollama unreachable at ${OLLAMA_BASE_URL}/v1/embeddings — ` +
        "start Ollama with the qwen3-embedding model to run the live embedder integration test.",
    );
  }
});

describe("OpenAICompatibleEmbeddingsAdapter against live Ollama", () => {
  it("embeds a single text into a non-empty deterministic vector", async ({ skip }) => {
    if (!reachable) skip();
    // The REAL adapter with its DEFAULT global-fetch transport (no injected http) — production wiring.
    const adapter = new OpenAICompatibleEmbeddingsAdapter({
      baseUrl: OLLAMA_BASE_URL,
      apiKey: "x", // Ollama ignores the bearer token; a non-empty value is still required.
      modelName: OLLAMA_MODEL,
    });

    const result = await adapter.embed({
      texts: ["hello"],
      model_name: "ignored-per-adr-0059", // req.model_name is IGNORED; the constructor model wins.
      purpose: "review_query",
    });

    expect(result.vectors).toHaveLength(1);
    const vector = result.vectors[0]!;
    expect(vector.length).toBeGreaterThan(0);
    // The response `model` echoes into both model_name and model_version.
    expect(result.model_name).toContain("qwen3-embedding");
    expect(result.model_version).toBe(result.model_name);
    expect(result.cache_hits).toBe(0);

    // DETERMINISM: same input → same vector. A second embed of the identical text matches byte-for-byte.
    const again = await adapter.embed({
      texts: ["hello"],
      model_name: "ignored",
      purpose: "review_query",
    });
    expect(again.vectors[0]).toEqual(vector);
  });

  it("respects the construction-time model (req.model_name is ignored)", async ({ skip }) => {
    if (!reachable) skip();
    const adapter = new OpenAICompatibleEmbeddingsAdapter({
      baseUrl: OLLAMA_BASE_URL,
      apiKey: "x",
      modelName: OLLAMA_MODEL,
    });
    // A bogus req.model_name MUST NOT change the model used — the adapter sends its constructor model.
    const result = await adapter.embed({
      texts: ["scope check"],
      model_name: "does-not-exist-should-be-ignored",
      purpose: "symbol",
    });
    expect(result.vectors).toHaveLength(1);
    expect(result.model_name).toContain("qwen3-embedding");
  });
});
