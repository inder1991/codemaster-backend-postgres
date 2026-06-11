// W4.6 [L4]+[L5] — retention janitor for the runner's terminal job rows + the webhook idempotency
// ledger. Without it core.review_jobs / core.background_jobs terminal rows and
// cache.cache_idempotency rows (one per webhook delivery, 24h expires_at NEVER enforced) grow
// unbounded. The sweep mirrors the run_id_retention discipline: injected Clock cutoffs, bounded
// FOR UPDATE SKIP LOCKED batches (each its own transaction), terminal-states-only — a ready/leased
// row is NEVER eligible regardless of age.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5439 DB) — never a
// shared cluster (skips when the DSN is absent, per test/integration/_db.ts).
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { jobRetentionSweepActivity } from "#backend/activities/job_retention.activity.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { runOneBackgroundJob } from "#backend/runner/background_runner.js";
import { CRON_SCHEDULES } from "#backend/runner/cron_schedules.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import { registerCronHandlers } from "#backend/runner/handlers/cron_handlers.js";
import { computeNextRun } from "#backend/runner/scheduler.js";
import { disposePool } from "#platform/db/database.js";
import { FakeClock } from "#platform/clock.js";
import { minimalReviewPayload, seedRun } from "./_fixtures.js";

const NOW = new Date("2026-06-11T12:00:00.000Z");
const DAY_MS = 86_400_000;

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => {
  await db?.destroy();
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN); // the activity resolves the shared platform pool
});

// AUTHORIZED DEVIATION (test isolation — the review_jobs_repo suite's rationale): the sweep is a
// cross-tenant scan over ALL rows of the three tables; per-test wipes keep the delete tallies exact.
// Safe under --no-file-parallelism; the other writers clean their own rows.
beforeEach(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.review_jobs`.execute(db);
    await sql`DELETE FROM core.background_jobs`.execute(db);
    await sql`DELETE FROM cache.cache_idempotency WHERE cache_key LIKE 'job-ret-test:%'`.execute(db);
  }
});

/** Insert a review_jobs row in an explicit state with an explicit finished_at age (days before NOW). */
async function seedReviewJob(state: string, finishedDaysAgo: number | null): Promise<string> {
  const s = await seedRun(db);
  const jobId = randomUUID();
  const payload = minimalReviewPayload(s);
  const finishedAt = finishedDaysAgo === null ? null : new Date(NOW.getTime() - finishedDaysAgo * DAY_MS);
  await sql`
    INSERT INTO core.review_jobs
      (job_id, run_id, review_id, installation_id, state, finished_at, created_at,
       payload, payload_sha256, job_payload_schema_version)
    VALUES (${jobId}, ${s.runId}, ${s.reviewId}, ${s.installationId}, ${state}, ${finishedAt},
            ${new Date(NOW.getTime() - 100 * DAY_MS)},
            ${JSON.stringify(payload)}::jsonb, ${"0".repeat(64)}, 1)
  `.execute(db);
  return jobId;
}

/** Insert a background_jobs row in an explicit state with an explicit finished_at age. */
async function seedBackgroundJob(state: string, finishedDaysAgo: number | null): Promise<string> {
  const jobId = randomUUID();
  const finishedAt = finishedDaysAgo === null ? null : new Date(NOW.getTime() - finishedDaysAgo * DAY_MS);
  await sql`
    INSERT INTO core.background_jobs (job_id, job_type, payload, payload_sha256, state, finished_at, created_at)
    VALUES (${jobId}, 'job-ret-test', '{}', ${"0".repeat(64)}, ${state}, ${finishedAt},
            ${new Date(NOW.getTime() - 100 * DAY_MS)})
  `.execute(db);
  return jobId;
}

/** Insert a cache_idempotency row with an explicit expires_at offset (days relative to NOW). */
async function seedIdempotency(expiresDaysFromNow: number): Promise<string> {
  const key = `job-ret-test:${randomUUID()}`;
  await sql`
    INSERT INTO cache.cache_idempotency (cache_key, value, expires_at, created_at)
    VALUES (${key}, ${Buffer.from("x")}, ${new Date(NOW.getTime() + expiresDaysFromNow * DAY_MS)}, ${NOW})
  `.execute(db);
  return key;
}

async function countRows(table: "review" | "background", ids: ReadonlyArray<string>): Promise<number> {
  if (ids.length === 0) return 0;
  const idList = sql.join(ids.map((id) => sql`${id}`));
  const q = table === "review"
    ? sql<{ n: string }>`SELECT COUNT(*) AS n FROM core.review_jobs WHERE job_id IN (${idList})`
    : sql<{ n: string }>`SELECT COUNT(*) AS n FROM core.background_jobs WHERE job_id IN (${idList})`;
  const r = await q.execute(db);
  return Number(r.rows[0]!.n);
}

describeDb("jobRetentionSweepActivity (W4.6 L4+L5)", () => {
  it("(1) deletes ONLY aged terminal review_jobs rows — fresh terminal + old active rows survive", async () => {
    const agedDone = await seedReviewJob("done", 40);
    const agedDead = await seedReviewJob("dead", 40);
    const agedCancelled = await seedReviewJob("cancelled", 40);
    const freshDone = await seedReviewJob("done", 5);
    const oldReady = await seedReviewJob("ready", null); // 100d old created_at but ACTIVE — never eligible

    const result = await jobRetentionSweepActivity({
      dsn: INTEGRATION_DSN!, clock: new FakeClock({ now: NOW }),
      reviewJobsTtlDays: 30, backgroundJobsTtlDays: 30,
    });

    expect(result.review_jobs_deleted).toBe(3);
    expect(await countRows("review", [agedDone, agedDead, agedCancelled])).toBe(0);
    expect(await countRows("review", [freshDone, oldReady])).toBe(2);
  });

  it("(2) deletes ONLY aged terminal background_jobs rows — fresh terminal + old ready rows survive", async () => {
    const agedDone = await seedBackgroundJob("done", 40);
    const agedDead = await seedBackgroundJob("dead", 40);
    const freshDead = await seedBackgroundJob("dead", 5);
    const oldReady = await seedBackgroundJob("ready", null);

    const result = await jobRetentionSweepActivity({
      dsn: INTEGRATION_DSN!, clock: new FakeClock({ now: NOW }),
      reviewJobsTtlDays: 30, backgroundJobsTtlDays: 30,
    });

    expect(result.background_jobs_deleted).toBe(2);
    expect(await countRows("background", [agedDone, agedDead])).toBe(0);
    expect(await countRows("background", [freshDead, oldReady])).toBe(2);
  });

  it("(3) deletes expired cache_idempotency rows (expires_at < now) and preserves live ones", async () => {
    const expired1 = await seedIdempotency(-2);
    const expired2 = await seedIdempotency(-1);
    const live = await seedIdempotency(+1);

    const result = await jobRetentionSweepActivity({
      dsn: INTEGRATION_DSN!, clock: new FakeClock({ now: NOW }),
      reviewJobsTtlDays: 30, backgroundJobsTtlDays: 30,
    });

    expect(result.idempotency_deleted).toBe(2);
    const r = await sql<{ cache_key: string }>`
      SELECT cache_key FROM cache.cache_idempotency WHERE cache_key LIKE 'job-ret-test:%'`.execute(db);
    expect(r.rows.map((x) => x.cache_key)).toEqual([live]);
    void expired1; void expired2;
  });

  it("(4) sweeps in bounded batches and reports the batch count", async () => {
    for (let i = 0; i < 5; i += 1) await seedBackgroundJob("done", 40);
    const result = await jobRetentionSweepActivity({
      dsn: INTEGRATION_DSN!, clock: new FakeClock({ now: NOW }),
      reviewJobsTtlDays: 30, backgroundJobsTtlDays: 30, batchSize: 2,
    });
    expect(result.background_jobs_deleted).toBe(5);
    expect(result.batches).toBeGreaterThanOrEqual(3); // 2+2+1
  });

  it("(5) HANDLER PARITY: an enqueued 'job_retention' job through one runner cycle runs the sweep with the scheduled TTLs", async () => {
    const aged = await seedReviewJob("done", 40);
    const registry = new HandlerRegistry();
    registerCronHandlers(registry, { dsn: INTEGRATION_DSN! });
    const repo = new BackgroundJobsRepo(db);
    const jobId = await repo.enqueue({
      jobType: "job_retention",
      payload: { reviewJobsTtlDays: 30, backgroundJobsTtlDays: 30 }, // the CRON_SCHEDULES input shape
    });
    const r = await runOneBackgroundJob({
      repo, registry, clock: new FakeClock({ now: NOW }),
      owner: "job-ret-test", leaseS: 30, heartbeatS: 5, maxRuntimeS: 300,
    });
    expect(r.outcome).toBe("done");
    expect(r.jobId).toBe(jobId);
    expect((await repo.getById(jobId))!.state).toBe("done");
    expect(await countRows("review", [aged])).toBe(0);
  });
});

// ─── CRON_SCHEDULES seed shape (pure — no DB) ──────────────────────────────────────────────────────
describe("CRON_SCHEDULES — the job_retention daily cron (W4.6 L4+L5)", () => {
  it("carries the codemaster-job-retention entry: daily 03:30 UTC with pinned TTL input", () => {
    const entry = CRON_SCHEDULES.find((s) => s.schedule_id === "codemaster-job-retention");
    expect(entry).toEqual({
      schedule_id: "codemaster-job-retention",
      job_type: "job_retention",
      cadence_kind: "cron",
      cadence_spec: "30 3 * * *",
      input: { reviewJobsTtlDays: 30, backgroundJobsTtlDays: 30 },
    });
  });

  it("its cadence_spec satisfies computeNextRun's daily vocabulary", () => {
    const after = new Date("2026-06-10T00:00:01.000Z");
    expect(computeNextRun("cron", "30 3 * * *", after).toISOString()).toBe("2026-06-10T03:30:00.000Z");
    expect(computeNextRun("cron", "30 3 * * *", new Date("2026-06-10T03:30:00.000Z")).toISOString())
      .toBe("2026-06-11T03:30:00.000Z");
  });
});
