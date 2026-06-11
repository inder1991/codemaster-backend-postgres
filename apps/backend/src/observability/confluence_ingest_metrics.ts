/**
 * Confluence-ingest OTel metric helpers — W4.4 [RM9] (net-new TS instrument; no frozen-Python
 * analogue: the silent-skip class it observes is specific to the TS resilient-batch fallback).
 *
 * Mirrors the sibling metric modules (confluence_token_metrics.ts / runner_metrics.ts): lazy
 * instrument construction through the `#platform/observability/metrics.js::getMeter` seam (a NO-OP
 * Meter when no MeterProvider is registered, so emission is safe before the exporter is wired),
 * bounded cardinality (NO labels at all here — platform-wide skip rate is the alertable signal;
 * the per-page detail rides the structured WARN log next to each emit).
 */

import { getMeter, type Counter } from "#platform/observability/metrics.js";

/** Chunks silently dropped from a page's upsert because the per-text truncating embed fallback
 *  still rejected them (Grafana-query-stable; renaming requires ADR). */
export const CHUNK_EMBED_SKIPPED_NAME = "codemaster_confluence_chunk_embed_skipped_total";

let chunkEmbedSkipped: Counter | null = null;

/** Record `count` chunks skipped by the embed fallback (RM9). Bounded: no labels. */
export function recordChunkEmbedSkipped(count: number): void {
  chunkEmbedSkipped ??= getMeter("codemaster.confluence_ingest").createCounter(CHUNK_EMBED_SKIPPED_NAME, {
    description:
      "Chunks omitted from a Confluence page upsert because the per-text embed fallback skipped them",
  });
  chunkEmbedSkipped.add(count);
}
