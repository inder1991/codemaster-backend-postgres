/**
 * `job_retention` sweep — W4.6 (master-hardening-plan; audit L4 + L5). Retention janitor for the
 * de-Temporal runner's TERMINAL job rows and the webhook idempotency ledger:
 *
 *   1. `core.review_jobs`      — state IN ('done','dead','cancelled') AND settled before the TTL
 *      cutoff. Active rows (`ready`/`leased`) are NEVER eligible regardless of age — backoff and
 *      in-flight work are not garbage. (L4: 0036 shipped no pruning; terminal rows + the all-states
 *      ix_review_jobs_installation grew unbounded.)
 *   2. `core.background_jobs`  — state IN ('done','dead') AND settled before the TTL cutoff.
 *      ('cancelled' does not exist in the background vocabulary — migration 0042.)
 *   3. `cache.cache_idempotency` — rows past their OWN `expires_at` (the webhook persist stamps a
 *      24h TTL that nothing enforced; delivery_ids never reuse, so an expired row is pure garbage —
 *      L5). No TTL input: `expires_at` IS the contract.
 *
 * ## Discipline (mirrors run_id_delete_old_events — the established janitor idiom)
 *
 *   - Injected {@link Clock}; cutoffs computed in JS, bound as parameters — never SQL `now()`.
 *   - Bounded batches: each batch is its own transaction, `FOR UPDATE SKIP LOCKED` on the inner
 *     SELECT so overlapping sweeps coexist; {@link MAX_BATCHES} caps a single run's work (the next
 *     daily tick continues — partial progress survives any abort).
 *   - Shared ADR-0062 pool via `getPool(dsn)` — no per-run pool construction (the OM4 class).
 *   - No per-row audit emit: terminal job rows are operational transients (the run/review lifecycle
 *     tables, swept by run_id_retention, are the durable record).
 *
 * TTL posture: the seeded cron pins 30 days for both job tables (the run_id_retention
 * `runTtlDays=30` precedent) — past that, dead_reason/last_error diagnostics have either been acted
 * on (W3.1 operator surface) or never will be.
 */

import { type PoolClient } from "pg";

import { getPool, withPgTransaction } from "#platform/db/database.js";
import { type Clock, WallClock } from "#platform/clock.js";

import { JobRetentionResultV1 } from "#contracts/job_retention.v1.js";

/** Rows per batch (the EVENTS_BATCH_SIZE precedent — bounded memory + bounded lock duration). */
const BATCH_SIZE = 5000;
/** Per-table batch ceiling per run (the EVENTS_MAX_BATCHES precedent — a daily run is bounded;
 *  the next tick continues where this one stopped). */
const MAX_BATCHES = 200;

export type JobRetentionSweepDeps = {
  /** DSN override; default `CODEMASTER_PG_CORE_DSN`. */
  dsn?: string;
  /** Clock override; default {@link WallClock}. */
  clock?: Clock;
  /** TTL (days) for terminal core.review_jobs rows. */
  reviewJobsTtlDays: number;
  /** TTL (days) for terminal core.background_jobs rows. */
  backgroundJobsTtlDays: number;
  /** Test seam: rows per batch (default {@link BATCH_SIZE}). */
  batchSize?: number;
  /** Test seam: per-table batch ceiling (default {@link MAX_BATCHES}). */
  maxBatches?: number;
};

function resolveDsn(deps: JobRetentionSweepDeps): string {
  const dsn = deps.dsn ?? process.env["CODEMASTER_PG_CORE_DSN"];
  if (dsn === undefined || dsn === "") {
    throw new Error("job_retention: no DSN (set CODEMASTER_PG_CORE_DSN or inject deps.dsn)");
  }
  return dsn;
}

/** `now - ttlDays` in JS from the injected clock (never SQL now()). */
function cutoffFor(clock: Clock, ttlDays: number): Date {
  return new Date(clock.now().getTime() - ttlDays * 86_400_000);
}

/** One bounded-batch DELETE loop: each batch its own transaction; stops at zero rows or the cap. */
async function sweepBatches(
  dsn: string,
  deleteBatch: (client: PoolClient) => Promise<number>,
  batchCap: number,
): Promise<{ deleted: number; batches: number }> {
  const pool = getPool(dsn);
  let deleted = 0;
  let batches = 0;
  for (let i = 0; i < batchCap; i += 1) {
    let rowCount = 0;
    await withPgTransaction(pool, async (client: PoolClient) => {
      rowCount = await deleteBatch(client);
    });
    if (rowCount === 0) break;
    deleted += rowCount;
    batches += 1;
  }
  return { deleted, batches };
}

/**
 * Run the three retention sweeps; returns the validated {@link JobRetentionResultV1} tally.
 * Idempotent + safely re-drivable: every sweep is a pure age/state-predicate DELETE.
 */
export async function jobRetentionSweepActivity(
  deps: JobRetentionSweepDeps,
): Promise<JobRetentionResultV1> {
  const dsn = resolveDsn(deps);
  const clock: Clock = deps.clock ?? new WallClock();
  const batchSize = deps.batchSize ?? BATCH_SIZE;
  const batchCap = deps.maxBatches ?? MAX_BATCHES;
  const reviewCutoff = cutoffFor(clock, deps.reviewJobsTtlDays);
  const backgroundCutoff = cutoffFor(clock, deps.backgroundJobsTtlDays);
  const now = clock.now();

  // Sweep 1 — terminal review_jobs past the TTL. COALESCE(finished_at, created_at): every terminal
  // transition stamps finished_at, but a drifted/hand-edited terminal row without one must still
  // age out rather than live forever.
  // tenant:exempt reason=cross-tenant-retention-sweep-of-terminal-job-rows follow_up=PERMANENT-EXEMPTION-job-retention-sweep
  const review = await sweepBatches(dsn, async (client) => {
    const r = await client.query(
      "DELETE FROM core.review_jobs WHERE job_id IN (" +
        "  SELECT job_id FROM core.review_jobs" +
        "  WHERE state IN ('done','dead','cancelled') AND COALESCE(finished_at, created_at) < $1" +
        "  ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)",
      [reviewCutoff, batchSize],
    );
    return r.rowCount ?? 0;
  }, batchCap);

  // Sweep 2 — terminal background_jobs past the TTL (same shape; 'cancelled' not in this vocabulary).
  const background = await sweepBatches(dsn, async (client) => {
    const r = await client.query(
      "DELETE FROM core.background_jobs WHERE job_id IN (" +
        "  SELECT job_id FROM core.background_jobs" +
        "  WHERE state IN ('done','dead') AND COALESCE(finished_at, created_at) < $1" +
        "  ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)",
      [backgroundCutoff, batchSize],
    );
    return r.rowCount ?? 0;
  }, batchCap);

  // Sweep 3 — expired idempotency rows (their own expires_at is the TTL; delivery_ids never reuse).
  // tenant:exempt reason=cache_idempotency-has-no-installation_id-column-expiry-is-row-local follow_up=PERMANENT-EXEMPTION-job-retention-sweep
  const idempotency = await sweepBatches(dsn, async (client) => {
    const r = await client.query(
      "DELETE FROM cache.cache_idempotency WHERE cache_key IN (" +
        "  SELECT cache_key FROM cache.cache_idempotency" +
        "  WHERE expires_at < $1" +
        "  ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED)",
      [now, batchSize],
    );
    return r.rowCount ?? 0;
  }, batchCap);

  const batches = review.batches + background.batches + idempotency.batches;
  console.info(
    `retention.jobs.summary review_jobs_deleted=${review.deleted} ` +
      `background_jobs_deleted=${background.deleted} idempotency_deleted=${idempotency.deleted} ` +
      `batches=${batches} review_cutoff=${reviewCutoff.toISOString()} ` +
      `background_cutoff=${backgroundCutoff.toISOString()}`,
  );

  return JobRetentionResultV1.parse({
    schema_version: 1,
    review_jobs_deleted: review.deleted,
    background_jobs_deleted: background.deleted,
    idempotency_deleted: idempotency.deleted,
    batches,
  });
}
