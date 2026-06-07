import { z } from "zod";

/**
 * Contracts for the mark-stale-chunks cron (Sub-spec A T13). 1:1 with the frozen Python
 * contracts/confluence_sync/stale_v1.py. Both models are `ConfigDict(extra="forbid", frozen=True)` ->
 * `.strict()` (Zod has no frozen analogue at the validation layer; immutability is a runtime concern the
 * port enforces by never mutating parsed results).
 *
 * `MarkStaleChunksInputV1` is the empty workflow-level marker for the cron invocation — the thresholds are
 * resolved INSIDE the activity (from platform_config, inlined fallbacks in the TS port per ADR-0075), not
 * from the caller.
 */
export const MarkStaleChunksInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
  })
  .strict();
export type MarkStaleChunksInputV1 = z.infer<typeof MarkStaleChunksInputV1>;

/**
 * Result of `mark_stale_chunks_activity`: per-tier counts of chunks flipped active -> stale + the
 * thresholds that were applied. Counts carry `ge=0`; thresholds carry `ge=1` (a zero/negative threshold
 * would mark every chunk stale).
 */
export const MarkStaleChunksOutputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    chunks_marked_stale_default: z.number().int().gte(0),
    chunks_marked_stale_security_policy: z.number().int().gte(0),
    threshold_days_default: z.number().int().gte(1),
    threshold_days_security_policy: z.number().int().gte(1),
  })
  .strict();
export type MarkStaleChunksOutputV1 = z.infer<typeof MarkStaleChunksOutputV1>;
