// W4.1 [L8 + OWNER-PAYLOAD-VERSIONING] — STRICT payload versioning: the job payload as an API
// contract. Migration 0045 backs the previously NOMINAL-ONLY `schema_version` (Zod `.default(1)`
// synthesized a constant; nothing was persisted) with REAL columns on core.background_jobs +
// core.scheduled_jobs, and the enqueue/dispatch paths get the discipline:
//
//   * enqueue STAMPS the envelope version (BACKGROUND_JOB_ENVELOPE_SCHEMA_VERSION);
//   * BACKWARD compat: a vN-1 stored row (the previous release's producer shape — no
//     schema_version value; the column default carries it) still claims + runs (the owner-mandated
//     "an in-flight payload survives an upgrade" proof);
//   * FORWARD compat: a row stamped NEWER than this runner supports (rolling-deploy skew — a new
//     producer enqueued before this pod was replaced) is DEFERRED, not poisoned: the deferRetry
//     no-attempt-consumed settle (the throttle posture — the ENVIRONMENT refuses the work, the work
//     didn't fail), so a newer runner claims it after the deploy completes. NEVER dead-lettered.
//   * the SCHEDULER boundary skips a scheduled_jobs row stamped newer than it understands via the
//     W4a.2 per-schedule isolation (warn + unadvanced + nothing enqueued).
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable DB) — never a shared
// cluster (skips when the DSN is absent, per test/integration/_db.ts).
import { createHash, randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { FakeClock, WallClock } from "#platform/clock.js";
import { disposePool } from "#platform/db/database.js";
import {
  BACKGROUND_JOB_ENVELOPE_SCHEMA_VERSION,
  BackgroundJobsRepo,
} from "#backend/runner/background_jobs_repo.js";
import { runOneBackgroundJob } from "#backend/runner/background_runner.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import { pollAndEnqueue } from "#backend/runner/scheduler.js";
import { describeDb, INTEGRATION_DSN } from "../_db.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }

afterAll(async () => {
  if (INTEGRATION_DSN) {
    // Leftover w41-% schedules would feed OTHER suites' pollAndEnqueue passes (a due scan is
    // table-wide) — remove them here as well as in beforeEach.
    await sql`DELETE FROM core.scheduled_jobs WHERE schedule_id LIKE 'w41-%'`.execute(db);
  }
  await db?.destroy();
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

// AUTHORIZED DEVIATION (test isolation — the daily-cron suite's rationale): claim() is a
// cross-job_type scan; per-test wipes keep claim targets exact under --no-file-parallelism.
beforeEach(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.background_jobs`.execute(db);
    await sql`DELETE FROM core.scheduled_jobs WHERE schedule_id LIKE 'w41-%'`.execute(db);
  }
});

const RUNNER_ARGS = { owner: "w41-test", leaseS: 30, heartbeatS: 5, maxRuntimeS: 300 };

/** sha256 hex of the canonical (key-sorted) JSON — must mirror the repo's canonicalJson+sha256. */
function shaOf(canonical: string): string {
  return createHash("sha256").update(Buffer.from(canonical, "utf-8")).digest("hex");
}

/** Raw-SQL insert of a background job AS A PRIOR-RELEASE PRODUCER WROTE IT: when `schemaVersion` is
 *  omitted the column is NOT listed (the pre-0045 INSERT shape) and the DB default carries it. */
async function insertRawJob(args: { jobType: string; schemaVersion?: number }): Promise<string> {
  const jobId = randomUUID();
  const canonical = "{}";
  if (args.schemaVersion === undefined) {
    await pool.query(
      `INSERT INTO core.background_jobs (job_id, job_type, payload, payload_sha256)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [jobId, args.jobType, canonical, shaOf(canonical)],
    );
  } else {
    await pool.query(
      `INSERT INTO core.background_jobs (job_id, job_type, payload, payload_sha256, schema_version)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [jobId, args.jobType, canonical, shaOf(canonical), args.schemaVersion],
    );
  }
  return jobId;
}

describeDb("payload schema versioning (W4.1 L8 + OWNER-PAYLOAD-VERSIONING)", () => {
  it("(1) migration 0045: background_jobs + scheduled_jobs carry a REAL schema_version column (int NOT NULL DEFAULT 1)", async () => {
    for (const table of ["background_jobs", "scheduled_jobs"]) {
      const r = await pool.query<{ data_type: string; is_nullable: string; column_default: string }>(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'core' AND table_name = $1 AND column_name = 'schema_version'`,
        [table],
      );
      expect(r.rows, `core.${table}.schema_version must exist`).toHaveLength(1);
      expect(r.rows[0]!.data_type).toBe("integer");
      expect(r.rows[0]!.is_nullable).toBe("NO");
      expect(r.rows[0]!.column_default).toBe("1");
    }
  });

  it("(2) enqueue STAMPS the envelope version on the row", async () => {
    const repo = new BackgroundJobsRepo(db);
    const jobId = await repo.enqueue({ jobType: "w41-stamp", payload: { a: 1 } });
    const r = await pool.query<{ schema_version: number }>(
      `SELECT schema_version FROM core.background_jobs WHERE job_id = $1`,
      [jobId],
    );
    expect(r.rows[0]!.schema_version).toBe(BACKGROUND_JOB_ENVELOPE_SCHEMA_VERSION);
  });

  it("(3) BACKWARD compat: a vN-1 stored row (no schema_version in the INSERT) still claims + RUNS to done", async () => {
    // The owner-mandated upgrade proof: a payload enqueued by the PREVIOUS release (whose INSERT
    // never listed schema_version) must claim + verify + dispatch unchanged after this deploy.
    const jobId = await insertRawJob({ jobType: "w41-compat" });
    let ran = 0;
    const registry = new HandlerRegistry();
    registry.register("w41-compat", async () => {
      ran += 1;
    });
    const repo = new BackgroundJobsRepo(db);
    const r = await runOneBackgroundJob({ repo, registry, clock: new WallClock(), ...RUNNER_ARGS });
    expect(r.outcome).toBe("done");
    expect(r.jobId).toBe(jobId);
    expect(ran).toBe(1);
    expect((await repo.getById(jobId))!.state).toBe("done");
  });

  it("(4) FORWARD compat: a NEWER-envelope row is DEFERRED (no attempt burned, never dead) and the handler NEVER runs", async () => {
    const jobId = await insertRawJob({
      jobType: "w41-newer",
      schemaVersion: BACKGROUND_JOB_ENVELOPE_SCHEMA_VERSION + 1,
    });
    let ran = 0;
    const registry = new HandlerRegistry();
    registry.register("w41-newer", async () => {
      ran += 1;
    });
    const repo = new BackgroundJobsRepo(db);
    const r = await runOneBackgroundJob({ repo, registry, clock: new WallClock(), ...RUNNER_ARGS });
    expect(r.outcome).toBe("failed");
    expect(ran).toBe(0); // an envelope this runner does not understand must NEVER drive a handler

    const job = (await repo.getById(jobId))!;
    expect(job.state).toBe("ready");        // deferred for a NEWER runner — not dead, not leased
    expect(job.attempts).toBe(0);           // the deferRetry no-attempt-consumed settle (deploy skew ≠ work failure)
    expect(job.last_error).toContain("schema_version");
    expect(job.run_after.getTime()).toBeGreaterThan(Date.now()); // pushed past now — paced, not hot-looped
  });

  it("(5) SCHEDULER boundary: a scheduled row stamped NEWER than supported is skipped via the W4a.2 isolation", async () => {
    const now = new Date("2026-06-11T00:00:00.000Z");
    await pool.query(
      `INSERT INTO core.scheduled_jobs
         (schedule_id, job_type, cadence_kind, cadence_spec, input, next_run_at, schema_version)
       VALUES ('w41-newer-schedule', 'mutex_janitor', 'interval', '300', '{}'::jsonb, $1, 2)`,
      [now],
    );
    await pool.query(
      `INSERT INTO core.scheduled_jobs
         (schedule_id, job_type, cadence_kind, cadence_spec, input, next_run_at)
       VALUES ('w41-ok-schedule', 'mutex_janitor', 'interval', '300', '{}'::jsonb, $1)`,
      [now],
    );
    const repo = new BackgroundJobsRepo(db);
    const clock = new FakeClock({ now: new Date("2026-06-11T00:00:01.000Z") });
    // The v1 row enqueues; the v2 row is isolated-skipped + left unadvanced. (The poll's RETURN
    // count is not asserted — the due scan is table-wide and other suites' seeded schedules may
    // also be due; the w41-scoped rows are the deterministic surface.)
    await pollAndEnqueue({ repo, db, clock });
    const enqueued = await pool.query<{ dedup_key: string | null }>(
      `SELECT dedup_key FROM core.background_jobs WHERE dedup_key LIKE 'w41-%'`,
    );
    expect(enqueued.rows.map((r) => r.dedup_key)).toEqual(["w41-ok-schedule"]);
    const skipped = await pool.query<{ next_run_at: Date }>(
      `SELECT next_run_at FROM core.scheduled_jobs WHERE schedule_id = 'w41-newer-schedule'`,
    );
    expect(skipped.rows[0]!.next_run_at.getTime()).toBe(now.getTime()); // unadvanced — re-attempted next poll
  });
});
