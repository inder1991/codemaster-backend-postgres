// Unit tests for OutboxDispatchActivities — the 4 dispatcher activities (1:1 with the @activity.defn
// functions in vendor/codemaster-py/codemaster/activities/outbox.py). These test the ORCHESTRATION the
// activities add on top of the repo (delegation args, the bootstrap-skips-guard path, unknown-sink
// propagation, maxAttempts injection, the dead-letter signal). The repo's SQL is integration-tested in
// outbox_repo.integration.test.ts; the guard/transition/INGESTED path is integration-tested in
// outbox_dispatch_guard.integration.test.ts. Here the repo is a fake so no DB is needed.

import { afterEach, describe, expect, it, vi } from "vitest";

import { OutboxDispatchActivities } from "#backend/activities/outbox_dispatch.activity.js";
import type { OutboxRow, PostgresOutboxRepo } from "#backend/domain/repos/outbox_repo.js";
import { registerSink, resetRegistryForTesting, type SinkContext } from "#backend/outbox/sink_registry.js";

import { FakeClock } from "#platform/clock.js";

import type { Kysely } from "kysely";

const clock = new FakeClock({ now: new Date("2099-07-08T09:10:11.000Z") });
const dummyDb = {} as unknown as Kysely<unknown>;

// Valid UUIDs — the activities now .parse(input) at the boundary, so row_id must be a real UUID.
const ROW_1 = "00000000-0000-4000-8000-000000000001";
const ROW_2 = "00000000-0000-4000-8000-000000000002";
const ROW_3 = "00000000-0000-4000-8000-000000000003";
const ROW_4 = "00000000-0000-4000-8000-000000000004";

function makeActs(repoOverrides: Partial<PostgresOutboxRepo>): OutboxDispatchActivities {
  // dispatchRow now spawns the lease-heartbeat (S14.5.D), which calls repo.extendLease while a handler runs.
  // Give every fake repo a no-op extendLease default so a dispatchRow test that doesn't stub it doesn't trip
  // the heartbeat's fail-open WARN path; tests that care override it. (The heartbeat itself is covered in
  // outbox_dispatch_heartbeat.test.ts.)
  const repo = { extendLease: async () => {}, ...repoOverrides };
  return new OutboxDispatchActivities({
    repo: repo as unknown as PostgresOutboxRepo,
    db: dummyDb,
    clock,
    maxAttempts: 5,
  });
}

afterEach(() => resetRegistryForTesting());

describe("OutboxDispatchActivities", () => {
  it("constructor rejects maxAttempts < 1 (mirrors Python configure() ValueError)", () => {
    expect(
      () => new OutboxDispatchActivities({ repo: {} as PostgresOutboxRepo, db: dummyDb, clock, maxAttempts: 0 }),
    ).toThrow(/max_attempts/);
  });

  it("claimPendingRows delegates to repo.claimPending with the input's batch/lease", async () => {
    const rows: Array<OutboxRow> = [
      { id: "r1", sink: "s", payload: {}, schemaVersion: 2, attempts: 0, traceContext: {}, runId: null, reviewId: null, provider: null, installationId: null, deliveryId: null },
    ];
    const claimPending = vi.fn(async () => rows);
    const acts = makeActs({ claimPending } as unknown as Partial<PostgresOutboxRepo>);

    const out = await acts.claimPendingRows({ batch_size: 50, lease_seconds: 30 });
    expect(out).toBe(rows);
    expect(claimPending).toHaveBeenCalledWith({ db: dummyDb, batchSize: 50, leaseSeconds: 30 });
  });

  it("dispatchRow (bootstrap row: no run/review) resolves + invokes the sink, skipping the guard", async () => {
    const calls: Array<{ payload: unknown; context: SinkContext }> = [];
    registerSink("sync_code_owners", async (a) => {
      calls.push(a);
    });
    const acts = makeActs({});

    await acts.dispatchRow({
      schema_version: 2,
      row_id: ROW_1,
      sink: "sync_code_owners",
      payload: { x: 1 },
      trace_context: {},
      run_id: null,
      review_id: null,
      provider: null,
      installation_id: null,
      orphan_reason: "bootstrap_sink",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload).toEqual({ x: 1 });
    // installation_id is null for a bootstrap row; the context mirrors it (no DB touched).
    // RM2/W3.2: the context carries the dispatching outbox ROW id — the destination-side
    // idempotency key (a re-dispatch of the SAME row must be deduplicable at the destination
    // even after a prior execution settled; the key has to exist at the sink boundary first).
    expect(calls[0]!.context).toEqual({
      deliveryId: null,
      installationId: null,
      runId: null,
      outboxRowId: ROW_1,
    });
  });

  it("dispatchRow threads the dispatcher's row delivery_id into the SinkContext (W1.9e — full delivery_id threading)", async () => {
    // The parity-locked DispatchRowInputV1 (frozen Python shape) carries NO delivery_id, so the
    // Postgres drain loop threads the OUTBOX ROW's delivery_id as a runtime-only 2nd argument —
    // the sinks need it for the destination-side identity cross-check (the CS4.1 review-enqueue
    // slice generalized). Omitted (the Temporal proxy path) → null, byte-1:1 with the frozen Python.
    const calls: Array<{ payload: unknown; context: SinkContext }> = [];
    registerSink("sync_code_owners", async (a) => {
      calls.push(a);
    });
    const acts = makeActs({});

    await acts.dispatchRow(
      {
        schema_version: 2,
        row_id: ROW_1,
        sink: "sync_code_owners",
        payload: { x: 1 },
        trace_context: {},
        run_id: null,
        review_id: null,
        provider: null,
        installation_id: null,
        orphan_reason: "bootstrap_sink",
      },
      { deliveryId: "dlv-w19e-threaded" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.context).toEqual({
      deliveryId: "dlv-w19e-threaded",
      installationId: null,
      runId: null,
    });
  });

  it("dispatchRow REJECTS the tagged-union propagation-bug shape at the boundary (both installation_id + orphan_reason null)", async () => {
    let invoked = false;
    registerSink("sync_code_owners", async () => {
      invoked = true;
    });
    const acts = makeActs({});
    // installation_id null with NO orphan_reason is the BF-3-Phase-A propagation bug — the boundary parse
    // (DispatchRowInputV1.superRefine) must reject it BEFORE the sink runs (parity with the Python
    // pydantic_data_converter re-validating _check_tenant_pair on activity-side deserialization).
    await expect(
      acts.dispatchRow({
        schema_version: 2,
        row_id: ROW_2,
        sink: "sync_code_owners",
        payload: {},
        trace_context: {},
        run_id: null,
        review_id: null,
        provider: null,
        installation_id: null,
        orphan_reason: null,
      }),
    ).rejects.toThrow();
    expect(invoked).toBe(false);
  });

  it("dispatchRow propagates UnknownSinkError when no handler is registered", async () => {
    const acts = makeActs({});
    await expect(
      acts.dispatchRow({
        schema_version: 2,
        row_id: ROW_2,
        sink: "nope",
        payload: {},
        trace_context: {},
        run_id: null,
        review_id: null,
        provider: null,
        installation_id: null,
        orphan_reason: "bootstrap_sink",
      }),
    ).rejects.toThrow(/nope/);
  });

  it("markDispatched delegates to repo.markDispatched", async () => {
    const markDispatched = vi.fn(async () => null);
    const acts = makeActs({ markDispatched } as unknown as Partial<PostgresOutboxRepo>);
    await acts.markDispatched({ row_id: ROW_3 });
    expect(markDispatched).toHaveBeenCalledWith({ db: dummyDb, id: ROW_3 });
  });

  it("markAttemptFailed injects maxAttempts + expectedAttempts and dead-letters exactly once on 'dead'", async () => {
    const markAttemptFailed = vi.fn(async () => ({ state: "dead", sink: "temporal_workflow_start" }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const acts = makeActs({ markAttemptFailed } as unknown as Partial<PostgresOutboxRepo>);

    await acts.markAttemptFailed({ row_id: ROW_4, error: "boom", expected_attempts: 2 });

    expect(markAttemptFailed).toHaveBeenCalledWith({
      db: dummyDb,
      id: ROW_4,
      error: "boom",
      maxAttempts: 5,
      expectedAttempts: 2,
    });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]![0])).toContain("outbox.dead_letter");
    errSpy.mockRestore();
  });

  it("markAttemptFailed emits NO dead-letter on a retry-stays-pending or redrive-null result", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const acts1 = makeActs({ markAttemptFailed: vi.fn(async () => ({ state: "pending", sink: "x" })) } as unknown as Partial<PostgresOutboxRepo>);
    await acts1.markAttemptFailed({ row_id: ROW_1, error: "e", expected_attempts: 0 });

    const acts2 = makeActs({ markAttemptFailed: vi.fn(async () => null) } as unknown as Partial<PostgresOutboxRepo>);
    await acts2.markAttemptFailed({ row_id: ROW_2, error: "e", expected_attempts: 0 });

    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
