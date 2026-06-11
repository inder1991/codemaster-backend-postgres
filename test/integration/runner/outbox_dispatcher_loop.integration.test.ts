// Phase 3c: OutboxDispatcherLoop — the Temporal-free Postgres leased drain loop replacing the
// OutboxDispatcherWorkflow's continuous-loop body (claim a batch → dispatch + mark each row →
// idle when empty). The loop REUSES the proven Postgres-backed dispatch activities
// (OutboxDispatchActivities); this suite drives SINGLE drain passes (drainOnce — the scheduler
// pollOnce idiom), never the infinite loop, against the real DB:
//   (1) a drain pass claims the pending rows IN claim (created_at) order, dispatches each through
//       the injected dispatchRow with the EXACT workflow-parity input shape (schema_version 2,
//       tagged-union orphan_reason for NULL-installation bootstrap rows), then marks each
//       dispatched (state='dispatched', dispatched_at set, lease released);
//   (2) a row whose dispatch THROWS → the REAL markAttemptFailed (attempts+1, still 'pending',
//       last_error recorded, lease released, NOT dispatched) and the NEXT row in the SAME batch
//       still dispatches — the workflow's per-row try/catch isolation is preserved;
//   (2c-2e) RC7 (cutover-safety CS4.2) — the loop CONSUMES the sink error taxonomy
//       (outbox/sink_registry.ts): a NON-RETRYABLE failure (PermanentSinkError — the sink's
//       declared "retry CANNOT succeed"; UnknownSinkError — no handler registered, a wiring bug
//       retry cannot conjure away) dead-letters IMMEDIATELY after ONE drain (state='dead',
//       attempts ~1 — NOT maxAttempts burned through backoff; last_error carries the taxonomy
//       class name); a RetryableSinkError keeps the existing CS3c.1 backoff/retry path;
//   (3) an empty outbox → drainOnce claims nothing and never dispatches;
//   (4) run() idles on an empty outbox (it polled at least once) and stop() interrupts the idle
//       cancellableSleep immediately (the RunnerLoop/SchedulerLoop shutdown shape).
//
// dispatchRow is a recording STUB here (it Zod-parses the loop's constructed input — the same
// boundary validation the real activity runs — then optionally throws): the real sink registry
// would route to real external systems (Temporal client / reconcile), which an integration test
// must not touch. claimPendingRows / markDispatched / markAttemptFailed are the REAL
// Postgres-backed activities, so every state transition asserted below is real on-disk truth.
//
// Seeded rows use sink='installation_reconcile' with NULL installation_id — the one sink the
// ck_outbox_installation_id_required CHECK exempts, so no core.installations FK seeding is needed,
// AND it exercises the loop's orphan_reason='bootstrap_sink' tagged-union mapping.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { type Clock, FakeClock, WallClock } from "#platform/clock.js";
import { OutboxDispatchActivities } from "#backend/activities/outbox_dispatch.activity.js";
import { PostgresOutboxRepo } from "#backend/domain/repos/outbox_repo.js";
import {
  PermanentSinkError,
  RetryableSinkError,
  UnknownSinkError,
} from "#backend/outbox/sink_registry.js";
import {
  OutboxDispatcherLoop,
  type OutboxActivityFns,
} from "#backend/runner/outbox_dispatcher_loop.js";
import { DispatchRowInputV1 } from "#contracts/outbox_dispatch.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });          // destroys the OWN pool; no disposePool double-end

// AUTHORIZED DEVIATION (test isolation — same rationale as scheduler.integration.test.ts):
// vitest.config.ts shuffles test order, and claimPendingRows scans ALL pending core.outbox rows
// (ORDER BY created_at LIMIT batch), so a prior (shuffled) suite's leftover pending row would
// inflate this suite's exact claim counts AND claim-order assertions. A per-test wipe keeps both
// exact. Safe because test:integration runs --no-file-parallelism (files never interleave) and the
// other outbox writers (outbox_repo / ingest suites) clean their own rows in their own lifecycle.
beforeEach(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.outbox`.execute(db);
  }
});

// A unique tag so each run's rows are traceable to the test that minted them.
const RUN_TAG = `outbox-loop-it-${randomUUID()}`;

/** Seed one pending bootstrap-sink row (installation_reconcile — NULL installation_id is the
 *  schema-exempt shape) with an EXPLICIT created_at so claim order is deterministic. */
async function seedReconcileRow(opts: { tag: string; createdAt: Date }): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO core.outbox
      (id, sink, payload, schema_version, run_id, trace_context, delivery_id, installation_id, created_at)
    VALUES (${id}, 'installation_reconcile', CAST(${JSON.stringify({ tag: opts.tag })} AS JSONB), 1,
            NULL, CAST('{}' AS JSONB), ${`${RUN_TAG}-${opts.tag}`}, NULL, ${opts.createdAt})`.execute(db);
  return id;
}

type RowState = {
  state: string; attempts: number; leased_until: Date | null;
  dispatched_at: Date | null; last_error: string | null;
};
async function rowOf(id: string): Promise<RowState> {
  const r = await sql<RowState>`SELECT state, attempts, leased_until, dispatched_at, last_error
    FROM core.outbox WHERE id = ${id}`.execute(db);
  const row = r.rows[0]!;
  return { ...row, attempts: Number(row.attempts) };
}

/**
 * Compose the loop's activity surface: REAL claim/markDispatched/markAttemptFailed (Postgres-backed,
 * over the test's own db + the injected clock) + a recording dispatchRow STUB that Zod-parses the
 * loop's constructed input (the same boundary validation the real activity runs first) and then
 * delegates to `dispatchImpl` (throw → drive the failure path).
 */
function makeActivities(o: {
  clock: Clock;
  dispatchImpl?: (input: DispatchRowInputV1) => Promise<void>;
}): { activities: OutboxActivityFns; dispatched: Array<DispatchRowInputV1>; claims: { count: number } } {
  const repo = new PostgresOutboxRepo({ clock: o.clock });
  const acts = new OutboxDispatchActivities({ repo, db, clock: o.clock, maxAttempts: 5 });
  const dispatched: Array<DispatchRowInputV1> = [];
  const claims = { count: 0 };
  const activities: OutboxActivityFns = {
    claimPendingRows: async (input) => {
      claims.count += 1;
      return acts.claimPendingRows(input);
    },
    dispatchRow: async (input) => {
      const v = DispatchRowInputV1.parse(input); // the real activity's boundary validation
      dispatched.push(v);
      await (o.dispatchImpl ?? (async () => {}))(v);
    },
    markDispatched: acts.markDispatched,
    markAttemptFailed: acts.markAttemptFailed,
    markPermanentlyFailed: acts.markPermanentlyFailed,
  };
  return { activities, dispatched, claims };
}

describeDb("OutboxDispatcherLoop — Postgres leased drain loop (Phase 3c)", () => {
  it("(1) drainOnce dispatches each pending row in claim (created_at) order then marks it dispatched", async () => {
    const clock = new FakeClock({ now: new Date("2026-06-10T12:00:00.000Z") });
    const a = await seedReconcileRow({ tag: "a", createdAt: new Date("2026-06-10T11:00:00.000Z") });
    const b = await seedReconcileRow({ tag: "b", createdAt: new Date("2026-06-10T11:00:01.000Z") });
    const { activities, dispatched } = makeActivities({ clock });
    const loop = new OutboxDispatcherLoop({ activities, clock, batchSize: 10, idleS: 2 });

    expect(await loop.drainOnce()).toBe(2);

    // Claim-order semantics preserved: the batch dispatched in created_at order.
    expect(dispatched.map((d) => d.row_id)).toEqual([a, b]);
    // Workflow-parity dispatch input: schema_version Literal[2] + the bootstrap tagged union
    // (installation_id null → orphan_reason 'bootstrap_sink'); run/review/provider null for
    // non-review rows; the row's payload + trace_context threaded through.
    expect(dispatched[0]).toEqual({
      schema_version: 2,
      row_id: a,
      sink: "installation_reconcile",
      payload: { tag: "a" },
      trace_context: {},
      run_id: null,
      review_id: null,
      provider: null,
      installation_id: null,
      orphan_reason: "bootstrap_sink",
    });

    for (const id of [a, b]) {
      const row = await rowOf(id);
      expect(row.state).toBe("dispatched");        // the REAL markDispatched advanced the state
      expect(row.dispatched_at).not.toBeNull();
      expect(row.leased_until).toBeNull();          // lease released on the final transition
      expect(row.attempts).toBe(0);                 // the failure path never fired
    }
  });

  it("(2) a row whose dispatch throws → markAttemptFailed; the NEXT row in the SAME batch still dispatches", async () => {
    const clock = new FakeClock({ now: new Date("2026-06-10T12:00:00.000Z") });
    const failing = await seedReconcileRow({ tag: "fail", createdAt: new Date("2026-06-10T11:00:00.000Z") });
    const ok = await seedReconcileRow({ tag: "ok", createdAt: new Date("2026-06-10T11:00:01.000Z") });
    const { activities, dispatched } = makeActivities({
      clock,
      dispatchImpl: async (input) => {
        if (input.row_id === failing) { throw new Error("sink exploded"); }
      },
    });
    const loop = new OutboxDispatcherLoop({ activities, clock, batchSize: 10, idleS: 2 });

    expect(await loop.drainOnce()).toBe(2); // both rows were claimed; the failure is per-row, not per-pass

    const failed = await rowOf(failing);
    expect(failed.state).toBe("pending");          // NOT dispatched — claimable again AFTER the backoff
    expect(failed.attempts).toBe(1);                // the REAL markAttemptFailed recorded the attempt
    expect(failed.dispatched_at).toBeNull();
    expect(failed.last_error).toBe("sink exploded");
    // The lease is NOT released — markAttemptFailed defers the re-claim by the exponential backoff
    // (BASE 2s * 2^0 prior attempts), so a failing sink is paced instead of hammered.
    expect(failed.leased_until).not.toBeNull();
    expect(failed.leased_until!.getTime()).toBe(new Date("2026-06-10T12:00:02.000Z").getTime());

    // Per-row try/catch isolation (1:1 with the workflow body): the batch survivor still dispatched.
    expect(dispatched.map((d) => d.row_id)).toEqual([failing, ok]);
    expect((await rowOf(ok)).state).toBe("dispatched");
  });

  it("(2b) a persistently-failing row is NOT re-claimable until the backoff elapses — no busy-loop", async () => {
    const clock = new FakeClock({ now: new Date("2026-06-10T12:00:00.000Z") });
    const failing = await seedReconcileRow({ tag: "always-fail", createdAt: new Date("2026-06-10T11:00:00.000Z") });
    const { activities, dispatched } = makeActivities({
      clock,
      dispatchImpl: async () => { throw new Error("sink down"); },
    });
    const loop = new OutboxDispatcherLoop({ activities, clock, batchSize: 10, idleS: 2 });

    expect(await loop.drainOnce()).toBe(1);          // claimed + dispatch failed → attempt recorded
    expect(dispatched).toHaveLength(1);
    const afterFail = await rowOf(failing);
    expect(afterFail.state).toBe("pending");
    expect(afterFail.attempts).toBe(1);
    expect(afterFail.leased_until!.getTime()).toBe(new Date("2026-06-10T12:00:02.000Z").getTime());

    // SAME instant (the drain loop busy-loops on a non-empty claim): the failed row's deferred
    // lease keeps it OUT of the next claim — without the backoff this re-dispatches immediately
    // and the row burns all attempts in milliseconds against a down sink.
    expect(await loop.drainOnce()).toBe(0);
    expect(dispatched).toHaveLength(1);              // NOT re-dispatched within the backoff window

    clock.advance({ seconds: 3 });                   // past the 2s first-failure backoff
    expect(await loop.drainOnce()).toBe(1);          // backoff elapsed → re-claimed + retried
    expect(dispatched).toHaveLength(2);
    const afterRetry = await rowOf(failing);
    expect(afterRetry.attempts).toBe(2);
    // Exponential growth: second failure (prior attempts = 1) defers by 2 * 2^1 = 4s from 12:00:03.
    expect(afterRetry.leased_until!.getTime()).toBe(new Date("2026-06-10T12:00:07.000Z").getTime());
  });

  it("(2c) RC7: a PermanentSinkError dispatch dead-letters IMMEDIATELY — ONE drain, attempts NOT exhausted", async () => {
    const clock = new FakeClock({ now: new Date("2026-06-10T12:00:00.000Z") });
    const poison = await seedReconcileRow({ tag: "poison", createdAt: new Date("2026-06-10T11:00:00.000Z") });
    const ok = await seedReconcileRow({ tag: "ok", createdAt: new Date("2026-06-10T11:00:01.000Z") });
    const { activities, dispatched } = makeActivities({
      clock,
      dispatchImpl: async (input) => {
        if (input.row_id === poison) { throw new PermanentSinkError("payload schema violated"); }
      },
    });
    const loop = new OutboxDispatcherLoop({ activities, clock, batchSize: 10, idleS: 2 });

    expect(await loop.drainOnce()).toBe(2);

    const dead = await rowOf(poison);
    expect(dead.state).toBe("dead");        // IMMEDIATE terminal — NOT 'pending' awaiting 4 more burns
    expect(dead.attempts).toBe(1);          // the one real attempt is recorded; maxAttempts(5) NOT exhausted
    expect(dead.dispatched_at).toBeNull();
    expect(dead.leased_until).toBeNull();   // terminal path releases the lease — never re-claimable
    // The taxonomy class name is prefixed so the dead row's forensics are self-describing.
    expect(dead.last_error).toBe("PermanentSinkError: payload schema violated");

    // Per-row isolation preserved (1:1 with the retryable path): the batch survivor still dispatched.
    expect(dispatched.map((d) => d.row_id)).toEqual([poison, ok]);
    expect((await rowOf(ok)).state).toBe("dispatched");

    // Terminal means terminal: the dead row is OUT of every subsequent claim — even after time passes.
    clock.advance({ seconds: 600 });
    expect(await loop.drainOnce()).toBe(0);
    expect(dispatched).toHaveLength(2);     // never re-dispatched
  });

  it("(2d) RC7: an UnknownSinkError dispatch dead-letters IMMEDIATELY — a wiring bug surfaces ONCE, not maxAttempts times", async () => {
    const clock = new FakeClock({ now: new Date("2026-06-10T12:00:00.000Z") });
    const unrouted = await seedReconcileRow({ tag: "unrouted", createdAt: new Date("2026-06-10T11:00:00.000Z") });
    const { activities, dispatched } = makeActivities({
      clock,
      // The real dispatchRow's getSink(v.sink) throws UnknownSinkError BEFORE any DB work — the stub
      // reproduces that boundary (no handler registered for the row's sink).
      dispatchImpl: async () => { throw new UnknownSinkError("installation_reconcile"); },
    });
    const loop = new OutboxDispatcherLoop({ activities, clock, batchSize: 10, idleS: 2 });

    expect(await loop.drainOnce()).toBe(1);
    expect(dispatched).toHaveLength(1);

    const dead = await rowOf(unrouted);
    expect(dead.state).toBe("dead");
    expect(dead.attempts).toBe(1);
    expect(dead.dispatched_at).toBeNull();
    expect(dead.leased_until).toBeNull();
    expect(dead.last_error).toBe("UnknownSinkError: installation_reconcile");
  });

  it("(2e) RC7: a RetryableSinkError dispatch keeps the CS3c.1 backoff/retry path — NOT dead until the threshold", async () => {
    const clock = new FakeClock({ now: new Date("2026-06-10T12:00:00.000Z") });
    const flaky = await seedReconcileRow({ tag: "flaky", createdAt: new Date("2026-06-10T11:00:00.000Z") });
    const { activities, dispatched } = makeActivities({
      clock,
      dispatchImpl: async () => { throw new RetryableSinkError("GitHub 502"); },
    });
    const loop = new OutboxDispatcherLoop({ activities, clock, batchSize: 10, idleS: 2 });

    expect(await loop.drainOnce()).toBe(1);

    const failed = await rowOf(flaky);
    expect(failed.state).toBe("pending");           // transient → still retryable, NOT dead
    expect(failed.attempts).toBe(1);                 // the attempt is recorded against the threshold
    expect(failed.dispatched_at).toBeNull();
    expect(failed.last_error).toBe("GitHub 502");
    // The CS3c.1 exponential backoff defers the re-claim (BASE 2s * 2^0 prior attempts).
    expect(failed.leased_until).not.toBeNull();
    expect(failed.leased_until!.getTime()).toBe(new Date("2026-06-10T12:00:02.000Z").getTime());

    // Within the backoff window the row stays out of the claim; after it elapses, it retries.
    expect(await loop.drainOnce()).toBe(0);
    clock.advance({ seconds: 3 });
    expect(await loop.drainOnce()).toBe(1);
    expect(dispatched).toHaveLength(2);
    expect((await rowOf(flaky)).attempts).toBe(2);   // still riding the bounded retry curve
  });

  it("(3) an empty outbox → drainOnce claims nothing and never dispatches", async () => {
    const clock = new FakeClock({ now: new Date("2026-06-10T12:00:00.000Z") });
    const { activities, dispatched } = makeActivities({ clock });
    const loop = new OutboxDispatcherLoop({ activities, clock, batchSize: 10, idleS: 2 });

    expect(await loop.drainOnce()).toBe(0);
    expect(dispatched).toHaveLength(0);
  });

  it("(4) run() idles on an empty outbox and stop() interrupts the idle sleep immediately", async () => {
    // WallClock drives the loop here (FakeClock.sleep returns instantly → a hot spin); idleS=600
    // proves stop() interrupts the idle cancellableSleep (without the interrupt, `await run` would
    // blow the 10s test timeout) — the SchedulerLoop test-(6) shape.
    const { activities, dispatched, claims } = makeActivities({ clock: new WallClock() });
    const loop = new OutboxDispatcherLoop({ activities, clock: new WallClock(), idleS: 600 });
    const run = loop.run();
    try {
      // The first drain pass runs BEFORE the first idle sleep — wait (bounded) for its claim.
      const deadline = Date.now() + 5000;
      while (claims.count === 0) {
        if (Date.now() > deadline) { throw new Error("OutboxDispatcherLoop did not claim within 5s"); }
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      loop.stop(); // must wake the 600s idle cancellableSleep immediately
    }
    await run;
    expect(dispatched).toHaveLength(0); // empty outbox → the pass idled; nothing dispatched
  }, 10_000);
});
