// Phase 3a W3: the Postgres scheduler/poller replacing Temporal Schedules. Proves against the real
// DB (FakeClock-driven, so every advanced next_run_at / last_enqueued_at is asserted EXACTLY):
//   (1) a DUE interval schedule → exactly ONE core.background_jobs row (job_type / payload /
//       dedup_key = schedule_id) + next_run_at advanced by the interval + last_enqueued_at stamped;
//   (2) a DUE daily-cron schedule → enqueued + next_run_at = the next H:M strictly after clock.now();
//   (3) overlap=SKIP: a second due poll while the first job is still ACTIVE ('ready') dedups onto the
//       SAME background_jobs row (uq_background_jobs_dedup_active) — still ONE active job;
//   (4) enabled=false → never enqueued, schedule row untouched;
//   (5) a not-yet-due schedule → never enqueued, schedule row untouched;
//   (6) SchedulerLoop polls immediately on run() and stop() interrupts the poll-interval sleep.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { afterAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { Pool } from "pg";
import { FakeClock, WallClock } from "#platform/clock.js";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { SchedulerLoop, pollAndEnqueue } from "#backend/runner/scheduler.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });          // destroys the OWN pool; no disposePool double-end

// AUTHORIZED DEVIATION (test isolation — same rationale as background_jobs_repo.integration.test.ts):
// vitest.config.ts shuffles test order, and pollAndEnqueue scans ALL due core.scheduled_jobs rows, so
// a prior (shuffled) test's leftover due schedule would inflate this test's exact enqueue counts.
// Per-test wipes of BOTH scheduler tables keep counts exact. Safe because test:integration runs
// --no-file-parallelism (files never interleave) and the only other writers
// (scheduled_jobs_schema / background_jobs_* suites) clean their own rows.
beforeEach(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.background_jobs`.execute(db);
    await sql`DELETE FROM core.scheduled_jobs`.execute(db);
  }
});

/** Per-test-unique ids so assertions are traceable to the test that minted the rows. */
function mintIds(): { scheduleId: string; jobType: string } {
  const tag = randomUUID();
  return { scheduleId: `w3-sched-${tag}`, jobType: `w3-job-${tag}` };
}

/** Direct INSERT into core.scheduled_jobs; only the columns under test are passed (defaults exercise). */
async function seedSchedule(opts: {
  scheduleId: string; jobType: string; cadenceKind: "cron" | "interval"; cadenceSpec: string;
  input?: Record<string, unknown>; enabled?: boolean; nextRunAt: Date;
}): Promise<void> {
  await sql`INSERT INTO core.scheduled_jobs
      (schedule_id, job_type, cadence_kind, cadence_spec, input, enabled, next_run_at)
    VALUES (${opts.scheduleId}, ${opts.jobType}, ${opts.cadenceKind}, ${opts.cadenceSpec},
            CAST(${JSON.stringify(opts.input ?? {})} AS jsonb), ${opts.enabled ?? true}, ${opts.nextRunAt})`
    .execute(db);
}

type JobRow = {
  job_id: string; job_type: string; payload: Record<string, unknown>;
  dedup_key: string | null; state: string; installation_id: string | null;
};
/** Every background_jobs row the scheduler minted for a schedule (dedup_key = schedule_id). */
async function jobsFor(scheduleId: string): Promise<Array<JobRow>> {
  const r = await sql<JobRow>`SELECT job_id, job_type, payload, dedup_key, state, installation_id
    FROM core.background_jobs WHERE dedup_key = ${scheduleId} ORDER BY created_at`.execute(db);
  return r.rows;
}

async function readSchedule(scheduleId: string): Promise<{ next_run_at: Date; last_enqueued_at: Date | null }> {
  const r = await sql<{ next_run_at: Date; last_enqueued_at: Date | null }>`
    SELECT next_run_at, last_enqueued_at FROM core.scheduled_jobs
     WHERE schedule_id = ${scheduleId}`.execute(db);
  return r.rows[0]!;
}

describeDb("Postgres scheduler — pollAndEnqueue (Phase 3a W3)", () => {
  it("(1) a DUE interval schedule → exactly ONE background_job + next_run_at advanced by the interval", async () => {
    const clock = new FakeClock({ now: new Date("2026-06-10T12:00:00.000Z") });
    const repo = new BackgroundJobsRepo(db);
    const { scheduleId, jobType } = mintIds();
    await seedSchedule({ scheduleId, jobType, cadenceKind: "interval", cadenceSpec: "300",
      input: { space: "ENG", batch: 17 }, nextRunAt: new Date("2026-06-10T11:59:00.000Z") });

    expect(await pollAndEnqueue({ repo, db, clock })).toBe(1);

    const jobs = await jobsFor(scheduleId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job_type).toBe(jobType);
    expect(jobs[0]!.payload).toEqual({ space: "ENG", batch: 17 }); // schedule input IS the job payload
    expect(jobs[0]!.state).toBe("ready");
    expect(jobs[0]!.installation_id).toBeNull(); // scheduled jobs are platform-scoped

    const s = await readSchedule(scheduleId);
    expect(s.next_run_at).toEqual(new Date("2026-06-10T12:05:00.000Z"));      // clock.now() + 300s
    expect(s.last_enqueued_at).toEqual(new Date("2026-06-10T12:00:00.000Z")); // clock.now()
  });

  it("(2) a DUE daily-cron schedule → enqueued + next_run_at = next H:M strictly after clock.now()", async () => {
    const clock = new FakeClock({ now: new Date("2026-06-10T03:00:00.000Z") });
    const repo = new BackgroundJobsRepo(db);
    const { scheduleId, jobType } = mintIds();
    await seedSchedule({ scheduleId, jobType, cadenceKind: "cron", cadenceSpec: "30 5 * * *",
      nextRunAt: new Date("2026-06-10T02:59:00.000Z") });

    expect(await pollAndEnqueue({ repo, db, clock })).toBe(1);

    expect(await jobsFor(scheduleId)).toHaveLength(1);
    const s = await readSchedule(scheduleId);
    expect(s.next_run_at).toEqual(new Date("2026-06-10T05:30:00.000Z"));      // today's 05:30 is ahead of 03:00
    expect(s.last_enqueued_at).toEqual(new Date("2026-06-10T03:00:00.000Z"));
  });

  it("(3) overlap=SKIP: a second due poll while the job is still ACTIVE dedups onto the SAME job", async () => {
    const clock = new FakeClock({ now: new Date("2026-06-10T12:00:00.000Z") });
    const repo = new BackgroundJobsRepo(db);
    const { scheduleId, jobType } = mintIds();
    await seedSchedule({ scheduleId, jobType, cadenceKind: "interval", cadenceSpec: "60",
      nextRunAt: new Date("2026-06-10T11:59:00.000Z") });

    expect(await pollAndEnqueue({ repo, db, clock })).toBe(1);
    const first = await jobsFor(scheduleId);
    expect(first).toHaveLength(1);

    // The interval elapses BEFORE any worker consumed the job — the schedule is due again.
    clock.advance({ seconds: 61 }); // now 12:01:01; next_run_at was advanced to 12:01:00
    expect(await pollAndEnqueue({ repo, db, clock })).toBe(1); // processed — but dedup'd, not duplicated

    const second = await jobsFor(scheduleId);
    expect(second).toHaveLength(1);                       // STILL one active job: overlap=SKIP
    expect(second[0]!.job_id).toBe(first[0]!.job_id);     // the very same row (dedup_key = schedule_id)
    expect(second[0]!.state).toBe("ready");

    // The schedule itself still advanced on the second poll (the skip is on the JOB, not the cadence).
    const s = await readSchedule(scheduleId);
    expect(s.next_run_at).toEqual(new Date("2026-06-10T12:02:01.000Z"));      // 12:01:01 + 60s
    expect(s.last_enqueued_at).toEqual(new Date("2026-06-10T12:01:01.000Z"));
  });

  it("(4) enabled=false → not enqueued; schedule row untouched", async () => {
    const clock = new FakeClock({ now: new Date("2026-06-10T12:00:00.000Z") });
    const repo = new BackgroundJobsRepo(db);
    const { scheduleId, jobType } = mintIds();
    await seedSchedule({ scheduleId, jobType, cadenceKind: "interval", cadenceSpec: "300",
      enabled: false, nextRunAt: new Date("2026-06-10T11:59:00.000Z") });

    expect(await pollAndEnqueue({ repo, db, clock })).toBe(0);

    expect(await jobsFor(scheduleId)).toHaveLength(0);
    const s = await readSchedule(scheduleId);
    expect(s.next_run_at).toEqual(new Date("2026-06-10T11:59:00.000Z")); // NOT advanced
    expect(s.last_enqueued_at).toBeNull();
  });

  it("(5) a not-yet-due schedule → not enqueued; schedule row untouched", async () => {
    const clock = new FakeClock({ now: new Date("2026-06-10T12:00:00.000Z") });
    const repo = new BackgroundJobsRepo(db);
    const { scheduleId, jobType } = mintIds();
    await seedSchedule({ scheduleId, jobType, cadenceKind: "interval", cadenceSpec: "300",
      nextRunAt: new Date("2026-06-10T13:00:00.000Z") });

    expect(await pollAndEnqueue({ repo, db, clock })).toBe(0);

    expect(await jobsFor(scheduleId)).toHaveLength(0);
    const s = await readSchedule(scheduleId);
    expect(s.next_run_at).toEqual(new Date("2026-06-10T13:00:00.000Z")); // NOT advanced
    expect(s.last_enqueued_at).toBeNull();
  });

  it("(6) SchedulerLoop polls immediately on run() and stop() interrupts the poll-interval sleep", async () => {
    const repo = new BackgroundJobsRepo(db);
    const { scheduleId, jobType } = mintIds();
    // WallClock drives the loop here (FakeClock.sleep returns instantly → a hot spin); the schedule
    // is due against the REAL wall clock, and pollIntervalS=600 proves stop() interrupts the sleep
    // (without the interrupt, `await run` would blow the 10s test timeout).
    await seedSchedule({ scheduleId, jobType, cadenceKind: "interval", cadenceSpec: "3600",
      nextRunAt: new Date(Date.now() - 1000) });
    const loop = new SchedulerLoop({ repo, db, clock: new WallClock(), pollIntervalS: 600 });
    const run = loop.run();
    try {
      // The first poll runs BEFORE the first sleep — wait (bounded) for its enqueue to land.
      const deadline = Date.now() + 5000;
      while ((await jobsFor(scheduleId)).length === 0) {
        if (Date.now() > deadline) throw new Error("SchedulerLoop did not enqueue within 5s");
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      loop.stop(); // must wake the 600s cancellableSleep immediately
    }
    await run;
    expect(await jobsFor(scheduleId)).toHaveLength(1);
  }, 10_000);
});
