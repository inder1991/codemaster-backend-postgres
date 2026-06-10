// Phase 3a W4: the background-runner PROCESS ENTRYPOINT composition (background_runner_main.ts) —
// buildBackgroundRunner wires HandlerRegistry + BackgroundRunnerLoop + SchedulerLoop over ONE shared
// db/clock/repo (the ADR-0062 single-pool seam in prod; the test injects its own Kysely). Proves:
//   (1) buildBackgroundRunner() returns the three composed pieces; the registry boots with the
//       W3b.1 cron handlers pre-registered (mutex_janitor / review_run_reaper — later Phase 3b
//       waves append to it as the workflow migrations land);
//   (2) END-TO-END composition: a fake handler registered on the RETURNED registry + a directly
//       enqueued job + a DUE schedule → ONE scheduler poll (pollOnce) enqueues the scheduled job
//       (dedup_key = schedule_id) and TWO runner cycles (runOneCycle) dispatch BOTH jobs through the
//       returned registry to 'done' — driven as SINGLE cycles, never the infinite loops;
//   (3) both loops run concurrently and stop() drains both promptly (the runBackgroundRunner
//       SIGINT/SIGTERM shutdown shape, minus the process-signal plumbing);
//   (4) resolveBackgroundRunnerConfig: DSN fail-loud, sensible defaults, env overrides, garbage refused.
//
// Determinism note: the scheduler poll + config tests are FakeClock/pure. The runner cycles run under
// a WallClock composition (the W2b suite's proven pattern) because runOneBackgroundJob's hard-timeout
// race is microtask-ordered under FakeClock (FakeClock.sleep resolves instantly, so the runtime
// ceiling could fire before an instant handler's `.then` chain settles) — generous ceilings (60s vs a
// ms-fast handler) keep the outcome deterministic without any timing sensitivity.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { FakeClock, WallClock } from "#platform/clock.js";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { BackgroundRunnerLoop } from "#backend/runner/background_runner.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import { OutboxDispatcherLoop } from "#backend/runner/outbox_dispatcher_loop.js";
import { SchedulerLoop } from "#backend/runner/scheduler.js";
import {
  buildBackgroundRunner,
  resolveBackgroundRunnerConfig,
  type BackgroundRunnerConfig,
} from "#backend/runner/background_runner_main.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });          // destroys the OWN pool; no disposePool double-end

// AUTHORIZED DEVIATION (test isolation — same rationale as scheduler.integration.test.ts):
// vitest.config.ts shuffles test order, and claim()/pollAndEnqueue() are cross-job_type scans over ALL
// core.background_jobs / core.scheduled_jobs rows; per-test wipes keep claim targets + enqueue counts
// exact. Safe because test:integration runs --no-file-parallelism (files never interleave) and the
// other writers (the W2a/W2b/W3 suites) clean their own rows.
beforeEach(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.background_jobs`.execute(db);
    await sql`DELETE FROM core.scheduled_jobs`.execute(db);
  }
});

/** Bounded test config: generous ceilings (ms-fast handlers never graze them), huge sleeps (test (3)
 *  proves stop() interrupts them rather than waiting them out). */
const TEST_CONFIG: BackgroundRunnerConfig = {
  owner: "w4-main-test", leaseS: 2, heartbeatS: 0.2, maxRuntimeS: 60, idleS: 30, pollIntervalS: 600,
  outboxIdleS: 600, outboxMaxAttempts: 5,
};

/** Per-test-unique ids so assertions are traceable to the test that minted the rows. */
function mintIds(): { scheduleId: string; jobType: string } {
  const tag = randomUUID();
  return { scheduleId: `w4-sched-${tag}`, jobType: `w4-job-${tag}` };
}

/** Direct INSERT into core.scheduled_jobs (same shape as the W3 suite's seedSchedule). */
async function seedSchedule(opts: {
  scheduleId: string; jobType: string; cadenceSpec: string; input: Record<string, unknown>; nextRunAt: Date;
}): Promise<void> {
  await sql`INSERT INTO core.scheduled_jobs
      (schedule_id, job_type, cadence_kind, cadence_spec, input, enabled, next_run_at)
    VALUES (${opts.scheduleId}, ${opts.jobType}, 'interval', ${opts.cadenceSpec},
            CAST(${JSON.stringify(opts.input)} AS jsonb), true, ${opts.nextRunAt})`.execute(db);
}

describeDb("background_runner_main — buildBackgroundRunner composition (Phase 3a W4)", () => {
  it("(1) returns the composed pieces; the registry boots with the W3b.1 cron handlers pre-registered", () => {
    const handles = buildBackgroundRunner({ db, clock: new FakeClock(), config: TEST_CONFIG });
    expect(handles.runnerLoop).toBeInstanceOf(BackgroundRunnerLoop);
    expect(handles.schedulerLoop).toBeInstanceOf(SchedulerLoop);
    // Phase 3c: the outbox drain loop composes over the SAME shared db/clock; its drain behavior is
    // proven in outbox_dispatcher_loop.integration.test.ts (driving the REAL dispatchRow here would
    // route leftover rows into the real sink registry).
    expect(handles.outboxLoop).toBeInstanceOf(OutboxDispatcherLoop);
    expect(typeof handles.drainOutboxOnce).toBe("function");
    expect(handles.registry).toBeInstanceOf(HandlerRegistry);
    // W3b.1 + W3b.2: the 2 interval + 2 daily crons; W3d.1: the run_id_retention daily cron + the
    // 3 reconcile EVENT-DRIVEN handlers; W3d.2: the 2 knowledge-producer EVENT-DRIVEN handlers
    // (sync_code_owners / refresh_semantic_docs); W3e.1: the workspace_retention multi-step interval
    // cron. Later Phase 3e waves append here.
    expect([...handles.registry.registeredTypes()].sort()).toEqual([
      "mark_stale_chunks", "mutex_janitor", "partition_maintenance",
      "reconcile_installation", "reconcile_repositories", "refresh_semantic_docs",
      "repair_installation_repositories", "review_run_reaper", "run_id_retention",
      "sync_code_owners", "workspace_retention",
    ]);
  });

  it("(2) END-TO-END: one poll enqueues the due schedule's job; runner cycles dispatch BOTH jobs through the returned registry to 'done'", async () => {
    const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
    const repo = new BackgroundJobsRepo(db); // producer-side seam (direct enqueue) + row assertions
    const { scheduleId, jobType } = mintIds();

    // A fake handler registered on the RETURNED registry — the runner cycle must dispatch through it.
    const seen: Array<{ payload: unknown; jobId: string; abortedAtEntry: boolean }> = [];
    handles.registry.register(jobType, async (payload, signal, deps) => {
      seen.push({ payload, jobId: deps.job.job_id, abortedAtEntry: signal.aborted });
    });

    // A DUE schedule (next_run_at in the past) + a directly enqueued job of the same job_type.
    await seedSchedule({ scheduleId, jobType, cadenceSpec: "300", input: { source: "schedule", n: 7 },
      nextRunAt: new Date(Date.now() - 1000) });
    const directId = await repo.enqueue({ jobType, payload: { source: "direct", n: 1 } });

    // ONE scheduler poll → the scheduled job lands (dedup_key = schedule_id) + the cadence advanced.
    expect(await handles.pollOnce()).toBe(1);
    const scheduled = await sql<{ job_id: string; job_type: string; state: string }>`
      SELECT job_id, job_type, state FROM core.background_jobs
       WHERE dedup_key = ${scheduleId}`.execute(db);
    expect(scheduled.rows).toHaveLength(1);
    expect(scheduled.rows[0]!.job_type).toBe(jobType);
    expect(scheduled.rows[0]!.state).toBe("ready");
    const sched = await sql<{ last_enqueued_at: Date | null }>`
      SELECT last_enqueued_at FROM core.scheduled_jobs WHERE schedule_id = ${scheduleId}`.execute(db);
    expect(sched.rows[0]!.last_enqueued_at).toBeInstanceOf(Date);

    // TWO runner cycles (one per job; claim order is run_after-driven, so assert the SET, not the order)
    // — driven directly, never the infinite loop.
    const r1 = await handles.runOneCycle();
    const r2 = await handles.runOneCycle();
    expect(r1.outcome).toBe("done");
    expect(r2.outcome).toBe("done");
    expect(new Set([r1.jobId, r2.jobId])).toEqual(new Set([directId, scheduled.rows[0]!.job_id]));

    // The fake handler saw BOTH verified payloads, each with its claimed row's identity in deps.
    // (Structural equality, order-normalized on `source` — JSONB does not preserve key/claim order.)
    expect(seen).toHaveLength(2);
    const payloads = seen
      .map((s) => s.payload as { source: string; n: number })
      .sort((a, b) => a.source.localeCompare(b.source));
    expect(payloads).toEqual([{ source: "direct", n: 1 }, { source: "schedule", n: 7 }]);
    expect(new Set(seen.map((s) => s.jobId))).toEqual(new Set([directId, scheduled.rows[0]!.job_id]));
    expect(seen.every((s) => !s.abortedAtEntry)).toBe(true);

    // Both rows settled 'done' on disk; a THIRD cycle finds nothing (the queue is drained).
    expect((await repo.getById(directId))!.state).toBe("done");
    expect((await repo.getById(scheduled.rows[0]!.job_id))!.state).toBe("done");
    expect((await handles.runOneCycle()).outcome).toBe("idle");
  });

  it("(3) both loops run concurrently and stop() drains them promptly (the shutdown shape)", async () => {
    const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
    const t = Date.now();
    const runs = [handles.runnerLoop.run(), handles.schedulerLoop.run()];
    await new Promise((r) => setTimeout(r, 100)); // both loops are inside their idle/poll sleeps
    handles.runnerLoop.stop();
    handles.schedulerLoop.stop();
    await Promise.all(runs);
    expect(Date.now() - t).toBeLessThan(2000); // interrupted idleS=30 / pollIntervalS=600, not waited out
  }, 10_000);
});

// ─── resolveBackgroundRunnerConfig — pure env parsing (no DB) ────────────────────────────────────
describe("resolveBackgroundRunnerConfig", () => {
  it("fails LOUD when CODEMASTER_PG_CORE_DSN is unset or empty", () => {
    expect(() => resolveBackgroundRunnerConfig({})).toThrow(/CODEMASTER_PG_CORE_DSN/);
    expect(() => resolveBackgroundRunnerConfig({ CODEMASTER_PG_CORE_DSN: "" })).toThrow(/CODEMASTER_PG_CORE_DSN/);
  });

  it("applies the documented defaults and a per-process owner identity", () => {
    const { dsn, config } = resolveBackgroundRunnerConfig({ CODEMASTER_PG_CORE_DSN: "postgresql://x/y" });
    expect(dsn).toBe("postgresql://x/y");
    expect(config.leaseS).toBe(60);
    expect(config.heartbeatS).toBe(15);
    expect(config.maxRuntimeS).toBe(900);
    expect(config.idleS).toBe(5);
    expect(config.pollIntervalS).toBe(30);
    expect(config.outboxIdleS).toBe(2);       // the workflow's DEFAULT_DRAIN_INTERVAL_SECONDS
    expect(config.outboxMaxAttempts).toBe(5); // parity with build_outbox_activities.ts
    expect(config.owner).toMatch(/^bg-runner-/); // hostname+pid — traceable to the pod, no random seam
  });

  it("honors env overrides and refuses non-positive / non-numeric values", () => {
    const { config } = resolveBackgroundRunnerConfig({
      CODEMASTER_PG_CORE_DSN: "postgresql://x/y",
      CODEMASTER_BG_LEASE_S: "120", CODEMASTER_BG_HEARTBEAT_S: "30", CODEMASTER_BG_MAX_RUNTIME_S: "1800",
      CODEMASTER_BG_IDLE_S: "2.5", CODEMASTER_BG_SCHEDULER_POLL_S: "10",
      CODEMASTER_BG_OUTBOX_IDLE_S: "7", CODEMASTER_OUTBOX_MAX_ATTEMPTS: "3",
    });
    expect(config).toMatchObject({ leaseS: 120, heartbeatS: 30, maxRuntimeS: 1800, idleS: 2.5, pollIntervalS: 10,
      outboxIdleS: 7, outboxMaxAttempts: 3 });
    expect(() => resolveBackgroundRunnerConfig({ CODEMASTER_PG_CORE_DSN: "postgresql://x/y",
      CODEMASTER_BG_LEASE_S: "0" })).toThrow(/CODEMASTER_BG_LEASE_S/);
    expect(() => resolveBackgroundRunnerConfig({ CODEMASTER_PG_CORE_DSN: "postgresql://x/y",
      CODEMASTER_BG_IDLE_S: "soon" })).toThrow(/CODEMASTER_BG_IDLE_S/);
    // The dead-letter threshold must be a positive INTEGER (a fractional / zero threshold would
    // silently never dead-letter or dead-letter instantly).
    expect(() => resolveBackgroundRunnerConfig({ CODEMASTER_PG_CORE_DSN: "postgresql://x/y",
      CODEMASTER_OUTBOX_MAX_ATTEMPTS: "2.5" })).toThrow(/CODEMASTER_OUTBOX_MAX_ATTEMPTS/);
    expect(() => resolveBackgroundRunnerConfig({ CODEMASTER_PG_CORE_DSN: "postgresql://x/y",
      CODEMASTER_OUTBOX_MAX_ATTEMPTS: "0" })).toThrow(/CODEMASTER_OUTBOX_MAX_ATTEMPTS/);
  });
});
