// Phase 4a W4a.1: permanent-failure classification at the runner's settle seam — the background-jobs
// analogue of the outbox's RetryableSinkError/PermanentSinkError split (outbox/sink_registry.ts):
//   * a handler that throws PermanentJobError → dead-lettered IMMEDIATELY (terminalSettle: state
//     'dead' + dead_reason after ONE attempt) — it does NOT burn the bounded attempts retrying a
//     fault that retry cannot fix (malformed payload / auth error — the Phase 3d concern).
//   * a handler that lets a ZodError propagate (payload fails its contract — the SAME stored bytes
//     re-parse identically on every retry) → equally dead IMMEDIATELY; no per-handler wrapping.
//   * a plain transient Error keeps the EXISTING markFailed retry/backoff curve: re-enqueued 'ready'
//     until exhaustion, then dead (unchanged behavior, pinned here against regression).
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { z } from "zod";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import { runOneBackgroundJob } from "#backend/runner/background_runner.js";
import { PermanentJobError } from "#backend/runner/errors.js";
import { WallClock } from "#platform/clock.js";

const clock = new WallClock();

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });          // destroys the OWN pool; no disposePool double-end

// AUTHORIZED DEVIATION (test isolation — same rationale as background_runner.integration.test.ts):
// vitest.config.ts shuffles test order, and claim() is a CROSS-TENANT, cross-job_type scan over ALL
// core.background_jobs rows. Without per-test cleanup a prior (shuffled) test's leftover 'ready' job
// gets claimed instead of the just-enqueued one and flakes the outcome assertions. Safe because
// test:integration runs --no-file-parallelism (files never interleave).
beforeEach(async () => {
  if (INTEGRATION_DSN) await sql`DELETE FROM core.background_jobs`.execute(db);
});

/** Per-test-unique job_type so assertions are traceable to the test that minted the row. */
function jobType(): string { return `w4a1-test-${randomUUID()}`; }

const RUN = { clock, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60 } as const;

// ─── PermanentJobError — the explicit handler-declared "do NOT retry" signal ─────────────────────
describe("PermanentJobError (pure)", () => {
  it("is an Error with a stable name and carries an optional cause", () => {
    const cause = new Error("401 bad credentials");
    const e = new PermanentJobError("github auth failed", { cause });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("PermanentJobError");
    expect(e.message).toBe("github auth failed");
    expect(e.cause).toBe(cause);
  });
});

describeDb("runOneBackgroundJob — permanent-error classification (W4a.1)", () => {
  it("a handler that throws PermanentJobError is dead-lettered after ONE attempt (no retry burn)", async () => {
    const repo = new BackgroundJobsRepo(db);
    const registry = new HandlerRegistry();
    const jt = jobType();
    let ran = 0;
    registry.register(jt, async () => { ran++; throw new PermanentJobError("auth error: retry cannot succeed"); });
    const id = await repo.enqueue({ jobType: jt, payload: { x: 1 }, maxAttempts: 3 });

    const res = await runOneBackgroundJob({ repo, registry, ...RUN });
    expect(res.outcome).toBe("failed");
    expect(res.jobId).toBe(id);
    expect(ran).toBe(1);                                   // exactly ONE dispatch — never redriven
    const job = await repo.getById(id);
    expect(job!.state).toBe("dead");                       // terminal DESPITE attempts remaining (1 < max 3)
    expect(job!.attempts).toBe(1);
    expect(job!.dead_reason).toBe("auth error: retry cannot succeed");
    expect(job!.finished_at).toBeInstanceOf(Date);
    // NOT re-enqueued 'ready': claim() never re-drives a dead job.
    expect(await repo.claim({ owner: "w2", leaseMs: 1000, maxRuntimeMs: 60_000 })).toBeNull();
  });

  it("a ZodError propagating out of a handler's payload parse is dead-lettered after ONE attempt", async () => {
    const repo = new BackgroundJobsRepo(db);
    const registry = new HandlerRegistry();
    const jt = jobType();
    const Contract = z.object({ must_be_string: z.string() });
    let ran = 0;
    registry.register(jt, async (payload) => { ran++; Contract.parse(payload); }); // ZodError propagates unwrapped
    const id = await repo.enqueue({ jobType: jt, payload: { must_be_string: 42 }, maxAttempts: 3 });

    const res = await runOneBackgroundJob({ repo, registry, ...RUN });
    expect(res.outcome).toBe("failed");
    expect(ran).toBe(1);                                   // the SAME bytes can never parse — no redrive
    const job = await repo.getById(id);
    expect(job!.state).toBe("dead");                       // terminal despite attempts remaining
    expect(job!.attempts).toBe(1);
    expect(job!.dead_reason).toContain("must_be_string");  // the ZodError message names the failed field
    expect(job!.finished_at).toBeInstanceOf(Date);
    expect(await repo.claim({ owner: "w2", leaseMs: 1000, maxRuntimeMs: 60_000 })).toBeNull();
  });

  it("a plain transient Error keeps the EXISTING retry curve: ready after attempt 1, dead at exhaustion", async () => {
    const repo = new BackgroundJobsRepo(db);
    const registry = new HandlerRegistry();
    const jt = jobType();
    registry.register(jt, async () => { throw new Error("503 transient"); });
    const id = await repo.enqueue({ jobType: jt, payload: { x: 1 }, maxAttempts: 2 });

    // Attempt 1 → markFailed re-enqueues (attempts 1 < max 2): state ready, retried — NOT dead.
    const r1 = await runOneBackgroundJob({ repo, registry, ...RUN });
    expect(r1.outcome).toBe("failed");
    const requeued = await repo.getById(id);
    expect(requeued!.state).toBe("ready");
    expect(requeued!.attempts).toBe(1);
    expect(requeued!.last_error).toBe("503 transient");
    expect(requeued!.dead_reason).toBeNull();              // NOT terminal yet

    // Clear the jittered backoff out-of-band (deterministic — no sleep flakiness).
    // tenant:exempt reason=test-fixture-clears-backoff-by-pk follow_up=FOLLOW-UP-gf3-error-mode
    await sql`UPDATE core.background_jobs SET run_after = now() WHERE job_id = ${id}`.execute(db);

    // Attempt 2 (== max) → markFailed dead-letters atomically at exhaustion (unchanged behavior).
    const r2 = await runOneBackgroundJob({ repo, registry, ...RUN });
    expect(r2.outcome).toBe("failed");
    const dead = await repo.getById(id);
    expect(dead!.state).toBe("dead");
    expect(dead!.attempts).toBe(2);
    expect(dead!.dead_reason).toBe("503 transient");
  });

  it("a PermanentJobError WRAPPING a cause dead-letters with the wrapper's message as dead_reason", async () => {
    const repo = new BackgroundJobsRepo(db);
    const registry = new HandlerRegistry();
    const jt = jobType();
    registry.register(jt, async () => {
      throw new PermanentJobError("permanent: upstream 403", { cause: new Error("403 forbidden") });
    });
    const id = await repo.enqueue({ jobType: jt, payload: { x: 1 }, maxAttempts: 5 });

    const res = await runOneBackgroundJob({ repo, registry, ...RUN });
    expect(res.outcome).toBe("failed");
    const job = await repo.getById(id);
    expect(job!.state).toBe("dead");
    expect(job!.attempts).toBe(1);
    expect(job!.dead_reason).toBe("permanent: upstream 403");
  });
});
