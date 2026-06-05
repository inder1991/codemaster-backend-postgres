/**
 * LIVE integration test: the REAL {@link OpenAICompatibleEmbeddingsAdapter} (against local Ollama serving
 * the OpenAI-compatible `/v1/embeddings` endpoint) → {@link aggregateSemantic}. Proves the real
 * adapter→merge chain composes end-to-end over actual HTTP — the production wire shape, the response
 * decode, and the cosine-merge consuming the live qwen3-embedding vectors.
 *
 * SKIP-IF-UNREACHABLE: a `beforeAll` probe pings the endpoint; if Ollama isn't running the suite is
 * skipped so validate-fast stays green (mirrors openai_compat_ollama.integration.test.ts).
 *
 * DIM NOTE: qwen3-embedding on Ollama is 4096-dim (the prod platform model is 1024-dim). The merge is
 * cosine-based and DIMENSION-AGNOSTIC, so we do NOT assert a fixed vector width here — only the platform
 * pgvector write path (a later slice) cares about the exact width.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OpenAICompatibleEmbeddingsAdapter } from "#backend/integrations/openai_compat/adapter.js";
import { aggregateSemantic } from "#backend/review/aggregation_semantic.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

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
    console.warn(
      `[skipped] Ollama unreachable at ${OLLAMA_BASE_URL}/v1/embeddings — ` +
        "start Ollama with the qwen3-embedding model to run the live semantic-merge integration test.",
    );
  }
});

/** One finding with sensible defaults; override what the test cares about. */
function finding(overrides: Partial<{ file: string; start_line: number; end_line: number; body: string; confidence: number; title: string }> = {}) {
  return ReviewFindingV1.parse({
    file: overrides.file ?? "a.py",
    start_line: overrides.start_line ?? 1,
    end_line: overrides.end_line ?? 1,
    severity: "issue",
    category: "bug",
    title: overrides.title ?? "t",
    body: overrides.body ?? "b",
    confidence: overrides.confidence ?? 0.5,
  });
}

describe("aggregateSemantic over the live Ollama embedder (real adapter→merge chain)", () => {
  it("merges two paraphrased same-file findings into one", async ({ skip }) => {
    if (!reachable) skip();
    // The REAL adapter with its DEFAULT global-fetch transport (no injected http) — production wiring.
    const embedder = new OpenAICompatibleEmbeddingsAdapter({
      baseUrl: OLLAMA_BASE_URL,
      apiKey: "x", // Ollama ignores the bearer token; a non-empty value is still required.
      modelName: OLLAMA_MODEL,
    });

    // Two near-identical paraphrases on the SAME file — qwen3-embedding places them well above the
    // 0.92 cosine threshold (measured ~0.99 against the live model, so the assertion is NOT flaky). The
    // phrasings differ only in the trailing clause ("before use." vs "before using it.").
    const findings = [
      finding({
        start_line: 1,
        end_line: 1,
        body: "This function does not validate its input argument before use.",
        confidence: 0.4,
      }),
      finding({
        start_line: 1,
        end_line: 1,
        body: "This function does not validate its input argument before using it.",
        confidence: 0.8,
      }),
    ];

    const [merged, skipped] = await aggregateSemantic(findings, embedder);

    // The real embedder succeeded → not skipped. The two paraphrases merged into one (higher-confidence
    // absorbs): body is the separator-joined union, confidence is the max.
    expect(skipped).toBe(false);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.body).toContain("\n---\n");
    expect(merged[0]!.confidence).toBe(0.8);
  }, 30_000);

  it("does NOT merge two unrelated findings (well below threshold)", async ({ skip }) => {
    if (!reachable) skip();
    const embedder = new OpenAICompatibleEmbeddingsAdapter({
      baseUrl: OLLAMA_BASE_URL,
      apiKey: "x",
      modelName: OLLAMA_MODEL,
    });

    // Two semantically distant findings on the same file — cosine well under 0.92, so no merge.
    const findings = [
      finding({
        start_line: 1,
        end_line: 1,
        body: "SQL query is built by string concatenation, enabling injection.",
        confidence: 0.4,
      }),
      finding({
        start_line: 9,
        end_line: 9,
        body: "The variable name uses camelCase but the file convention is snake_case.",
        confidence: 0.8,
      }),
    ];

    const [merged, skipped] = await aggregateSemantic(findings, embedder);

    expect(skipped).toBe(false);
    expect(merged).toHaveLength(2);
  }, 30_000);
});
