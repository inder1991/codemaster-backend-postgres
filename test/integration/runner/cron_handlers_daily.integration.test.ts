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
//   (3) STARTUP (the 9-cron chain): ensureScheduledJobs seeds ALL 9 core.scheduled_jobs rows
//       (4 interval + 3 daily-cron); pollAndEnqueue after advancing a FakeClock past the due instant
//       enqueues the due ones (dedup_key = schedule_id); the background cycles dispatch every one to
//       'done'; the 02:00 daily rows hold for 02:00 UTC (not due at 01:59, due exactly at 02:00)
//       while advancing strictly-after to tomorrow once fired at 02:00 sharp; and the 03:00
//       run_id_retention row holds through 02:00 and fires at 03:00 sharp.
//   (4) PARITY (run_id_retention — Phase 3d W3d.1): an enqueued 'run_id_retention' job driven through
//       ONE cycle chains the 3 run_id sweeps IN ORDER (close → retire → delete) with the scheduled TTL
//       input — the seeded stale ephemeral PR is closed via the injected fake GitHub client (PATCH
//       state=closed + the retention.smoke_pr.closed audit row), the aged terminal run is retired
//       (retired_at + retention_reason='ttl_expired'), and the aged workflow_event is hard-deleted —
//       parity with calling the three activities directly.
//
// Plus the pure (no-DB) registry-shape checks: the 9-entry CRON_SCHEDULES literal, and that every
// cadence_spec satisfies the scheduler's computeNextRun daily vocabulary ("M H * * *" ONLY — a seed
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
import type { GitHubApiClient } from "#backend/integrations/github/api_client.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { runOneBackgroundJob } from "#backend/runner/background_runner.js";
import {
  buildBackgroundRunner,
  type BackgroundRunnerConfig,
} from "#backend/runner/background_runner_main.js";
import { CRON_SCHEDULES, ensureScheduledJobs } from "#backend/runner/cron_schedules.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import { registerCronHandlers } from "#backend/runner/handlers/cron_handlers.js";
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
  outboxIdleS: 600, outboxMaxAttempts: 5,
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

// ─── run_id_retention fixtures (the W3d.1 parity seeds: installation → repo → review → run chain) ──

/** A bigint that fits the GitHub-id columns and is process-unique. */
function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type RetentionSeed = {
  installationId: string;
  fullName: string;
  branchName: string;
  ephemeralRunId: string;
  oldRunId: string;
  agedEventId: string;
  reviewIds: ReadonlyArray<string>;
  ghRepo: number;
};

/**
 * Seed the three sweep targets under ONE tenant: a stale EPHEMERAL run (10d — close-eligible at
 * prTtl=7 but retire-INELIGIBLE at runTtl=30), an aged terminal run (40d — retire-eligible), and an
 * aged workflow_event (100d — delete-eligible at eventTtl=90).
 */
async function seedRetentionFixtures(): Promise<RetentionSeed> {
  const installationId = randomUUID();
  const ghInstall = uniqueBigint();
  const ghRepo = uniqueBigint();
  const fullName = `acme/ret-${ghRepo}`;
  const branchName = `codemaster/run_w3d1_${ghRepo}`;
  await sql`INSERT INTO core.installations
      (installation_id, github_installation_id, account_login, account_type)
    VALUES (${installationId}, ${ghInstall}, ${`acct-${ghInstall}`}, 'Organization')`.execute(db);
  await sql`INSERT INTO core.repositories
      (installation_id, github_repo_id, full_name, default_branch, enabled)
    VALUES (${installationId}, ${ghRepo}, ${fullName}, 'main', true)`.execute(db);

  const mkReview = async (prNumber: number): Promise<string> => {
    const reviewId = randomUUID();
    await sql`INSERT INTO core.pull_request_reviews
        (review_id, provider, repo_id, pr_number, provider_pr_id, status, created_at)
      VALUES (${reviewId}, 'github', ${ghRepo}, ${prNumber}, ${`gh-${reviewId}`}, 'open', now())`.execute(db);
    return reviewId;
  };

  // (close target) ephemeral COMPLETED run, started 10d ago, branch_name set, NOT retired.
  const ephemeralReviewId = await mkReview(1);
  const ephemeralRunId = randomUUID();
  await sql`INSERT INTO core.review_runs
      (run_id, review_id, trigger_type, attempt_number, lifecycle_state, is_ephemeral, branch_name,
       started_at, completed_at, created_at)
    VALUES (${ephemeralRunId}, ${ephemeralReviewId}, 'pr_opened', 1, 'COMPLETED', true, ${branchName},
            now() - interval '10 days', now(), now())`.execute(db);

  // (retire target) plain terminal run, started 40d ago.
  const oldReviewId = await mkReview(2);
  const oldRunId = randomUUID();
  await sql`INSERT INTO core.review_runs
      (run_id, review_id, trigger_type, attempt_number, lifecycle_state, is_ephemeral, started_at,
       completed_at, created_at)
    VALUES (${oldRunId}, ${oldReviewId}, 'pr_opened', 1, 'COMPLETED', false,
            now() - interval '40 days', now(), now())`.execute(db);

  // (delete target) workflow_event received 100d ago, correlated to the old run's chain.
  const agedEventId = randomUUID();
  await sql`INSERT INTO audit.workflow_events
      (event_id, provider, delivery_id, run_id, review_id, sequence_no, event_type, payload,
       received_at, installation_id)
    VALUES (${agedEventId}, 'github', NULL, ${oldRunId}, ${oldReviewId}, 1, 'lifecycle_transition',
            '{}'::jsonb, now() - interval '100 days', ${installationId})`.execute(db);

  return {
    installationId, fullName, branchName, ephemeralRunId, oldRunId, agedEventId,
    reviewIds: [ephemeralReviewId, oldReviewId], ghRepo,
  };
}

/** Tear down the retention seeds in FK order (idempotent — sweep-deleted rows no-op). */
async function cleanupRetentionFixtures(seed: RetentionSeed): Promise<void> {
  await sql`DELETE FROM audit.workflow_events WHERE event_id = ${seed.agedEventId}`.execute(db);
  await sql`DELETE FROM audit.audit_events WHERE installation_id = ${seed.installationId}`.execute(db);
  for (const runId of [seed.ephemeralRunId, seed.oldRunId]) {
    await sql`DELETE FROM core.review_runs WHERE run_id = ${runId}`.execute(db);
  }
  for (const reviewId of seed.reviewIds) {
    await sql`DELETE FROM core.pull_request_reviews WHERE review_id = ${reviewId}`.execute(db);
  }
  await sql`DELETE FROM core.repositories WHERE github_repo_id = ${seed.ghRepo}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${seed.installationId}`.execute(db);
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

  it("(3) STARTUP: ensureScheduledJobs seeds ALL 9 rows; a due poll enqueues them; cycles dispatch them; daily rows hold for their wall instants", async () => {
    const t0 = new Date("2026-06-10T00:00:00.000Z");
    const fake = new FakeClock({ now: t0 });
    await ensureScheduledJobs(db, fake);

    // ALL 9 rows seeded (ORDER BY schedule_id) — 2 interval (W3b.1) + 2 daily-cron (W3b.2) + the
    // run_id_retention daily cron (W3d.1) + the workspace_retention interval (W3e.1) + the
    // confluence_ingest interval (W3e.2) + the job_retention daily cron (W4.6 L4+L5) + the
    // installation drift-reconcile daily cron (W3.6 RH12).
    const seeded = await readSchedules();
    expect(seeded.map((r) => r.schedule_id)).toEqual([
      "codemaster-confluence-ingest",
      "codemaster-installation-drift-reconcile",
      "codemaster-job-retention",
      "codemaster-mark-stale-chunks",
      "codemaster-mutex-janitor",
      "codemaster-partition-maintenance",
      "codemaster-review-run-reaper",
      "codemaster-run-id-retention",
      "codemaster-workspace-retention",
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
    // W3d.1: run_id_retention — daily 03:00 UTC, carrying the TTL input the Temporal Schedule pinned.
    const retention = seeded.find((r) => r.schedule_id === "codemaster-run-id-retention")!;
    expect(retention.cadence_kind).toBe("cron");
    expect(retention.cadence_spec).toBe("0 3 * * *");
    expect(retention.input).toEqual({ prTtlDays: 7, runTtlDays: 30, eventTtlDays: 90 });
    expect(retention.overlap_policy).toBe("skip");
    expect(retention.enabled).toBe(true);
    expect(retention.next_run_at.getTime()).toBe(t0.getTime());
    expect(retention.last_enqueued_at).toBeNull();

    // Advance the FakeClock past the due instant → ONE poll enqueues ALL 9 (dedup_key = schedule_id).
    fake.advance({ seconds: 1 });                                          // t1 = 00:00:01Z
    const repo = new BackgroundJobsRepo(db);
    expect(await pollAndEnqueue({ repo, db, clock: fake })).toBe(9);
    const jobs = await sql<{ job_id: string; job_type: string; state: string; dedup_key: string | null }>`
      SELECT job_id, job_type, state, dedup_key FROM core.background_jobs ORDER BY job_type`.execute(db);
    expect(jobs.rows.map((j) => j.job_type)).toEqual([
      "confluence_ingest", "installation_drift_reconcile", "job_retention", "mark_stale_chunks",
      "mutex_janitor", "partition_maintenance", "review_run_reaper", "run_id_retention",
      "workspace_retention",
    ]);
    const byType = new Map(jobs.rows.map((j) => [j.job_type, j]));
    for (const s of CRON_SCHEDULES) {
      expect(byType.get(s.job_type)!.dedup_key).toBe(s.schedule_id);
      expect(byType.get(s.job_type)!.state).toBe("ready");
    }

    // The cadences advanced per-kind off the poll instant t1: intervals to t1+300s/+600s; the daily
    // rows to TODAY's wall instant (t1 is before 02:00/03:00, so today's instant is still strictly ahead).
    const afterPoll = await readSchedules();
    const at = (id: string): ScheduleRow => afterPoll.find((r) => r.schedule_id === id)!;
    expect(at("codemaster-mutex-janitor").next_run_at.toISOString()).toBe("2026-06-10T00:05:01.000Z");
    expect(at("codemaster-review-run-reaper").next_run_at.toISOString()).toBe("2026-06-10T00:10:01.000Z");
    expect(at("codemaster-workspace-retention").next_run_at.toISOString()).toBe("2026-06-10T00:05:01.000Z");
    expect(at("codemaster-confluence-ingest").next_run_at.toISOString()).toBe("2026-06-10T06:00:01.000Z");
    expect(at("codemaster-mark-stale-chunks").next_run_at.toISOString()).toBe("2026-06-10T02:00:00.000Z");
    expect(at("codemaster-partition-maintenance").next_run_at.toISOString()).toBe("2026-06-10T02:00:00.000Z");
    expect(at("codemaster-run-id-retention").next_run_at.toISOString()).toBe("2026-06-10T03:00:00.000Z");
    expect(at("codemaster-job-retention").next_run_at.toISOString()).toBe("2026-06-10T03:30:00.000Z");
    expect(at("codemaster-installation-drift-reconcile").next_run_at.toISOString()).toBe("2026-06-10T04:15:00.000Z");

    // The background cycles dispatch ALL 9 through the registry to 'done' (WallClock composition —
    // claim order is priority/run_after-driven, so assert the SET, not the order). The retention job
    // runs its REAL sweeps here (no stale ephemeral candidates exist → the deferred-Vault GitHub
    // client is never built; the retire/delete sweeps are idempotent cross-tenant scans — as are the
    // workspace_retention job's three janitor sweeps, which find zero eligible leases, and the
    // confluence_ingest cycle, which lists ZERO enabled confluence_space integrations → the
    // deferred-Vault ConfluenceClient + the lazy embedder are never built).
    const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
    const dispatched = new Set<string>();
    for (let i = 0; i < 9; i += 1) {
      const r = await handles.runOneCycle();
      expect(r.outcome).toBe("done");
      dispatched.add(r.jobId!);
    }
    expect(dispatched).toEqual(new Set(jobs.rows.map((j) => j.job_id)));
    expect((await handles.runOneCycle()).outcome).toBe("idle");            // exactly 9 — nothing left

    // Daily-cadence discipline: at 01:59 only the interval rows are due (every daily row HOLDS) …
    fake.set({ now: new Date("2026-06-10T01:59:00.000Z") });
    expect(await pollAndEnqueue({ repo, db, clock: fake })).toBe(3);
    const ready0159 = await sql<{ job_type: string }>`
      SELECT job_type FROM core.background_jobs WHERE state = 'ready' ORDER BY job_type`.execute(db);
    expect(ready0159.rows.map((j) => j.job_type)).toEqual([
      "mutex_janitor", "review_run_reaper", "workspace_retention",
    ]);

    // … at 02:00 sharp the 02:00 pair fires (next_run_at <= now), advancing STRICTLY-AFTER to
    // tomorrow's 02:00 (computeNextRun's "today only if still strictly ahead" semantics) — while the
    // 03:00 run_id_retention row still HOLDS.
    fake.set({ now: new Date("2026-06-10T02:00:00.000Z") });
    expect(await pollAndEnqueue({ repo, db, clock: fake })).toBe(2);
    const ready0200 = await sql<{ job_type: string }>`
      SELECT job_type FROM core.background_jobs WHERE state = 'ready' ORDER BY job_type`.execute(db);
    expect(ready0200.rows.map((j) => j.job_type)).toEqual([
      "mark_stale_chunks", "mutex_janitor", "partition_maintenance", "review_run_reaper",
      "workspace_retention",
    ]);
    const afterDaily = await readSchedules();
    expect(afterDaily.find((r) => r.schedule_id === "codemaster-mark-stale-chunks")!
      .next_run_at.toISOString()).toBe("2026-06-11T02:00:00.000Z");
    expect(afterDaily.find((r) => r.schedule_id === "codemaster-partition-maintenance")!
      .next_run_at.toISOString()).toBe("2026-06-11T02:00:00.000Z");
    expect(afterDaily.find((r) => r.schedule_id === "codemaster-run-id-retention")!
      .next_run_at.toISOString()).toBe("2026-06-10T03:00:00.000Z");        // unchanged — held

    // … and at 03:00 sharp run_id_retention fires (alongside the now-due intervals from 02:04/02:09),
    // advancing strictly-after to tomorrow's 03:00. Drain the 5 ready jobs first so the interval
    // dedup keys are free.
    for (let i = 0; i < 5; i += 1) {
      expect((await handles.runOneCycle()).outcome).toBe("done");
    }
    fake.set({ now: new Date("2026-06-10T03:00:00.000Z") });
    expect(await pollAndEnqueue({ repo, db, clock: fake })).toBe(4);
    const ready0300 = await sql<{ job_type: string }>`
      SELECT job_type FROM core.background_jobs WHERE state = 'ready' ORDER BY job_type`.execute(db);
    expect(ready0300.rows.map((j) => j.job_type)).toEqual([
      "mutex_janitor", "review_run_reaper", "run_id_retention", "workspace_retention",
    ]);
    expect((await readSchedules()).find((r) => r.schedule_id === "codemaster-run-id-retention")!
      .next_run_at.toISOString()).toBe("2026-06-11T03:00:00.000Z");
  });

  it("(4) PARITY: an enqueued 'run_id_retention' job through one cycle chains close → retire → delete with the scheduled TTLs", async () => {
    const seed = await seedRetentionFixtures();
    // Fake GitHub client (the close sweep's only egress): GET lists ONE open PR on the stale branch;
    // PATCH records the close. Structural { get, patch } slice — the exact surface the PR-closer touches.
    const getCalls: Array<string> = [];
    const patchCalls: Array<{ path: string; body: unknown }> = [];
    const fakeGithub = {
      get: async (path: string): Promise<{ status: number; headers: Record<string, string>; body_text: string }> => {
        getCalls.push(path);
        return { status: 200, headers: {}, body_text: JSON.stringify([{ number: 41 }]) };
      },
      patch: async (
        path: string,
        opts: { installationId: number; jsonBody?: unknown },
      ): Promise<{ status: number; headers: Record<string, string>; body_text: string }> => {
        patchCalls.push({ path, body: opts.jsonBody });
        return { status: 200, headers: {}, body_text: "" };
      },
    } as unknown as GitHubApiClient;

    try {
      // OWN registry with the fake client injected (production omits it → deferred-Vault client).
      const registry = new HandlerRegistry();
      registerCronHandlers(registry, { dsn: INTEGRATION_DSN!, retentionGithubClient: fakeGithub });
      const repo = new BackgroundJobsRepo(db);
      const jobId = await repo.enqueue({
        jobType: "run_id_retention",
        payload: { prTtlDays: 7, runTtlDays: 30, eventTtlDays: 90 }, // the CRON_SCHEDULES input shape
      });
      const r = await runOneBackgroundJob({
        repo, registry, clock: new WallClock(),
        owner: TEST_CONFIG.owner, leaseS: TEST_CONFIG.leaseS, heartbeatS: TEST_CONFIG.heartbeatS,
        maxRuntimeS: TEST_CONFIG.maxRuntimeS,
      });
      expect(r.outcome).toBe("done");
      expect(r.jobId).toBe(jobId);
      expect((await repo.getById(jobId))!.state).toBe("done");

      // Sweep 1 (close): the stale ephemeral PR was listed by head filter + PATCH-closed, and the
      // retention.smoke_pr.closed audit row landed under the tenant's installation_id.
      expect(getCalls).toHaveLength(1);
      expect(getCalls[0]).toContain(`/repos/${seed.fullName}/pulls?head=acme:${seed.branchName}`);
      expect(patchCalls).toEqual([
        { path: `/repos/${seed.fullName}/pulls/41`, body: { state: "closed" } },
      ]);
      const closeAudits = await sql<{ n: string }>`
        SELECT COUNT(*) AS n FROM audit.audit_events
         WHERE installation_id = ${seed.installationId} AND action = 'retention.smoke_pr.closed'`.execute(db);
      expect(Number(closeAudits.rows[0]!.n)).toBe(1);
      // The 10d ephemeral run is OUTSIDE the 30d retire window: closed but NOT retired (sweep
      // independence — close eligibility ≠ retire eligibility).
      const eph = await sql<{ retired_at: Date | null }>`
        SELECT retired_at FROM core.review_runs WHERE run_id = ${seed.ephemeralRunId}`.execute(db);
      expect(eph.rows[0]!.retired_at).toBeNull();

      // Sweep 2 (retire): the 40d terminal run was soft-deleted with the ttl_expired reason.
      const old = await sql<{ retired_at: Date | null; retention_reason: string | null }>`
        SELECT retired_at, retention_reason FROM core.review_runs WHERE run_id = ${seed.oldRunId}`.execute(db);
      expect(old.rows[0]!.retired_at).not.toBeNull();
      expect(old.rows[0]!.retention_reason).toBe("ttl_expired");

      // Sweep 3 (delete): the 100d workflow_event was hard-deleted.
      const evt = await sql<{ n: string }>`
        SELECT COUNT(*) AS n FROM audit.workflow_events WHERE event_id = ${seed.agedEventId}`.execute(db);
      expect(Number(evt.rows[0]!.n)).toBe(0);
    } finally {
      await cleanupRetentionFixtures(seed);
    }
  });

  it("(5) OH7: a close-sweep fault does NOT abort retire + delete — both pure-DB sweeps still run; the attempt still fails for redrive", async () => {
    const seed = await seedRetentionFixtures();
    // The close sweep's GitHub egress hard-fails — pre-OH7 this aborted the WHOLE chain, so retire
    // + delete (pure-DB, zero dependency on close) silently skipped for the day and terminal runs
    // + aged events accumulated unbounded.
    const failingGithub = {
      get: async (): Promise<never> => {
        throw new Error("synthetic GitHub outage (OH7)");
      },
      patch: async (): Promise<never> => {
        throw new Error("synthetic GitHub outage (OH7)");
      },
    } as unknown as GitHubApiClient;

    try {
      const registry = new HandlerRegistry();
      registerCronHandlers(registry, { dsn: INTEGRATION_DSN!, retentionGithubClient: failingGithub });
      const repo = new BackgroundJobsRepo(db);
      const jobId = await repo.enqueue({
        jobType: "run_id_retention",
        payload: { prTtlDays: 7, runTtlDays: 30, eventTtlDays: 90 },
      });
      const r = await runOneBackgroundJob({
        repo, registry, clock: new WallClock(),
        owner: TEST_CONFIG.owner, leaseS: TEST_CONFIG.leaseS, heartbeatS: TEST_CONFIG.heartbeatS,
        maxRuntimeS: TEST_CONFIG.maxRuntimeS,
      });
      // The attempt FAILS (the redrive keeps re-attempting the close sweep on the backoff curve) …
      expect(r.outcome).toBe("failed");
      const job = await repo.getById(jobId);
      expect(job!.state).toBe("ready"); // re-enqueued, not dead (attempts remain)
      expect(job!.last_error).toContain("close");

      // … but the RETIRE sweep still ran: the 40d terminal run was soft-deleted …
      const old = await sql<{ retired_at: Date | null; retention_reason: string | null }>`
        SELECT retired_at, retention_reason FROM core.review_runs WHERE run_id = ${seed.oldRunId}`.execute(db);
      expect(old.rows[0]!.retired_at).not.toBeNull();
      expect(old.rows[0]!.retention_reason).toBe("ttl_expired");

      // … and the DELETE sweep still ran: the 100d workflow_event is gone.
      const evt = await sql<{ n: string }>`
        SELECT COUNT(*) AS n FROM audit.workflow_events WHERE event_id = ${seed.agedEventId}`.execute(db);
      expect(Number(evt.rows[0]!.n)).toBe(0);
    } finally {
      await cleanupRetentionFixtures(seed);
    }
  });
});

// ─── CRON_SCHEDULES literal shape + cadence-vocabulary fit (pure — no DB) ──────────────────────────
describe("CRON_SCHEDULES (Phase 3b W3b.2 + Phase 3d W3d.1 + Phase 3e W3e.1 + W3e.2 entries)", () => {
  it("carries the 9 entries: the 2 W3b.1 intervals + the 2 daily 02:00 crons + run_id_retention at 03:00 + job_retention at 03:30 + installation_drift_reconcile at 04:15 UTC + the workspace_retention 5-min interval + the confluence_ingest 6-h interval", () => {
    expect(CRON_SCHEDULES).toEqual([
      { schedule_id: "codemaster-mutex-janitor", job_type: "mutex_janitor", cadence_kind: "interval", cadence_spec: "300", input: {} },
      { schedule_id: "codemaster-review-run-reaper", job_type: "review_run_reaper", cadence_kind: "interval", cadence_spec: "600", input: {} },
      { schedule_id: "codemaster-mark-stale-chunks", job_type: "mark_stale_chunks", cadence_kind: "cron", cadence_spec: "0 2 * * *", input: {} },
      { schedule_id: "codemaster-partition-maintenance", job_type: "partition_maintenance", cadence_kind: "cron", cadence_spec: "0 2 * * *", input: {} },
      // W3d.1: schedule_id + cadence + TTL input byte-identical with the Temporal Schedule
      // (run_id_retention.workflow.ts: RUN_ID_RETENTION_SCHEDULE_ID / _CRON / _DEFAULT_INPUT).
      { schedule_id: "codemaster-run-id-retention", job_type: "run_id_retention", cadence_kind: "cron", cadence_spec: "0 3 * * *", input: { prTtlDays: 7, runTtlDays: 30, eventTtlDays: 90 } },
      // W3e.1: schedule_id + cadence byte-identical with the Temporal workspace-retention Schedule
      // (workspace_retention.workflow.ts: "codemaster-workspace-retention", every 5 min, overlap=SKIP).
      { schedule_id: "codemaster-workspace-retention", job_type: "workspace_retention", cadence_kind: "interval", cadence_spec: "300", input: {} },
      // W3e.2: cadence parity with the Temporal confluence-sync Schedule (confluence_ingest.workflow.ts:
      // CONFLUENCE_SYNC_INTERVAL_SECONDS = 6h, overlap=SKIP); schedule_id renamed onto the codemaster-
      // operator-correlation prefix (the mark-stale precedent — Temporal id "refresh-confluence-corpus").
      { schedule_id: "codemaster-confluence-ingest", job_type: "confluence_ingest", cadence_kind: "interval", cadence_spec: "21600", input: {} },
      // W4.6 (L4+L5): NET-NEW platform cron (no Temporal predecessor) — the terminal-job-row +
      // idempotency-ledger janitor, 03:30 UTC, TTLs pinned in the input (the run_id_retention posture).
      { schedule_id: "codemaster-job-retention", job_type: "job_retention", cadence_kind: "cron", cadence_spec: "30 3 * * *", input: { reviewJobsTtlDays: 30, backgroundJobsTtlDays: 30 } },
      // W3.6 (RH12): NET-NEW self-heal cron (no Temporal predecessor) — the installation
      // drift-reconcile sweep, 04:15 UTC, zero-config (walk bound + cooldown are activity/env-owned).
      { schedule_id: "codemaster-installation-drift-reconcile", job_type: "installation_drift_reconcile", cadence_kind: "cron", cadence_spec: "15 4 * * *", input: {} },
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
    // Same daily semantics for the 03:00 run_id_retention spec.
    expect(computeNextRun("cron", "0 3 * * *", after).toISOString()).toBe("2026-06-10T03:00:00.000Z");
    expect(computeNextRun("cron", "0 3 * * *", new Date("2026-06-10T03:00:00.000Z")).toISOString())
      .toBe("2026-06-11T03:00:00.000Z");
  });
});
