// Attempt-failure observability (cutover smoke finding, 2026-06-11): when a handler throws, BOTH
// runners persisted only the truncated error MESSAGE (review_jobs/background_jobs.last_error) and
// logged NOTHING — diagnosing the live `base(...)[name] is not a function` review failure required
// DB spelunking and guesswork because the STACK existed nowhere. Every caught handler error must
// emit ONE structured console.error JSON record (the outbox/CS8 idiom) carrying the correlation
// keys + error_class + the STACK, so a production attempt failure is diagnosable from pod logs.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5439 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterEach, expect, it, vi } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import { runOneBackgroundJob } from "#backend/runner/background_runner.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { runOneJob } from "#backend/runner/review_job_runner.js";
import { WallClock } from "#platform/clock.js";
import { minimalReviewPayload, seedRun } from "./_fixtures.js";

const clock = new WallClock();

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterEach(async () => { vi.restoreAllMocks(); });

/** Parse every structured console.error record matching `event` out of a spy. */
function recordsOf(spy: ReturnType<typeof vi.spyOn>, event: string): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((c) => { try { return JSON.parse(String(c[0])) as Record<string, unknown>; } catch { return null; } })
    .filter((r): r is Record<string, unknown> => r !== null && r.event === event);
}

/** A throw site with a RECOGNIZABLE function name so the stack assertion is unambiguous. */
async function explodeForStackTest(): Promise<never> {
  throw new TypeError("base(...)[name] is not a function (fixture)");
}

describeDb("attempt-failure structured logging — review runner", () => {
  it("a failing review attempt emits ONE structured record with run_id + error_class + the STACK", async () => {
    await sql`DELETE FROM core.review_jobs`.execute(db);
    const repo = new ReviewJobsRepo(db);
    const s = await seedRun(db);
    await repo.enqueue({ ...s, maxAttempts: 1, payload: minimalReviewPayload(s) });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await runOneJob({ repo, clock, owner: "afl-w1", leaseS: 5, heartbeatS: 1, maxRuntimeS: 60,
      handler: async () => explodeForStackTest() });
    expect(res.outcome).toBe("failed");

    const recs = recordsOf(errSpy, "review_job.attempt_failed");
    expect(recs).toHaveLength(1);
    const r = recs[0]!;
    expect(r.run_id).toBe(s.runId);
    expect(r.error_class).toBe("TypeError");
    expect(String(r.error_msg)).toContain("is not a function");
    expect(String(r.stack)).toContain("explodeForStackTest"); // the THROW SITE is in the log
    expect(typeof r.attempts).toBe("number");
  });
});

describeDb("attempt-failure structured logging — background runner", () => {
  it("a failing background attempt emits ONE structured record with job_type + error_class + the STACK", async () => {
    await sql`DELETE FROM core.background_jobs`.execute(db);
    const repo = new BackgroundJobsRepo(db);
    const registry = new HandlerRegistry();
    const jt = `afl-${randomUUID()}`;
    registry.register(jt, async () => explodeForStackTest());
    await repo.enqueue({ jobType: jt, payload: { x: 1 }, maxAttempts: 1 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await runOneBackgroundJob({ repo, registry, clock, owner: "afl-w2", leaseS: 5, heartbeatS: 1, maxRuntimeS: 60 });
    expect(res.outcome).toBe("failed");

    const recs = recordsOf(errSpy, "background_job.attempt_failed");
    expect(recs).toHaveLength(1);
    const r = recs[0]!;
    expect(r.job_type).toBe(jt);
    expect(r.error_class).toBe("TypeError");
    expect(String(r.stack)).toContain("explodeForStackTest");
  });
});
