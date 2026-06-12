/**
 * Prompt-cache OTel metric helpers — the W2.2 cache-hit-rate telemetry for the chunk-call prompt
 * caching (master hardening plan W2.2; findings XM1/XM6).
 *
 * Emitted from {@link "../integrations/llm/client.js".LlmClient.invokeModel} after the provider
 * response's `usage` is parsed — ONLY for requests that carried a `cachePrefixMessages` boundary and
 * ONLY on the paid (non-replay) edge, so a ledger replay or a legacy unmarked call never pollutes the
 * hit-rate. Routed through the standard `#platform/observability/metrics.js::getMeter` seam (no-op
 * Meter until a MeterProvider is registered — same idiom as prompt_assembly_metrics.ts).
 *
 * Dashboard math:
 *   hit rate    = rate(requests_total{outcome="hit"}) / rate(requests_total)
 *   token share = rate(read_tokens_total) /
 *                 (rate(read_tokens_total) + rate(creation_tokens_total) + rate(uncached_prompt_tokens_total))
 *   A persistent outcome="miss" stream (neither read nor creation) means the provider IGNORED the
 *   marker — most likely the stable prefix is below the model's minimum cacheable length, or a silent
 *   per-chunk byte leaked into the prefix (see the byte-identity pin in
 *   test/unit/review/prompt_cache_split.test.ts).
 *
 * ## Cardinality discipline
 * NO `installation_id` / `repository_id` / per-PR labels. `purpose` is the BOUNDED ledger-purpose
 * vocabulary the invocation ledger already uses (e.g. "bedrock_review_chunk", "unknown"); `outcome`
 * is the closed 3-value enum below.
 */
import { type Counter, getMeter } from "#platform/observability/metrics.js";

// ─── Counter NAMES (Grafana-query-stable; rename requires ADR) ──
export const CACHE_READ_TOKENS_NAME = "codemaster_llm_prompt_cache_read_tokens_total";
export const CACHE_CREATION_TOKENS_NAME = "codemaster_llm_prompt_cache_creation_tokens_total";
export const CACHE_UNCACHED_PROMPT_TOKENS_NAME =
  "codemaster_llm_prompt_cache_uncached_prompt_tokens_total";
export const CACHE_REQUESTS_NAME = "codemaster_llm_prompt_cache_requests_total";

const METER = getMeter("codemaster.integrations.llm.prompt_cache");

const READ_TOKENS_COUNTER: Counter = METER.createCounter(CACHE_READ_TOKENS_NAME, {
  description:
    "Prompt tokens served from the provider prompt cache (~0.1x price). Rising share = the W2.2 stable-prefix reuse is working.",
});
const CREATION_TOKENS_COUNTER: Counter = METER.createCounter(CACHE_CREATION_TOKENS_NAME, {
  description:
    "Prompt tokens written to the provider prompt cache (~1.25x price; first call of each stable prefix).",
});
const UNCACHED_PROMPT_TOKENS_COUNTER: Counter = METER.createCounter(
  CACHE_UNCACHED_PROMPT_TOKENS_NAME,
  {
    description:
      "Full-price prompt tokens on cache-marked calls (the per-chunk variable tail). Denominator for the cached-token share.",
  },
);
const REQUESTS_COUNTER: Counter = METER.createCounter(CACHE_REQUESTS_NAME, {
  description:
    "Cache-marked LLM requests by outcome (hit = cache read; write = cache creation only; miss = marker ignored by the provider). Labels: purpose x outcome (bounded).",
});

/** The closed outcome vocabulary for {@link CACHE_REQUESTS_NAME}. */
export type PromptCacheOutcome = "hit" | "write" | "miss";

/**
 * Classify one marked request's cache outcome from the provider usage fields. Any cache read is a
 * "hit" (even alongside a creation extending the prefix — the billing win already happened); a pure
 * creation is the expected first-call "write"; neither means the provider ignored the marker.
 */
export function classifyPromptCacheOutcome(args: {
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): PromptCacheOutcome {
  if (args.cacheReadTokens > 0) {
    return "hit";
  }
  if (args.cacheCreationTokens > 0) {
    return "write";
  }
  return "miss";
}

/**
 * Record one cache-marked LLM request's cache usage. `purpose` is the bounded ledger-purpose label the
 * call site already threads for ledger telemetry (F9), so cost observability and cache observability
 * share one vocabulary.
 */
export function recordPromptCacheUsage(args: {
  purpose: string;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  uncachedPromptTokens: number;
}): void {
  const attributes = { purpose: args.purpose };
  if (args.cacheReadTokens > 0) {
    READ_TOKENS_COUNTER.add(Math.trunc(args.cacheReadTokens), attributes);
  }
  if (args.cacheCreationTokens > 0) {
    CREATION_TOKENS_COUNTER.add(Math.trunc(args.cacheCreationTokens), attributes);
  }
  if (args.uncachedPromptTokens > 0) {
    UNCACHED_PROMPT_TOKENS_COUNTER.add(Math.trunc(args.uncachedPromptTokens), attributes);
  }
  REQUESTS_COUNTER.add(1, {
    ...attributes,
    outcome: classifyPromptCacheOutcome({
      cacheReadTokens: args.cacheReadTokens,
      cacheCreationTokens: args.cacheCreationTokens,
    }),
  });
}
