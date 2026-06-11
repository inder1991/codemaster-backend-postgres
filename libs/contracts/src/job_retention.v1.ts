import { z } from "zod";

// JobRetentionResultV1 — result envelope of the W4.6 job-retention sweep (audit L4 + L5).
//
// TS HARDENING DIVERGENCE (no frozen-Python analogue): the de-Temporal runner's job tables
// (core.review_jobs / core.background_jobs) and the webhook idempotency ledger
// (cache.cache_idempotency) are TS-side platform tables the Python never had — so this contract is
// net-new, modeled on the retention.v1.ts integer-counter envelopes (strict, schema_version
// literal-1, ge-0 counters).
export const JobRetentionResultV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    /** Terminal (done/dead/cancelled) core.review_jobs rows deleted past the TTL. */
    review_jobs_deleted: z.number().int().gte(0),
    /** Terminal (done/dead) core.background_jobs rows deleted past the TTL. */
    background_jobs_deleted: z.number().int().gte(0),
    /** cache.cache_idempotency rows deleted past their own expires_at. */
    idempotency_deleted: z.number().int().gte(0),
    /** Bounded-batch transactions executed across all three sweeps. */
    batches: z.number().int().gte(0),
  })
  .strict();
export type JobRetentionResultV1 = z.infer<typeof JobRetentionResultV1>;
