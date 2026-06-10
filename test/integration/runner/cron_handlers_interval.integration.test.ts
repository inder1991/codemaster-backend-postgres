// Phase 3b W3b.1: the cron-migration infrastructure + the 2 INTERVAL crons — mutex_janitor (every
// 5min / 300s) + review_run_reaper (every 10min / 600s) — adapted from Temporal CRON workflows onto
// the Postgres background-jobs platform. Proves:
//   (1) ensureScheduledJobs UPSERTS the 2 core.scheduled_jobs rows idempotently: a second call
//       neither duplicates a row nor clobbers operator edits (paused / re-cadenced rows survive —
//       the ensureCronSchedule swallow-ScheduleAlreadyRunning idempotency, now as ON CONFLICT
//       DO NOTHING) nor resets next_run_at;
//   (2) PARITY (mutex_janitor): an enqueued 'mutex_janitor' job driven through ONE background cycle
//       produces the SAME DB effect as calling mutexJanitorActivity directly — the seeded
//       lease-expired live core.pr_review_mutex row is swept (released_at stamped + ONE
//       audit mutex.swept row) while a valid-lease row is preserved;
//   (3) PARITY (review_run_reaper): an enqueued 'review_run_reaper' job driven through ONE cycle
//       flips the seeded stale RUNNING core.review_runs row to CANCELLED/timeout (+ ONE audit
//       review_run.reaped row) while a recent RUNNING row is preserved;
//   (4) the schedule→handler chain composes: every CRON_SCHEDULES job_type has a registered handler
//       in the buildBackgroundRunner registry, and ONE scheduler poll after ensureScheduledJobs
//       enqueues BOTH jobs (dedup_key = schedule_id, state 'ready').
//
// Determinism note (the W4 suite's proven pattern): the ensure tests are FakeClock/pure; the runner
// cycles run under a WallClock composition because runOneBackgroundJob's hard-timeout race is
// microtask-ordered under FakeClock — generous ceilings (60s vs ms-fast sweeps) keep the outcome
// deterministic without timing sensitivity.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { randomInt, randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
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
import { describeDb, INTEGRATION_DSN } from "../_db.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }

/** Install a deterministic dev key registry so the handlers' audit before/after encrypt works without
 *  Vault (same seam as the mutex_janitor / review_run_reaper activity suites). */
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

// AUTHORIZED DEVIATION (test isolation — same rationale as background_runner_main.integration.test.ts):
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

/** Bounded test config (the W4 suite's proven shape): generous ceilings (ms-fast sweeps never graze
 *  them), huge sleeps (the single-shot drive seams never enter them). */
const TEST_CONFIG: BackgroundRunnerConfig = {
  owner: "w3b1-cron-test", leaseS: 2, heartbeatS: 0.2, maxRuntimeS: 60, idleS: 30, pollIntervalS: 600,
};

/** A bigint that fits the GitHub-id columns and is process-unique. */
function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type TenantSeed = { installationId: string; repositoryId: string; ghRepo: number };

/** Seed the FK chain (installation → repository) the mutex / review-run fixtures point at. */
async function seedTenant(): Promise<TenantSeed> {
  const installationId = randomUUID();
  const repositoryId = randomUUID();
  const ghInstall = uniqueBigint();
  const ghRepo = uniqueBigint();
  await sql`INSERT INTO core.installations
      (installation_id, github_installation_id, account_login, account_type)
    VALUES (${installationId}, ${ghInstall}, ${`acct-${ghInstall}`}, 'Organization')`.execute(db);
  await sql`INSERT INTO core.repositories
      (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
    VALUES (${repositoryId}, ${installationId}, ${ghRepo}, ${`org/repo-${ghRepo}`}, 'main', true)`.execute(db);
  return { installationId, repositoryId, ghRepo };
}

/** Insert one LIVE mutex row; the lease expiry is a nested SQL fragment (now() ± interval). */
async function seedMutex(
  seed: TenantSeed,
  prNumber: number,
  leaseExpiresAtSql: ReturnType<typeof sql>,
): Promise<string> {
  const mutexId = randomUUID();
  await sql`INSERT INTO core.pr_review_mutex
      (mutex_id, installation_id, repository_id, pr_number, holder_workflow_id, released_at, lease_expires_at)
    VALUES (${mutexId}, ${seed.installationId}, ${seed.repositoryId}, ${prNumber}, 'wf-holder',
            NULL, ${leaseExpiresAtSql})`.execute(db);
  return mutexId;
}

/** Seed one review chain (pull_request_reviews → review_runs RUNNING) started at `startedAtSql`. */
async function seedRunningRun(
  seed: TenantSeed,
  startedAtSql: ReturnType<typeof sql>,
): Promise<{ reviewId: string; runId: string }> {
  const reviewId = randomUUID();
  const runId = randomUUID();
  const prNumber = (uniqueBigint() % 9999) + 1;
  await sql`INSERT INTO core.pull_request_reviews
      (review_id, provider, repo_id, pr_number, provider_pr_id, status, created_at)
    VALUES (${reviewId}, 'github', ${seed.ghRepo}, ${prNumber}, ${`gh-${reviewId}`}, 'open', now())`.execute(db);
  await sql`INSERT INTO core.review_runs
      (run_id, review_id, trigger_type, attempt_number, lifecycle_state, is_ephemeral, started_at, created_at)
    VALUES (${runId}, ${reviewId}, 'pr_opened', 1, 'RUNNING', false, ${startedAtSql}, now())`.execute(db);
  return { reviewId, runId };
}

/** Tear down a tenant's seeded rows in FK order. */
async function cleanupTenant(seed: TenantSeed, runs: ReadonlyArray<{ reviewId: string; runId: string }> = []): Promise<void> {
  for (const r of runs) {
    await sql`DELETE FROM core.review_runs WHERE run_id = ${r.runId}`.execute(db);
    await sql`DELETE FROM core.pull_request_reviews WHERE review_id = ${r.reviewId}`.execute(db);
  }
  await sql`DELETE FROM audit.audit_events WHERE installation_id = ${seed.installationId}`.execute(db);
  await sql`DELETE FROM core.pr_review_mutex WHERE installation_id = ${seed.installationId}`.execute(db);
  await sql`DELETE FROM core.repositories WHERE installation_id = ${seed.installationId}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${seed.installationId}`.execute(db);
}

type AuditRow = { action: string; target_id: string | null; actor_kind: string };
async function auditRows(installationId: string, action: string): Promise<ReadonlyArray<AuditRow>> {
  const r = await sql<AuditRow>`SELECT action, target_id, actor_kind FROM audit.audit_events
    WHERE installation_id = ${installationId} AND action = ${action}`.execute(db);
  return r.rows;
}

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

describeDb("cron_handlers — interval crons on the background-jobs platform (Phase 3b W3b.1)", () => {
  it("(1) ensureScheduledJobs upserts the 2 interval rows idempotently — no dup, operator edits + next_run_at preserved", async () => {
    const t0 = new Date("2026-06-10T00:00:00.000Z");
    await ensureScheduledJobs(db, new FakeClock({ now: t0 }));

    // Count-agnostic: W3b.2+ waves append entries; this suite owns the 2 INTERVAL rows only (the
    // full 4-entry registry shape is pinned by cron_handlers_daily.integration.test.ts).
    const first = await readSchedules();
    expect(first.map((r) => r.schedule_id)).toContain("codemaster-mutex-janitor");
    expect(first.map((r) => r.schedule_id)).toContain("codemaster-review-run-reaper");
    const janitor = first.find((r) => r.schedule_id === "codemaster-mutex-janitor")!;
    const reaper = first.find((r) => r.schedule_id === "codemaster-review-run-reaper")!;
    expect(janitor.job_type).toBe("mutex_janitor");
    expect(janitor.cadence_kind).toBe("interval");
    expect(janitor.cadence_spec).toBe("300");              // every 5 minutes (Python */5 cron parity)
    expect(janitor.input).toEqual({});
    expect(janitor.overlap_policy).toBe("skip");
    expect(janitor.enabled).toBe(true);
    expect(janitor.next_run_at.getTime()).toBe(t0.getTime()); // fires promptly after first insert
    expect(janitor.last_enqueued_at).toBeNull();
    expect(reaper.job_type).toBe("review_run_reaper");
    expect(reaper.cadence_kind).toBe("interval");
    expect(reaper.cadence_spec).toBe("600");               // every 10 minutes (Python */10 cron parity)
    expect(reaper.input).toEqual({});
    expect(reaper.next_run_at.getTime()).toBe(t0.getTime());

    // Operator edits the janitor row (pause + re-cadence + push next_run_at out) — the re-run MUST NOT clobber.
    const operatorNextRun = new Date("2026-06-11T12:00:00.000Z");
    await sql`UPDATE core.scheduled_jobs
        SET enabled = false, cadence_spec = '999', next_run_at = ${operatorNextRun}
      WHERE schedule_id = 'codemaster-mutex-janitor'`.execute(db);

    // Second call (an hour later): no duplicate rows, no clobber, no next_run_at reset.
    await ensureScheduledJobs(db, new FakeClock({ now: new Date("2026-06-10T01:00:00.000Z") }));
    const second = await readSchedules();
    expect(second).toHaveLength(first.length);             // idempotent — nothing duplicated
    const janitor2 = second.find((r) => r.schedule_id === "codemaster-mutex-janitor")!;
    expect(janitor2.enabled).toBe(false);                  // operator pause survived
    expect(janitor2.cadence_spec).toBe("999");             // operator re-cadence survived
    expect(janitor2.next_run_at.getTime()).toBe(operatorNextRun.getTime());
    const reaper2 = second.find((r) => r.schedule_id === "codemaster-review-run-reaper")!;
    expect(reaper2.next_run_at.getTime()).toBe(t0.getTime()); // untouched row NOT reset to the second call's now
  });

  it("(2) PARITY: an enqueued 'mutex_janitor' job through one cycle sweeps the lease-expired mutex (same effect as the activity)", async () => {
    const seed = await seedTenant();
    const expired = await seedMutex(seed, 11, sql`now() - interval '1 hour'`); // ELIGIBLE: live + expired
    const valid = await seedMutex(seed, 22, sql`now() + interval '1 hour'`);   // live but lease still valid
    try {
      const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
      const repo = new BackgroundJobsRepo(db);
      const jobId = await repo.enqueue({ jobType: "mutex_janitor", payload: {} });

      const r = await handles.runOneCycle();
      expect(r.outcome).toBe("done");
      expect(r.jobId).toBe(jobId);
      expect((await repo.getById(jobId))!.state).toBe("done");

      // The Temporal-activity effect, reproduced through the handler path: expired swept, valid preserved.
      const rows = await sql<{ mutex_id: string; released_at: Date | null }>`
        SELECT mutex_id, released_at FROM core.pr_review_mutex
         WHERE installation_id = ${seed.installationId}`.execute(db);
      const byId = new Map(rows.rows.map((m) => [m.mutex_id, m.released_at]));
      expect(byId.get(expired)).not.toBeNull();
      expect(byId.get(valid)).toBeNull();

      // Exactly ONE audit row — for the swept mutex — with the activity's shape.
      const audits = await auditRows(seed.installationId, "mutex.swept");
      expect(audits).toHaveLength(1);
      expect(audits[0]!.target_id).toBe(expired);
      expect(audits[0]!.actor_kind).toBe("system");
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("(3) PARITY: an enqueued 'review_run_reaper' job through one cycle cancels the stale RUNNING run (same effect as the activity)", async () => {
    const seed = await seedTenant();
    const stale = await seedRunningRun(seed, sql`now() - interval '2 hours'`); // past the 3600s default
    const recent = await seedRunningRun(seed, sql`now()`);                     // inside the window
    try {
      const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
      const repo = new BackgroundJobsRepo(db);
      const jobId = await repo.enqueue({ jobType: "review_run_reaper", payload: {} });

      const r = await handles.runOneCycle();
      expect(r.outcome).toBe("done");
      expect(r.jobId).toBe(jobId);
      expect((await repo.getById(jobId))!.state).toBe("done");

      // The Temporal-activity effect: stale RUNNING → CANCELLED/timeout; recent RUNNING preserved.
      const staleRow = (await sql<{ lifecycle_state: string; cancel_reason: string | null; cancelled_at: Date | null; completed_at: Date | null }>`
        SELECT lifecycle_state, cancel_reason, cancelled_at, completed_at
          FROM core.review_runs WHERE run_id = ${stale.runId}`.execute(db)).rows[0]!;
      expect(staleRow.lifecycle_state).toBe("CANCELLED");
      expect(staleRow.cancel_reason).toBe("timeout");
      expect(staleRow.cancelled_at).not.toBeNull();
      expect(staleRow.completed_at).toBeNull();
      const recentRow = (await sql<{ lifecycle_state: string }>`
        SELECT lifecycle_state FROM core.review_runs WHERE run_id = ${recent.runId}`.execute(db)).rows[0]!;
      expect(recentRow.lifecycle_state).toBe("RUNNING");

      // Exactly ONE audit row, for the reaped run only.
      const audits = await auditRows(seed.installationId, "review_run.reaped");
      expect(audits).toHaveLength(1);
      expect(audits[0]!.target_id).toBe(stale.runId);
      expect(audits[0]!.actor_kind).toBe("system");
    } finally {
      await cleanupTenant(seed, [stale, recent]);
    }
  });

  it("(4) schedule→handler chain: every CRON_SCHEDULES job_type is registered; one poll enqueues every seeded job (dedup_key = schedule_id)", async () => {
    const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
    for (const s of CRON_SCHEDULES) {
      expect(handles.registry.registeredTypes()).toContain(s.job_type);
    }

    await ensureScheduledJobs(db, new WallClock());
    expect(await handles.pollOnce()).toBe(CRON_SCHEDULES.length); // count-agnostic: later waves append
    for (const s of CRON_SCHEDULES) {
      const r = await sql<{ job_type: string; state: string }>`
        SELECT job_type, state FROM core.background_jobs WHERE dedup_key = ${s.schedule_id}`.execute(db);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.job_type).toBe(s.job_type);
      expect(r.rows[0]!.state).toBe("ready");
    }
  });
});

// ─── CRON_SCHEDULES literal shape (pure — no DB) ──────────────────────────────────────────────────
describe("CRON_SCHEDULES (Phase 3b W3b.1 entries)", () => {
  it("carries the 2 interval entries with the Temporal-parity cadences", () => {
    // arrayContaining (not toEqual): later Phase 3b waves append entries; this suite owns the 2
    // interval ones. The FULL registry literal is pinned by cron_handlers_daily.integration.test.ts.
    expect(CRON_SCHEDULES).toEqual(expect.arrayContaining([
      { schedule_id: "codemaster-mutex-janitor", job_type: "mutex_janitor", cadence_kind: "interval", cadence_spec: "300", input: {} },
      { schedule_id: "codemaster-review-run-reaper", job_type: "review_run_reaper", cadence_kind: "interval", cadence_spec: "600", input: {} },
    ]));
  });
});
