import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { RunnerLoop } from "#backend/runner/review_job_runner.js";
import { LlmInvocationLedger } from "#backend/integrations/llm/invocation_ledger.js";
import { FakeClock, WallClock } from "#platform/clock.js";
import { minimalReviewPayload, seedRun } from "./_fixtures.js";

const clock = new WallClock();

/** A noop ledger pruner — the existing RunnerLoop tests do not exercise the pruner, so they pass a stub. */
const NOOP_LEDGER = { pruneOlderThan: async (): Promise<number> => 0 };

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });          // destroys the OWN pool; no disposePool double-end

// AUTHORIZED DEVIATION (test isolation): vitest.config.ts shuffles test order, and the RunnerLoop's
// claim()/reapStuckRuns() are CROSS-TENANT scans over ALL core.review_jobs rows. Without per-test cleanup
// a prior (shuffled) test's leftover 'ready'/'leased' job gets claimed instead of the just-enqueued one and
// flakes the drain/idle assertions. Safe because test:integration runs --no-file-parallelism (no other file
// writes core.review_jobs concurrently) and only the runner tests write this brand-new table.
beforeEach(async () => { if (INTEGRATION_DSN) await sql`DELETE FROM core.review_jobs`.execute(db); });

describeDb("RunnerLoop", () => {
  it("drains the in-flight job and stops claiming new ones on stop()", async () => {
    const repo = new ReviewJobsRepo(db);
    const s1 = await seedRun(db); const id1 = await repo.enqueue({ ...s1, payload: minimalReviewPayload(s1) });
    const s2 = await seedRun(db); const id2 = await repo.enqueue({ ...s2, payload: minimalReviewPayload(s2) });
    let started = 0;
    const loop = new RunnerLoop({ repo, clock, ledger: NOOP_LEDGER, owner: "w1", leaseS: 2, heartbeatS: 0.2, maxRuntimeS: 60, idleS: 0.05,
      handler: async () => { started++; await new Promise((r) => setTimeout(r, 300)); } });
    const run = loop.run();
    await new Promise((r) => setTimeout(r, 100)); // first job is in flight
    loop.stop();
    await run;
    expect(started).toBe(1);
    const states = [ (await repo.getById(id1))!.state, (await repo.getById(id2))!.state ].sort();
    expect(states).toEqual(["done", "ready"]); // one finished, the other never claimed
  });
  it("stop() interrupts the idle wait promptly (no jobs)", async () => {
    const repo = new ReviewJobsRepo(db);
    const loop = new RunnerLoop({ repo, clock, ledger: NOOP_LEDGER, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60, idleS: 30,
      handler: async () => {} });
    const t = Date.now(); const run = loop.run();
    await new Promise((r) => setTimeout(r, 100)); // loop is in its idle sleep
    loop.stop();
    await run;
    expect(Date.now() - t).toBeLessThan(2000); // did NOT wait the full 30s idleS
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// W6.4 (D2) — the runner idle cycle wires the LLM-invocation-ledger retention pruner. After the
// reapStuckRuns() call in the idle branch, the loop calls pruneOlderThan(retentionDays) AT MOST ONCE
// per CODEMASTER_LLM_LEDGER_PRUNE_INTERVAL_S (default 21600 = 6h), throttled off clock.monotonic() (NO
// wall-clock read, NO raw timer). The FIRST idle cycle prunes; a subsequent cycle BEFORE the interval
// does NOT prune again; a cycle AFTER the interval prunes again. Driven against the disposable PG +
// the REAL ledger, with a counting spy over pruneOlderThan to assert the throttle. SERIAL
// (--no-file-parallelism); the per-test DELETE FROM core.review_jobs keeps claim()/reap idle.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const PRUNE_INTERVAL_S = 21600; // CODEMASTER_LLM_LEDGER_PRUNE_INTERVAL_S default (6h)

/** Insert a ledger row with an EXPLICIT created_at so the pruner's age cutoff is exercised. */
async function insertLedgerRowAt(installationId: string, key: string, createdAt: Date): Promise<void> {
  await sql`
    INSERT INTO core.llm_invocation_ledger
        (idempotency_key, installation_id, provider_response, created_at)
    VALUES
        (${key}, ${installationId}::uuid, CAST(${"{}"} AS jsonb), ${createdAt.toISOString()}::timestamptz)
  `.execute(db);
}

/** Read every ledger key for one installation_id (scope-keyed). */
async function ledgerKeys(installationId: string): Promise<Array<string>> {
  const r = await sql<{ idempotency_key: string }>`
    SELECT idempotency_key FROM core.llm_invocation_ledger WHERE installation_id = ${installationId}::uuid
  `.execute(db);
  return r.rows.map((row) => row.idempotency_key);
}

describeDb("RunnerLoop — ledger retention pruner wired to the idle cycle (W6.4 / D2)", () => {
  it("first idle cycle prunes old ledger rows; re-prunes ONLY after the throttle interval elapses", async () => {
    const repo = new ReviewJobsRepo(db);
    const installationId = randomUUID();
    const oldKey = `old-${randomUUID()}`;
    const freshKey = `fresh-${randomUUID()}`;
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);
    const oneHourAgo = new Date(now - 60 * 60 * 1000);

    // A FakeClock pins the monotonic axis so the throttle can be advanced deterministically (no wall read).
    const fakeClock = new FakeClock({ monotonicStart: 1000 });
    // The REAL ledger, wrapped in a counting spy so we observe pruneOlderThan invocations.
    const realLedger = new LlmInvocationLedger({ db });
    let pruneCalls = 0;
    const ledger = {
      async pruneOlderThan(days: number): Promise<number> {
        pruneCalls += 1;
        return realLedger.pruneOlderThan(days);
      },
    };
    const loop = new RunnerLoop({
      repo, clock: fakeClock, ledger, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60, idleS: 30,
      handler: async () => {},
    });

    try {
      await insertLedgerRowAt(installationId, oldKey, eightDaysAgo);
      await insertLedgerRowAt(installationId, freshKey, oneHourAgo);
      expect((await ledgerKeys(installationId)).sort()).toEqual([freshKey, oldKey].sort());

      // FIRST idle cycle → prunes once; the 8-day-old row is gone, the fresh row survives.
      await loop.runIdleMaintenance();
      expect(pruneCalls).toBe(1);
      expect(await ledgerKeys(installationId)).toEqual([freshKey]);

      // Re-seed an old row, then advance the monotonic clock by LESS than the interval → NO re-prune.
      const oldKey2 = `old2-${randomUUID()}`;
      await insertLedgerRowAt(installationId, oldKey2, eightDaysAgo);
      fakeClock.advance({ seconds: PRUNE_INTERVAL_S - 1 });
      await loop.runIdleMaintenance();
      expect(pruneCalls).toBe(1); // throttled — pruneOlderThan NOT called again
      expect((await ledgerKeys(installationId)).sort()).toEqual([freshKey, oldKey2].sort()); // old2 NOT pruned

      // Advance PAST the interval (cumulative >= interval since the last prune) → prunes again.
      fakeClock.advance({ seconds: 2 });
      await loop.runIdleMaintenance();
      expect(pruneCalls).toBe(2); // interval elapsed — pruned again
      expect(await ledgerKeys(installationId)).toEqual([freshKey]); // old2 now gone
    } finally {
      await sql`DELETE FROM core.llm_invocation_ledger WHERE installation_id = ${installationId}::uuid`.execute(db);
    }
  });
});
