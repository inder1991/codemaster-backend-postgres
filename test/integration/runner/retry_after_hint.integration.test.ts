// CS4.4 (H3/RC6/XH2 — minimal cutover slice): rate-limit `Retry-After`/`resetAt` hints are plumbed
// into `run_after` WITHOUT burning an attempt. The GitHub client raises GitHubRateLimitExceeded
// carrying resetAt + retryAfterSeconds (api_client.ts) and the Bedrock adapter maps throttling to
// LlmRateLimitError — today both fall through the generic markFailed exponential-backoff curve
// (1s→2s→4s), so a routine throttle window dead-letters the job in ~7s while the limit is still in
// force (and the tight retries deepen GitHub secondary-limit penalties platform-wide). The fix:
// BOTH runners' settle seams classify a throttle fault BEFORE the transient markFailed path and
// route it to a fenced deferRetry — state 'ready', run_after = the hint (capped at 1 h against a
// poisoned/skewed hint), attempts DECREMENTED back (the claim's increment is un-burned: a throttle
// is not a failure of the work). A throttle can therefore never dead-letter a job, even on its
// "last" attempt — only real failures consume the bounded budget.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5439 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import { runOneBackgroundJob } from "#backend/runner/background_runner.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { runOneJob } from "#backend/runner/review_job_runner.js";
import { GitHubRateLimitExceeded } from "#backend/integrations/github/api_client.js";
import { LlmRateLimitError } from "#backend/integrations/llm/errors.js";
import { WallClock } from "#platform/clock.js";
import { minimalReviewPayload, readRun, seedRunWithState } from "./_fixtures.js";

const clock = new WallClock();

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });

// AUTHORIZED DEVIATION (test isolation — same rationale as background_runner_permanent_error /
// review_job_runner): claim() is a cross-job_type scan; per-test wipes keep claim targets exact.
// Safe because test:integration runs --no-file-parallelism.
beforeEach(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.background_jobs`.execute(db);
    await sql`DELETE FROM core.review_jobs`.execute(db);
  }
});

/** Per-test-unique job_type so assertions are traceable to the test that minted the row. */
function jobType(): string { return `cs44-test-${randomUUID()}`; }

const RUN = { clock, owner: "w1", leaseS: 30, heartbeatS: 5, maxRuntimeS: 60 } as const;

async function readBackgroundJob(jobId: string): Promise<{
  state: string; attempts: number; run_after: Date; dead_reason: string | null; last_error: string | null;
}> {
  const r = await pool.query<{
    state: string; attempts: number; run_after: Date; dead_reason: string | null; last_error: string | null;
  }>(`SELECT state, attempts, run_after, dead_reason, last_error FROM core.background_jobs WHERE job_id = $1`, [jobId]);
  return r.rows[0]!;
}

describeDb("runOneBackgroundJob — Retry-After/resetAt hint → run_after, NO attempt burn (CS4.4)", () => {
  it("(R1) GitHubRateLimitExceeded: re-enqueued 'ready' at resetAt; attempts NOT incremented", async () => {
    const repo = new BackgroundJobsRepo(db);
    const registry = new HandlerRegistry();
    const jt = jobType();
    const before = Date.now();
    const resetAt = new Date(before + 300_000); // primary window resets 5 min out
    registry.register(jt, async () => {
      throw new GitHubRateLimitExceeded("rate limited", { resource: "core", resetAt });
    });
    const id = await repo.enqueue({ jobType: jt, payload: { x: 1 }, maxAttempts: 3 });

    const res = await runOneBackgroundJob({ repo, registry, ...RUN });
    expect(res.outcome).toBe("failed");
    expect(res.jobId).toBe(id);

    const job = await readBackgroundJob(id);
    expect(job.state).toBe("ready");                         // deferred, NOT dead
    expect(job.attempts).toBe(0);                            // the claim's increment was un-burned
    expect(job.dead_reason).toBeNull();
    expect(job.last_error).toContain("rate limited");        // the throttle is still visible forensically
    // run_after honors the hint (not the ~1s exponential backoff): within ±15s of resetAt.
    const runAfterMs = new Date(job.run_after).getTime();
    expect(runAfterMs).toBeGreaterThan(before + 285_000);
    expect(runAfterMs).toBeLessThan(before + 315_000);
  });

  it("(R2) retryAfterSeconds takes precedence as the wait when present (secondary-limit Retry-After)", async () => {
    const repo = new BackgroundJobsRepo(db);
    const registry = new HandlerRegistry();
    const jt = jobType();
    const before = Date.now();
    registry.register(jt, async () => {
      throw new GitHubRateLimitExceeded("secondary limit", {
        resource: "core",
        resetAt: new Date(before + 3_000_000),               // a far-out reset the Retry-After overrides
        retryAfterSeconds: 120,
      });
    });
    const id = await repo.enqueue({ jobType: jt, payload: { x: 1 }, maxAttempts: 3 });
    await runOneBackgroundJob({ repo, registry, ...RUN });

    const job = await readBackgroundJob(id);
    expect(job.state).toBe("ready");
    expect(job.attempts).toBe(0);
    const runAfterMs = new Date(job.run_after).getTime();
    expect(runAfterMs).toBeGreaterThan(before + 105_000);
    expect(runAfterMs).toBeLessThan(before + 135_000);
  });

  it("(R3) LlmRateLimitError (Bedrock throttle, NO hint carried): deferred by the 60s default, attempts NOT incremented", async () => {
    const repo = new BackgroundJobsRepo(db);
    const registry = new HandlerRegistry();
    const jt = jobType();
    const before = Date.now();
    registry.register(jt, async () => { throw new LlmRateLimitError("ThrottlingException"); });
    const id = await repo.enqueue({ jobType: jt, payload: { x: 1 }, maxAttempts: 3 });
    await runOneBackgroundJob({ repo, registry, ...RUN });

    const job = await readBackgroundJob(id);
    expect(job.state).toBe("ready");
    expect(job.attempts).toBe(0);
    const runAfterMs = new Date(job.run_after).getTime();
    expect(runAfterMs).toBeGreaterThan(before + 45_000);     // NOT the ~1s generic backoff
    expect(runAfterMs).toBeLessThan(before + 75_000);
  });

  it("(R4) a throttle on the LAST attempt does NOT dead-letter (the defer path bypasses exhaustion)", async () => {
    const repo = new BackgroundJobsRepo(db);
    const registry = new HandlerRegistry();
    const jt = jobType();
    registry.register(jt, async () => {
      throw new GitHubRateLimitExceeded("rate limited", { resource: "core", resetAt: new Date(Date.now() + 60_000) });
    });
    const id = await repo.enqueue({ jobType: jt, payload: { x: 1 }, maxAttempts: 1 });
    await runOneBackgroundJob({ repo, registry, ...RUN });

    const job = await readBackgroundJob(id);
    expect(job.state).toBe("ready");                         // a throttle NEVER kills the job
    expect(job.attempts).toBe(0);
    expect(job.dead_reason).toBeNull();
  });

  it("(R5) a poisoned/skewed hint is capped at 1h — run_after never parks a job for hours", async () => {
    const repo = new BackgroundJobsRepo(db);
    const registry = new HandlerRegistry();
    const jt = jobType();
    const before = Date.now();
    registry.register(jt, async () => {
      throw new GitHubRateLimitExceeded("rate limited", {
        resource: "core",
        resetAt: new Date(before + 86_400_000),              // 24h out — beyond any real GitHub window
      });
    });
    const id = await repo.enqueue({ jobType: jt, payload: { x: 1 }, maxAttempts: 3 });
    await runOneBackgroundJob({ repo, registry, ...RUN });

    const job = await readBackgroundJob(id);
    expect(job.state).toBe("ready");
    const runAfterMs = new Date(job.run_after).getTime();
    expect(runAfterMs).toBeLessThan(before + 3_700_000);     // ≤ ~1h, not 24h
    expect(runAfterMs).toBeGreaterThan(before + 3_500_000);  // but it DID take the cap, not the 1s backoff
  });
});

describeDb("runOneJob (review_jobs) — Retry-After hint → run_after, NO attempt burn, run stays RUNNING (CS4.4)", () => {
  it("(R6) GitHubRateLimitExceeded on the last attempt: job deferred 'ready' at the hint, run STAYS RUNNING", async () => {
    const repo = new ReviewJobsRepo(db);
    const s = await seedRunWithState(db, "RUNNING");
    const before = Date.now();
    const id = await repo.enqueue({ ...s, maxAttempts: 1, payload: minimalReviewPayload(s) });

    const res = await runOneJob({ repo, clock, owner: "w1", leaseS: 30, heartbeatS: 5, maxRuntimeS: 60,
      handler: async () => {
        throw new GitHubRateLimitExceeded("rate limited", { resource: "core", resetAt: new Date(before + 300_000) });
      } });
    expect(res.outcome).toBe("failed");

    const r = await pool.query<{ state: string; attempts: number; run_after: Date; dead_reason: string | null }>(
      `SELECT state, attempts, run_after, dead_reason FROM core.review_jobs WHERE job_id = $1`, [id]);
    const job = r.rows[0]!;
    expect(job.state).toBe("ready");                         // NOT dead — maxAttempts=1 did not exhaust it
    expect(job.attempts).toBe(0);                            // un-burned
    expect(job.dead_reason).toBeNull();
    const runAfterMs = new Date(job.run_after).getTime();
    expect(runAfterMs).toBeGreaterThan(before + 285_000);
    expect(runAfterMs).toBeLessThan(before + 315_000);

    // The run was NOT settled FAILED — the review resumes when the window reopens.
    expect((await readRun(db, s.runId)).lifecycle_state).toBe("RUNNING");
  });
});
