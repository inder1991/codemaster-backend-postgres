// Phase 3a W2b: the GENERIC background runner — handler registry + claim/dispatch/settle loop, the
// 1:1 generalization (over job_type) of the PROVEN review_jobs runner (review_job_runner.ts):
//   * runOneBackgroundJob: claim → verifyPayload → registry-dispatch → settle, with the hard-timeout
//     race + the F4 orphan observer (a handler that ignores the abort signal can NEVER hang the slot
//     nor escape as an unhandled rejection).
//   * NO registered handler for a claimed job_type → DEAD-LETTER (terminalSettle, dead_reason
//     "no handler for <job_type>") + a bounded metric — NOT retried forever.
//   * BackgroundRunnerLoop: claim-or-idle, reapStuckRuns on idle, cancellableSleep, stop() drains.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import { BackgroundRunnerLoop, runOneBackgroundJob } from "#backend/runner/background_runner.js";
import { WallClock } from "#platform/clock.js";

// ── Metric spies (vi.mock is hoisted; the runner imports these by name, so overriding the module
// exports lets the test PROVE the F4 orphan observer + the no-handler dead-letter counter fired). ──
const { orphanSpy, noHandlerSpy } = vi.hoisted(() => ({ orphanSpy: vi.fn(), noHandlerSpy: vi.fn() }));
vi.mock("#backend/runner/runner_metrics.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>(); // pass-through; only the two spies are overridden
  return { ...actual, recordHandlerOrphanSettled: orphanSpy, recordNoHandlerDeadLetter: noHandlerSpy };
});

const clock = new WallClock();

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });          // destroys the OWN pool; no disposePool double-end

// AUTHORIZED DEVIATION (test isolation — same rationale as background_jobs_repo.integration.test.ts):
// vitest.config.ts shuffles test order, and claim()/reapStuckRuns() are CROSS-TENANT, cross-job_type
// scans over ALL core.background_jobs rows. Without per-test cleanup a prior (shuffled) test's leftover
// 'ready'/'leased' job gets claimed instead of the just-enqueued one and flakes the outcome assertions.
// Safe because test:integration runs --no-file-parallelism (files never interleave).
beforeEach(async () => {
  if (INTEGRATION_DSN) await sql`DELETE FROM core.background_jobs`.execute(db);
  orphanSpy.mockClear(); noHandlerSpy.mockClear();
});

/** Per-test-unique job_type so assertions are traceable to the test that minted the row. */
function jobType(): string { return `w2b-test-${randomUUID()}`; }

// ─── HandlerRegistry semantics (pure, no DB) ─────────────────────────────────────────────────────
describe("HandlerRegistry", () => {
  it("register/get round-trips; an unregistered job_type yields undefined", () => {
    const registry = new HandlerRegistry();
    const handler = async (): Promise<void> => {};
    registry.register("a.job", handler);
    expect(registry.get("a.job")).toBe(handler);
    expect(registry.get("not.registered")).toBeUndefined();
  });
  it("a DUPLICATE registration for the same job_type throws (fail-loud at the composition root)", () => {
    const registry = new HandlerRegistry();
    registry.register("a.job", async () => {});
    expect(() => registry.register("a.job", async () => {})).toThrow(/duplicate/i);
  });
  it("an EMPTY job_type is refused at registration", () => {
    const registry = new HandlerRegistry();
    expect(() => registry.register("", async () => {})).toThrow(/non-empty/i);
  });
});

// ─── runOneBackgroundJob — claim → dispatch → settle ─────────────────────────────────────────────
describeDb("runOneBackgroundJob", () => {
  it("dispatches the registered handler with the VERIFIED payload + signal + deps, and settles done", async () => {
    const repo = new BackgroundJobsRepo(db);
    const registry = new HandlerRegistry();
    const jt = jobType();
    const payload = { b: 2, a: 1, nested: { y: [3, 1, 2] } };
    const calls: Array<{ payload: unknown; abortedAtEntry: boolean; depJobId: string; depJobType: string }> = [];
    registry.register(jt, async (p, signal, deps) => {
      calls.push({ payload: p, abortedAtEntry: signal.aborted, depJobId: deps.job.job_id, depJobType: deps.job.job_type });
    });
    const id = await repo.enqueue({ jobType: jt, payload });

    const res = await runOneBackgroundJob({ repo, registry, clock, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60 });
    expect(res.outcome).toBe("done");
    expect(res.jobId).toBe(id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload).toEqual(payload);            // verifyPayload round-tripped the stored bytes
    expect(calls[0]!.abortedAtEntry).toBe(false);
    expect(calls[0]!.depJobId).toBe(id);                   // deps carry the claimed row (job context)
    expect(calls[0]!.depJobType).toBe(jt);
    const job = await repo.getById(id);
    expect(job!.state).toBe("done");
    expect(job!.finished_at).toBeInstanceOf(Date);
  });

  it("reports idle when no job is ready", async () => {
    const repo = new BackgroundJobsRepo(db);
    const res = await runOneBackgroundJob({ repo, registry: new HandlerRegistry(), clock, owner: "w1",
      leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60 });
    expect(res.outcome).toBe("idle");
  });

  it("DEAD-LETTERS a claimed job whose job_type has NO registered handler (NOT retried forever) + bounded metric", async () => {
    const repo = new BackgroundJobsRepo(db);
    const jt = jobType();                                  // NEVER registered
    const id = await repo.enqueue({ jobType: jt, payload: { x: 1 }, maxAttempts: 3 });

    const res = await runOneBackgroundJob({ repo, registry: new HandlerRegistry(), clock, owner: "w1",
      leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60 });
    expect(res.outcome).toBe("no_handler");
    expect(res.jobId).toBe(id);
    const job = await repo.getById(id);
    expect(job!.state).toBe("dead");                       // terminal DESPITE attempts remaining (1 < max 3)
    expect(job!.dead_reason).toBe(`no handler for ${jt}`);
    expect(job!.finished_at).toBeInstanceOf(Date);
    expect(noHandlerSpy).toHaveBeenCalledTimes(1);
    // Terminal: claim() never re-drives a dead job — the unknown type cannot retry-loop.
    expect(await repo.claim({ owner: "w2", leaseMs: 1000, maxRuntimeMs: 60_000 })).toBeNull();
  });

  it("a handler that throws is RETRIED (markFailed → ready + last_error) then dead at exhaustion", async () => {
    const repo = new BackgroundJobsRepo(db);
    const registry = new HandlerRegistry();
    const jt = jobType();
    registry.register(jt, async () => { throw new Error("boom"); });
    const id = await repo.enqueue({ jobType: jt, payload: { x: 1 }, maxAttempts: 2 });

    // Attempt 1 → markFailed re-enqueues (attempts 1 < max 2): state ready, last_error persisted.
    const r1 = await runOneBackgroundJob({ repo, registry, clock, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60 });
    expect(r1.outcome).toBe("failed");
    const requeued = await repo.getById(id);
    expect(requeued!.state).toBe("ready");
    expect(requeued!.attempts).toBe(1);
    expect(requeued!.last_error).toBe("boom");
    expect(requeued!.dead_reason).toBeNull();              // NOT terminal yet

    // Clear the jittered backoff out-of-band (deterministic — no sleep flakiness).
    // tenant:exempt reason=test-fixture-clears-backoff-by-pk follow_up=FOLLOW-UP-gf3-error-mode
    await sql`UPDATE core.background_jobs SET run_after = now() WHERE job_id = ${id}`.execute(db);

    // Attempt 2 (== max) → markFailed dead-letters atomically: dead + dead_reason + finished_at.
    const r2 = await runOneBackgroundJob({ repo, registry, clock, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60 });
    expect(r2.outcome).toBe("failed");
    const dead = await repo.getById(id);
    expect(dead!.state).toBe("dead");
    expect(dead!.attempts).toBe(2);
    expect(dead!.last_error).toBe("boom");
    expect(dead!.dead_reason).toBe("boom");
    expect(dead!.finished_at).toBeInstanceOf(Date);
  });

  it("HARD-stops a handler that ignores the signal and overruns maxRuntimeS: outcome failed, slot returns, F4 orphan observer fires", async () => {
    const repo = new BackgroundJobsRepo(db);
    const registry = new HandlerRegistry();
    const jt = jobType();
    registry.register(jt, () => new Promise(() => {}));    // never resolves, ignores the abort signal
    const id = await repo.enqueue({ jobType: jt, payload: { x: 1 }, maxAttempts: 1 });
    const t = Date.now();
    // heartbeatS huge → the heartbeat NEVER refuses within the test, so the hard race is the SOLE guarantee:
    const res = await runOneBackgroundJob({ repo, registry, clock, owner: "w1", leaseS: 2, heartbeatS: 999, maxRuntimeS: 0.2 });
    expect(res.outcome).toBe("failed");
    expect(Date.now() - t).toBeLessThan(2000);             // returned ~maxRuntimeS, not hung
    const job = await repo.getById(id);
    expect(job!.state).toBe("dead");                       // maxAttempts 1 → terminal on the timeout failure
    expect(job!.dead_reason).toContain("max runtime");
    expect(orphanSpy).toHaveBeenCalledTimes(1);            // F4: the orphaned handler was OBSERVED + metered
    expect(orphanSpy).toHaveBeenCalledWith({ phase: "after_hard_timeout" });
  });

  it("a corrupted payload (hash mismatch) is a POISON PILL: dead-lettered, never dispatched", async () => {
    const repo = new BackgroundJobsRepo(db);
    const registry = new HandlerRegistry();
    const jt = jobType();
    let ran = 0;
    registry.register(jt, async () => { ran++; });
    const id = await repo.enqueue({ jobType: jt, payload: { x: 1 }, maxAttempts: 3 });
    // Corrupt the stored sha so verifyPayload mismatches (the manual-edit / drift threat model).
    // tenant:exempt reason=test-corruption-of-pk-row follow_up=FOLLOW-UP-gf3-error-mode
    await sql`UPDATE core.background_jobs SET payload_sha256 = ${"f".repeat(64)} WHERE job_id = ${id}`.execute(db);

    const res = await runOneBackgroundJob({ repo, registry, clock, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60 });
    expect(res.outcome).toBe("failed");
    expect(ran).toBe(0);                                   // the handler NEVER saw drifted bytes
    const job = await repo.getById(id);
    expect(job!.state).toBe("dead");                       // terminal despite attempts remaining — retry cannot fix bytes
    expect(job!.dead_reason).toContain("payload hash mismatch");
  });
});

// ─── BackgroundRunnerLoop — claim-or-idle, reap on idle, prompt stop ─────────────────────────────
describeDb("BackgroundRunnerLoop", () => {
  it("drains the in-flight job and stops claiming new ones on stop()", async () => {
    const repo = new BackgroundJobsRepo(db);
    const registry = new HandlerRegistry();
    const jt = jobType();
    let started = 0;
    registry.register(jt, async () => { started++; await new Promise((r) => setTimeout(r, 300)); });
    const id1 = await repo.enqueue({ jobType: jt, payload: { n: 1 } });
    const id2 = await repo.enqueue({ jobType: jt, payload: { n: 2 } });
    const loop = new BackgroundRunnerLoop({ repo, registry, clock, owner: "w1", leaseS: 2, heartbeatS: 0.2,
      maxRuntimeS: 60, idleS: 0.05 });
    const run = loop.run();
    await new Promise((r) => setTimeout(r, 100)); // first job is in flight
    loop.stop();
    await run;
    expect(started).toBe(1);
    const states = [ (await repo.getById(id1))!.state, (await repo.getById(id2))!.state ].sort();
    expect(states).toEqual(["done", "ready"]); // one finished (drained), the other never claimed
  });

  it("stop() interrupts the idle wait promptly (no jobs)", async () => {
    const repo = new BackgroundJobsRepo(db);
    const loop = new BackgroundRunnerLoop({ repo, registry: new HandlerRegistry(), clock, owner: "w1",
      leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60, idleS: 30 });
    const t = Date.now(); const run = loop.run();
    await new Promise((r) => setTimeout(r, 100)); // loop is in its idle sleep
    loop.stop();
    await run;
    expect(Date.now() - t).toBeLessThan(2000); // did NOT wait the full 30s idleS
  });

  it("the idle cycle reaps stuck jobs (expired lease + attempts exhausted → dead)", async () => {
    const repo = new BackgroundJobsRepo(db);
    // A stuck row: leased, lease EXPIRED, attempts exhausted — exactly what claim() will never reclaim.
    const jt = jobType();
    const id = await repo.enqueue({ jobType: jt, payload: { x: 1 }, maxAttempts: 1 });
    const c = await repo.claim({ owner: "crashed", leaseMs: 60_000, maxRuntimeMs: 120_000 });
    expect(c?.job_id).toBe(id);
    // tenant:exempt reason=test-fixture-expires-lease-by-pk follow_up=FOLLOW-UP-gf3-error-mode
    await sql`UPDATE core.background_jobs SET leased_until = now() - interval '1 second' WHERE job_id = ${id}`.execute(db);

    const loop = new BackgroundRunnerLoop({ repo, registry: new HandlerRegistry(), clock, owner: "w1",
      leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60, idleS: 30 });
    await loop.runIdleMaintenance();
    const job = await repo.getById(id);
    expect(job!.state).toBe("dead");
    expect(job!.dead_reason).toBe("lease expired with attempts exhausted (stuck run)");
  });
});
