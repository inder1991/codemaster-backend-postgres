// Unit tests for the OutboxDispatchActivities lease-heartbeat (S14.5.D — 1:1 with the Python `_heartbeat`
// closure inside dispatch_row in vendor/codemaster-py/codemaster/activities/outbox.py). These assert the
// now-ACTIVE heartbeat: while a sink handler runs, a background loop extends the row's lease every
// HEARTBEAT_INTERVAL_SECONDS (2s) by HEARTBEAT_LEASE_SECONDS (10s); it stops in the dispatchRow `finally`
// (no extra extends after the handler returns); and a heartbeat extendLease rejection is swallowed
// (WARN, loop continues, dispatch still succeeds) — the fail-open invariant.
//
// The repo is fully stubbed — NO database is touched. The fire-and-forget loop is driven deterministically:
// the stub handler blocks on a deferred so it stays "running" across several heartbeat iterations, and the
// stub `extendLease` returns a fresh deferred per call so the test advances the loop EXACTLY one iteration
// per release (the FakeClock.sleep resolves immediately, so iteration count is bounded only by how far we
// let extendLease progress). This makes the count assertion deterministic without a real timer.

import { afterEach, describe, expect, it, vi } from "vitest";

import { OutboxDispatchActivities } from "#backend/activities/outbox_dispatch.activity.js";
import type { PostgresOutboxRepo } from "#backend/domain/repos/outbox_repo.js";
import { registerSink, resetRegistryForTesting } from "#backend/outbox/sink_registry.js";

import { FakeClock } from "#platform/clock.js";

import type { Kysely } from "kysely";

const clock = new FakeClock({ now: new Date("2099-07-08T09:10:11.000Z") });
const dummyDb = {} as unknown as Kysely<unknown>;

const ROW = "00000000-0000-4000-8000-0000000000aa";

/** A minimal externally-resolvable promise (no Promise.withResolvers dependency for older runtimes). */
type Deferred = { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void };
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yield to the microtask queue enough times for the fire-and-forget loop to make progress. */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function makeActs(repoOverrides: Partial<PostgresOutboxRepo>): OutboxDispatchActivities {
  return new OutboxDispatchActivities({
    repo: repoOverrides as unknown as PostgresOutboxRepo,
    db: dummyDb,
    clock,
    maxAttempts: 5,
  });
}

const baseInput = {
  schema_version: 2 as const,
  row_id: ROW,
  sink: "sync_code_owners",
  payload: { x: 1 },
  trace_context: {},
  run_id: null,
  review_id: null,
  provider: null,
  installation_id: null,
  orphan_reason: "bootstrap_sink" as const,
};

afterEach(() => resetRegistryForTesting());

describe("OutboxDispatchActivities lease-heartbeat", () => {
  it("extends the lease ~N times while the handler runs, stops after the handler completes", async () => {
    // The handler blocks until we release it, so the heartbeat loop runs across several iterations.
    const handlerGate = deferred();
    registerSink("sync_code_owners", async () => {
      await handlerGate.promise;
    });

    // extendLease records each call's args and blocks on a per-call gate so we advance the loop one
    // iteration at a time. Each release lets the current extendLease resolve → loop sleeps → calls again.
    const extendCalls: Array<{ db: unknown; id: string; leaseSeconds: number }> = [];
    const gates: Array<Deferred> = [];
    const extendLease = vi.fn(async (args: { db: unknown; id: string; leaseSeconds: number }) => {
      extendCalls.push(args);
      const g = deferred();
      gates.push(g);
      await g.promise;
    });

    const acts = makeActs({ extendLease } as unknown as Partial<PostgresOutboxRepo>);

    const dispatchPromise = acts.dispatchRow(baseInput);

    // Drive N heartbeat iterations. The stub records each call's args BEFORE blocking on its gate, so at the
    // start of iteration i the loop has recorded exactly (i + 1) calls (the +1 is the current, still-blocked
    // one). Asserting that invariant at each step proves the loop fired the heartbeat once per interval with
    // the right id + lease window — deterministically, with no real timer.
    const N = 3;
    for (let i = 0; i < N; i++) {
      await flush(); // let the loop reach (or re-reach) the extendLease await and record the call
      expect(extendCalls.length).toBe(i + 1); // exactly one extend per heartbeat interval, in order
      expect(extendCalls[i]).toEqual({ db: dummyDb, id: ROW, leaseSeconds: 10 }); // 10 = HEARTBEAT_LEASE_SECONDS
      gates[i]!.resolve(); // release this extendLease so the loop proceeds to the next iteration
    }
    await flush();

    // After releasing N gates the loop has come around once more and recorded an (N + 1)th call that is now
    // blocked on its own gate (FakeClock.sleep resolves immediately, so the loop always runs one iteration
    // ahead of the last-released gate). Every recorded extend used the 10s lease + the row id.
    expect(extendCalls.length).toBe(N + 1);
    for (const c of extendCalls) {
      expect(c).toEqual({ db: dummyDb, id: ROW, leaseSeconds: 10 });
    }

    // Complete the handler → the dispatchRow `finally` calls heartbeat.stop(), flipping `stopped`. Release
    // every outstanding gate so the loop's in-flight iteration can unwind and observe `stopped` → it exits.
    handlerGate.resolve();
    for (const g of gates) {
      g.resolve();
    }
    await dispatchPromise; // dispatchRow resolves once the handler returns + finally runs
    await flush(20); // let the now-stopped loop fully settle

    const countAfterStop = extendCalls.length;
    await flush(20); // pump again — a still-running loop would record more calls here

    // After the handler completed and stop() fired, NO further extendLease calls are made (the loop exited).
    expect(extendCalls.length).toBe(countAfterStop);
  });

  it("uses HEARTBEAT_LEASE_SECONDS (10) on every extend and sleeps HEARTBEAT_INTERVAL_SECONDS (2)", async () => {
    const handlerGate = deferred();
    registerSink("sync_code_owners", async () => {
      await handlerGate.promise;
    });

    const sleepSpy = vi.spyOn(clock, "sleep");
    const extendLease =
      vi.fn<(args: { db: unknown; id: string; leaseSeconds: number }) => Promise<void>>(async () => {});
    const acts = makeActs({ extendLease } as unknown as Partial<PostgresOutboxRepo>);

    const dispatchPromise = acts.dispatchRow(baseInput);
    await flush(10); // FakeClock.sleep resolves immediately, so the loop free-runs several iterations here

    expect(extendLease.mock.calls.length).toBeGreaterThan(0);
    // Every extend uses the 10s lease window (the Python HEARTBEAT_LEASE_SECONDS const).
    for (const call of extendLease.mock.calls) {
      expect(call[0]).toEqual({ db: dummyDb, id: ROW, leaseSeconds: 10 });
    }
    // The loop sleeps the 2s interval (the Python HEARTBEAT_INTERVAL_SECONDS const) — Clock.sleep is seconds.
    expect(sleepSpy).toHaveBeenCalledWith(2);

    handlerGate.resolve();
    await dispatchPromise;
    sleepSpy.mockRestore();
  });

  it("RM3/W3.2: caps total heartbeat lifetime at 60s — past the cap it STOPS extending, WARNs once, and the dispatch still completes", async () => {
    // Pre-RM3 the heartbeat re-extended `leased_until` for the ENTIRE life of the handler — a
    // live-but-stuck sink kept its row un-reclaimable forever, defeating the lease safety net for
    // exactly the most common stall (slow/hung, not crashed). The cap: after
    // HEARTBEAT_MAX_TOTAL_SECONDS (60 — the old Temporal start-to-close, paired with the loop's
    // RM1 dispatch bound) of monotonic lifetime, the loop stops heartbeating and lets the lease
    // expire on its own, WITHOUT touching the still-running handler.
    const handlerGate = deferred();
    registerSink("sync_code_owners", async () => {
      await handlerGate.promise;
    });
    const extendLease = vi.fn(async () => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const acts = makeActs({ extendLease } as unknown as Partial<PostgresOutboxRepo>);

    const dispatchPromise = acts.dispatchRow(baseInput);
    await flush(10); // FakeClock.sleep resolves instantly → the loop free-runs some pre-cap beats
    expect(extendLease.mock.calls.length).toBeGreaterThan(0); // the heartbeat IS alive before the cap

    clock.advance({ seconds: 61 }); // monotonic sails past the 60s max total lease lifetime
    await flush(10); // the loop's next wake observes the cap → ONE warn → exits

    const atCap = extendLease.mock.calls.length;
    await flush(20); // pump hard — a still-running loop would keep recording extends here
    expect(extendLease.mock.calls.length).toBe(atCap); // NO further extensions: the lease now expires

    const capWarns = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("outbox.lease_heartbeat_capped"));
    expect(capWarns).toHaveLength(1); // the cap is logged exactly ONCE (structured, with the row id)
    expect(capWarns[0]).toContain(ROW);

    // The handler is NOT killed by the cap (that is the loop-side RM1 watchdog's job): releasing it
    // still completes the dispatch cleanly.
    handlerGate.resolve();
    await expect(dispatchPromise).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });

  it("swallows an extendLease rejection (WARN, loop continues, dispatch still succeeds) — fail-open", async () => {
    const handlerGate = deferred();
    registerSink("sync_code_owners", async () => {
      await handlerGate.promise;
    });

    let calls = 0;
    // First extend rejects; subsequent extends succeed — proves the loop CONTINUES past a failure.
    const extendLease = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("db blip");
      }
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const acts = makeActs({ extendLease } as unknown as Partial<PostgresOutboxRepo>);

    const dispatchPromise = acts.dispatchRow(baseInput);
    await flush(10);

    // The rejection was logged at WARN with the canonical event + row_id + error.
    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warned.some((m) => m.includes("outbox.lease_heartbeat_failed"))).toBe(true);
    expect(warned.some((m) => m.includes(ROW))).toBe(true);
    expect(warned.some((m) => m.includes("db blip"))).toBe(true);
    // The loop continued past the failure (extendLease was called more than once).
    expect(calls).toBeGreaterThan(1);

    // The dispatch itself still SUCCEEDS — the heartbeat failure never propagated to the handler path.
    handlerGate.resolve();
    await expect(dispatchPromise).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });
});
