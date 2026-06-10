// Phase 3b W3b.2: the 2 DAILY-cron crons — mark_stale_chunks + partition_maintenance (both
// "0 2 * * *", 02:00 UTC) — adapted from Temporal CRON workflows onto the Postgres background-jobs
// platform, plus the 4-cron STARTUP chain. Proves:
//   (1) PARITY (mark_stale_chunks): an enqueued 'mark_stale_chunks' job driven through ONE background
//       cycle produces the SAME DB effect as calling MarkStaleChunksActivity.markStaleChunks directly
//       — the seeded aged chunks (200d default-tier; 120d security_policy-tier) flip active → stale
//       (stale_at stamped) while a 30d fresh chunk stays active;
//   (2) PARITY (partition_maintenance): an enqueued 'partition_maintenance' job driven through ONE
//       cycle runs partman.run_maintenance against the :5434 pg_partman install WITHOUT error — the
//       job settles 'done' with last_error NULL (the handler returns void; the platform persists
//       OUTCOME, so done-with-no-error IS the "returns a result / does not throw" oracle);
//   (3) STARTUP (the 4-cron chain): ensureScheduledJobs seeds ALL 4 core.scheduled_jobs rows
//       (2 interval + 2 daily-cron); pollAndEnqueue after advancing a FakeClock past the due instant
//       enqueues the due ones (dedup_key = schedule_id); the background cycles dispatch every one to
//       'done'; and the daily rows hold for 02:00 UTC (not due at 01:59, due exactly at 02:00) while
//       advancing strictly-after to tomorrow once fired at 02:00 sharp.
//
// Plus the pure (no-DB) registry-shape checks: the 4-entry CRON_SCHEDULES literal, and that
// "0 2 * * *" satisfies the scheduler's computeNextRun daily vocabulary ("M H * * *" ONLY — a seed
// whose spec throws would poison every poll pass, so EVERY entry's spec is asserted computable).
//
// Determinism note (the W4 suite's proven pattern): ensure/poll tests are FakeClock-driven (the poll
// SQL compares next_run_at against the INJECTED clock, so cadence assertions are wall-independent;
// the repo's run_after/claim predicates use DB now(), so fake-enqueued jobs are immediately
// claimable). The runner cycles run under a WallClock composition because runOneBackgroundJob's
// hard-timeout race is microtask-ordered under FakeClock — generous ceilings (300s vs second-scale
// sweeps) keep the outcome deterministic without timing sensitivity.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { FakeClock, WallClock } from "#platform/clock.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";
import { disposePool } from "#platform/db/database.js";
import {
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import {
  buildBackgroundRunner,
  type BackgroundRunnerConfig,
} from "#backend/runner/background_runner_main.js";
import { CRON_SCHEDULES, ensureScheduledJobs } from "#backend/runner/cron_schedules.js";
import { computeNextRun, pollAndEnqueue } from "#backend/runner/scheduler.js";
import { describeDb, INTEGRATION_DSN } from "../_db.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }

/** Install a deterministic dev key registry so the interval handlers' audit before/after encrypt works
 *  without Vault if the startup test's janitor/reaper cycles happen to sweep leftover eligible rows
 *  (same seam as the W3b.1 cron_handlers_interval suite). */
beforeAll(() => {
  const reg = new KeyRegistry();
  reg.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(0x42)]]) }));
  setAuditKeyRegistry(reg);
});

afterAll(async () => {
  resetAuditKeyRegistryForTesting();
  await db?.destroy();                       // the test's OWN pool
  // The activities resolve getPool(CODEMASTER_PG_CORE_DSN) — the shared platform pool; dispose it too.
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

// AUTHORIZED DEVIATION (test isolation — same rationale as cron_handlers_interval.integration.test.ts):
// vitest.config.ts shuffles test order, and claim()/pollAndEnqueue() are cross-job_type scans over ALL
// core.background_jobs / core.scheduled_jobs rows; per-test wipes keep claim targets + enqueue counts
// exact. CRON_SCHEDULES schedule_ids are FIXED PKs (not per-test-unique), so the wipe is also what
// makes ensureScheduledJobs re-runnable per test. Safe because test:integration runs
// --no-file-parallelism (files never interleave) and the other writers clean their own rows.
beforeEach(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.background_jobs`.execute(db);
    await sql`DELETE FROM core.scheduled_jobs`.execute(db);
  }
});

/** Bounded test config (the W4 suite's proven shape): generous ceilings (the partman sweep runs
 *  seconds at most — never grazing 300s), huge sleeps (the single-shot drive seams never enter them). */
const TEST_CONFIG: BackgroundRunnerConfig = {
  owner: "w3b2-cron-test", leaseS: 30, heartbeatS: 5, maxRuntimeS: 300, idleS: 30, pollIntervalS: 600,
};

// ─── confluence_chunks fixtures (the mark_stale_chunks parity seeds) ──────────────────────────────
// Space-scoped to a process-unique key for cleanup; page_id carries a UUID because the natural key
// UNIQUE (page_id, version, chunk_index) is GLOBAL (verified on :5434 — confluence_chunks_natural_key).

const TEST_SPACE = `ZZINTTEST_DAILY_${process.pid}`;
let chunkCounter = 0;

async function seedChunk(args: { daysOld: number; labels: ReadonlyArray<string> }): Promise<string> {
  chunkCounter += 1;
  const pageId = `daily-${chunkCounter}-${randomUUID()}`;
  await sql`INSERT INTO core.confluence_chunks
      (space_key, page_id, page_title, version, chunk_index, chunk_text, content_sha256,
       labels, page_status, last_modified_at)
    VALUES (${TEST_SPACE}, ${pageId}, 'T', 1, 0, 'body',
            ${`${chunkCounter}`.padEnd(64, "0")},
            ${args.labels as Array<string>}::text[], 'active',
            now() - make_interval(days => ${args.daysOld}))`.execute(db);
  return pageId;
}

async function chunkStatus(pageId: string): Promise<{ page_status: string; stale_at: Date | null }> {
  const r = await sql<{ page_status: string; stale_at: Date | null }>`
    SELECT page_status, stale_at FROM core.confluence_chunks
     WHERE space_key = ${TEST_SPACE} AND page_id = ${pageId}`.execute(db);
  return r.rows[0]!;
}

async function cleanupChunks(): Promise<void> {
  await sql`DELETE FROM core.confluence_chunks WHERE space_key = ${TEST_SPACE}`.execute(db);
}

// ─── scheduled_jobs read helper (same shape as the W3b.1 suite) ────────────────────────────────────

type ScheduleRow = {
  schedule_id: string; job_type: string; cadence_kind: string; cadence_spec: string;
  input: Record<string, unknown>; overlap_policy: string; enabled: boolean;
  next_run_at: Date; last_enqueued_at: Date | null;
};
async function readSchedules(): Promise<ReadonlyArray<ScheduleRow>> {
  const r = await sql<ScheduleRow>`SELECT schedule_id, job_type, cadence_kind, cadence_spec, input,
      overlap_policy, enabled, next_run_at, last_enqueued_at
    FROM core.scheduled_jobs ORDER BY schedule_id`.execute(db);
  return r.rows;
}

describeDb("cron_handlers — daily crons on the background-jobs platform (Phase 3b W3b.2)", () => {
  it("(1) PARITY: an enqueued 'mark_stale_chunks' job through one cycle flips aged chunks stale (same effect as the activity)", async () => {
    const agedDefault = await seedChunk({ daysOld: 200, labels: ["lang:python"] });          // > 180d default tier
    const agedSecurity = await seedChunk({ daysOld: 120, labels: ["topic:security_policy"] }); // > 90d security tier (< 180d)
    const fresh = await seedChunk({ daysOld: 30, labels: ["lang:python"] });                 // inside both windows
    try {
      const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
      const repo = new BackgroundJobsRepo(db);
      const jobId = await repo.enqueue({ jobType: "mark_stale_chunks", payload: {} });

      const r = await handles.runOneCycle();
      expect(r.outcome).toBe("done");
      expect(r.jobId).toBe(jobId);
      expect((await repo.getById(jobId))!.state).toBe("done");

      // The Temporal-activity effect, reproduced through the handler path: both tiers swept, fresh preserved.
      const defaultRow = await chunkStatus(agedDefault);
      expect(defaultRow.page_status).toBe("stale");
      expect(defaultRow.stale_at).not.toBeNull();
      const securityRow = await chunkStatus(agedSecurity);
      expect(securityRow.page_status).toBe("stale");      // the 90d security pass (the default pass excludes it)
      expect(securityRow.stale_at).not.toBeNull();
      const freshRow = await chunkStatus(fresh);
      expect(freshRow.page_status).toBe("active");
      expect(freshRow.stale_at).toBeNull();
    } finally {
      await cleanupChunks();
    }
  });

  it("(2) PARITY: an enqueued 'partition_maintenance' job through one cycle runs partman.run_maintenance without error", async () => {
    const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
    const repo = new BackgroundJobsRepo(db);
    const jobId = await repo.enqueue({ jobType: "partition_maintenance", payload: {} });

    const r = await handles.runOneCycle();
    expect(r.outcome).toBe("done");
    expect(r.jobId).toBe(jobId);

    // done + last_error NULL is the "ran the activity, no throw" oracle (the handler returns void —
    // the platform persists OUTCOME, not the PartitionMaintenanceResultV1 payload).
    const settled = (await repo.getById(jobId))!;
    expect(settled.state).toBe("done");
    expect(settled.last_error).toBeNull();
  });

  it("(3) STARTUP: ensureScheduledJobs seeds ALL 4 rows; a due poll enqueues them; cycles dispatch them; daily rows hold for 02:00 UTC", async () => {
    const t0 = new Date("2026-06-10T00:00:00.000Z");
    const fake = new FakeClock({ now: t0 });
    await ensureScheduledJobs(db, fake);

    // ALL 4 rows seeded (ORDER BY schedule_id) — 2 interval (W3b.1) + 2 daily-cron (W3b.2).
    const seeded = await readSchedules();
    expect(seeded.map((r) => r.schedule_id)).toEqual([
      "codemaster-mark-stale-chunks",
      "codemaster-mutex-janitor",
      "codemaster-partition-maintenance",
      "codemaster-review-run-reaper",
    ]);
    for (const daily of ["codemaster-mark-stale-chunks", "codemaster-partition-maintenance"]) {
      const row = seeded.find((r) => r.schedule_id === daily)!;
      expect(row.cadence_kind).toBe("cron");
      expect(row.cadence_spec).toBe("0 2 * * *");
      expect(row.input).toEqual({});
      expect(row.overlap_policy).toBe("skip");
      expect(row.enabled).toBe(true);
      expect(row.next_run_at.getTime()).toBe(t0.getTime()); // first insert stamps clock.now() → fires promptly
      expect(row.last_enqueued_at).toBeNull();
    }

    // Advance the FakeClock past the due instant → ONE poll enqueues ALL 4 (dedup_key = schedule_id).
    fake.advance({ seconds: 1 });                                          // t1 = 00:00:01Z
    const repo = new BackgroundJobsRepo(db);
    expect(await pollAndEnqueue({ repo, db, clock: fake })).toBe(4);
    const jobs = await sql<{ job_id: string; job_type: string; state: string; dedup_key: string | null }>`
      SELECT job_id, job_type, state, dedup_key FROM core.background_jobs ORDER BY job_type`.execute(db);
    expect(jobs.rows.map((j) => j.job_type)).toEqual([
      "mark_stale_chunks", "mutex_janitor", "partition_maintenance", "review_run_reaper",
    ]);
    const byType = new Map(jobs.rows.map((j) => [j.job_type, j]));
    for (const s of CRON_SCHEDULES) {
      expect(byType.get(s.job_type)!.dedup_key).toBe(s.schedule_id);
      expect(byType.get(s.job_type)!.state).toBe("ready");
    }

    // The cadences advanced per-kind off the poll instant t1: intervals to t1+300s/+600s; the daily
    // rows to TODAY's 02:00 UTC (t1 is before 02:00, so today's instant is still strictly ahead).
    const afterPoll = await readSchedules();
    const at = (id: string): ScheduleRow => afterPoll.find((r) => r.schedule_id === id)!;
    expect(at("codemaster-mutex-janitor").next_run_at.toISOString()).toBe("2026-06-10T00:05:01.000Z");
    expect(at("codemaster-review-run-reaper").next_run_at.toISOString()).toBe("2026-06-10T00:10:01.000Z");
    expect(at("codemaster-mark-stale-chunks").next_run_at.toISOString()).toBe("2026-06-10T02:00:00.000Z");
    expect(at("codemaster-partition-maintenance").next_run_at.toISOString()).toBe("2026-06-10T02:00:00.000Z");

    // The background cycles dispatch ALL 4 through the registry to 'done' (WallClock composition —
    // claim order is priority/run_after-driven, so assert the SET, not the order).
    const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
    const dispatched = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const r = await handles.runOneCycle();
      expect(r.outcome).toBe("done");
      dispatched.add(r.jobId!);
    }
    expect(dispatched).toEqual(new Set(jobs.rows.map((j) => j.job_id)));
    expect((await handles.runOneCycle()).outcome).toBe("idle");            // exactly 4 — nothing left

    // Daily-cadence discipline: at 01:59 only the interval rows are due (the daily pair HOLDS) …
    fake.set({ now: new Date("2026-06-10T01:59:00.000Z") });
    expect(await pollAndEnqueue({ repo, db, clock: fake })).toBe(2);
    const ready0159 = await sql<{ job_type: string }>`
      SELECT job_type FROM core.background_jobs WHERE state = 'ready' ORDER BY job_type`.execute(db);
    expect(ready0159.rows.map((j) => j.job_type)).toEqual(["mutex_janitor", "review_run_reaper"]);

    // … and at 02:00 sharp the daily pair fires (next_run_at <= now), advancing STRICTLY-AFTER to
    // tomorrow's 02:00 (computeNextRun's "today only if still strictly ahead" semantics).
    fake.set({ now: new Date("2026-06-10T02:00:00.000Z") });
    expect(await pollAndEnqueue({ repo, db, clock: fake })).toBe(2);
    const ready0200 = await sql<{ job_type: string }>`
      SELECT job_type FROM core.background_jobs WHERE state = 'ready' ORDER BY job_type`.execute(db);
    expect(ready0200.rows.map((j) => j.job_type)).toEqual([
      "mark_stale_chunks", "mutex_janitor", "partition_maintenance", "review_run_reaper",
    ]);
    const afterDaily = await readSchedules();
    expect(afterDaily.find((r) => r.schedule_id === "codemaster-mark-stale-chunks")!
      .next_run_at.toISOString()).toBe("2026-06-11T02:00:00.000Z");
    expect(afterDaily.find((r) => r.schedule_id === "codemaster-partition-maintenance")!
      .next_run_at.toISOString()).toBe("2026-06-11T02:00:00.000Z");
  });
});

// ─── CRON_SCHEDULES literal shape + cadence-vocabulary fit (pure — no DB) ──────────────────────────
describe("CRON_SCHEDULES (Phase 3b W3b.2 entries)", () => {
  it("carries the 4 entries: the 2 W3b.1 intervals + the 2 daily crons at 02:00 UTC", () => {
    expect(CRON_SCHEDULES).toEqual([
      { schedule_id: "codemaster-mutex-janitor", job_type: "mutex_janitor", cadence_kind: "interval", cadence_spec: "300", input: {} },
      { schedule_id: "codemaster-review-run-reaper", job_type: "review_run_reaper", cadence_kind: "interval", cadence_spec: "600", input: {} },
      { schedule_id: "codemaster-mark-stale-chunks", job_type: "mark_stale_chunks", cadence_kind: "cron", cadence_spec: "0 2 * * *", input: {} },
      { schedule_id: "codemaster-partition-maintenance", job_type: "partition_maintenance", cadence_kind: "cron", cadence_spec: "0 2 * * *", input: {} },
    ]);
  });

  it("every entry's cadence_spec satisfies computeNextRun (a seed whose spec throws would poison the poll pass)", () => {
    const after = new Date("2026-06-10T00:00:01.000Z");
    for (const s of CRON_SCHEDULES) {
      expect(() => computeNextRun(s.cadence_kind, s.cadence_spec, after)).not.toThrow();
    }
    // "0 2 * * *" lands on today's 02:00 UTC while strictly ahead, tomorrow's once reached exactly.
    expect(computeNextRun("cron", "0 2 * * *", after).toISOString()).toBe("2026-06-10T02:00:00.000Z");
    expect(computeNextRun("cron", "0 2 * * *", new Date("2026-06-10T02:00:00.000Z")).toISOString())
      .toBe("2026-06-11T02:00:00.000Z");
  });
});
