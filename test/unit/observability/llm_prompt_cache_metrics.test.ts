/**
 * Unit tests for the W2.2 prompt-cache metric helpers (llm_prompt_cache_metrics.ts) — the cache-hit-rate
 * telemetry the master hardening plan W2.2 mandates for the chunk-call prompt caching.
 *
 * The OTel meter seam (`#platform/observability/metrics.js::getMeter`) returns a NO-OP Meter when no
 * MeterProvider is registered, so these tests assert the SHAPE the module exposes (Grafana-stable
 * names + no-throw emission + the pure outcome classifier), matching how the sibling
 * prompt_assembly/confluence-token metric modules are covered. The end-to-end emission (LlmClient →
 * counters) is pinned with an in-memory MeterProvider in
 * test/unit/llm/llm_client_prompt_cache_telemetry.test.ts.
 */

import { describe, expect, it } from "vitest";

import {
  CACHE_CREATION_TOKENS_NAME,
  CACHE_READ_TOKENS_NAME,
  CACHE_REQUESTS_NAME,
  CACHE_UNCACHED_PROMPT_TOKENS_NAME,
  classifyPromptCacheOutcome,
  recordPromptCacheUsage,
} from "#backend/observability/llm_prompt_cache_metrics.js";

describe("llm_prompt_cache_metrics — metric names (Grafana-stable)", () => {
  it("exposes the four counter names verbatim", () => {
    expect(CACHE_READ_TOKENS_NAME).toBe("codemaster_llm_prompt_cache_read_tokens_total");
    expect(CACHE_CREATION_TOKENS_NAME).toBe("codemaster_llm_prompt_cache_creation_tokens_total");
    expect(CACHE_UNCACHED_PROMPT_TOKENS_NAME).toBe(
      "codemaster_llm_prompt_cache_uncached_prompt_tokens_total",
    );
    expect(CACHE_REQUESTS_NAME).toBe("codemaster_llm_prompt_cache_requests_total");
  });
});

describe("classifyPromptCacheOutcome — pure outcome classifier", () => {
  it("any cache read is a hit (even alongside a creation write extending the prefix)", () => {
    expect(classifyPromptCacheOutcome({ cacheReadTokens: 100, cacheCreationTokens: 0 })).toBe("hit");
    expect(classifyPromptCacheOutcome({ cacheReadTokens: 100, cacheCreationTokens: 50 })).toBe(
      "hit",
    );
  });

  it("a pure creation (first call of a review) is a write", () => {
    expect(classifyPromptCacheOutcome({ cacheReadTokens: 0, cacheCreationTokens: 5000 })).toBe(
      "write",
    );
  });

  it("neither read nor creation is a miss (marker ignored — e.g. prefix below the model minimum)", () => {
    expect(classifyPromptCacheOutcome({ cacheReadTokens: 0, cacheCreationTokens: 0 })).toBe("miss");
  });
});

describe("recordPromptCacheUsage — no-throw before exporter wiring", () => {
  it("emits without throwing for every outcome shape", () => {
    expect(() =>
      recordPromptCacheUsage({
        purpose: "bedrock_review_chunk",
        cacheReadTokens: 4096,
        cacheCreationTokens: 0,
        uncachedPromptTokens: 900,
      }),
    ).not.toThrow();
    expect(() =>
      recordPromptCacheUsage({
        purpose: "unknown",
        cacheReadTokens: 0,
        cacheCreationTokens: 4096,
        uncachedPromptTokens: 900,
      }),
    ).not.toThrow();
    expect(() =>
      recordPromptCacheUsage({
        purpose: "bedrock_review_chunk",
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        uncachedPromptTokens: 900,
      }),
    ).not.toThrow();
  });
});
