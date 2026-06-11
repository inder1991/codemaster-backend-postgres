// CS1.2 (cutover-safety plan, finding CS1): the SHADOW mode NO-SIDE-EFFECTS contract. In shadow
// mode (CODEMASTER_RUNTIME_MODE=shadow) the Postgres runtime runs alongside (or instead of)
// Temporal for observation, and MUST NOT perform production side effects. This suite proves each
// guarded seam, with the shadow=false contrast on the SAME drive (the existing behavior):
//   (1) SCHEDULER (mandatory a): a shadow pollOnce on a DUE schedule enqueues NOTHING and does NOT
//       advance next_run_at / stamp last_enqueued_at — a "would-enqueue" log fires instead; the
//       SAME poll with shadow=false enqueues + advances.
//   (2) OUTBOX LOOP (mandatory b): a shadow drainOnce on a seeded pending row never claims (no
//       lease stamp — a lease would delay the live Temporal dispatcher's drain), never dispatches,
//       never calls markDispatched/markAttemptFailed; the row is byte-untouched on disk. The SAME
//       drain with shadow=false dispatches + marks dispatched.
//   (2b) COMPOSED outbox: buildBackgroundRunner({shadow:true}).drainOutboxOnce() — the REAL
//       dispatchRow is wired but the shadow guard suppresses the whole pass; the row stays pending.
//   (3) OUTBOX PORT (mandatory b — "no real review/background enqueue"): a shadow
//       BackgroundJobsTemporalPort.startWorkflow enqueues NO core.background_jobs row (a
//       would-enqueue log + sentinel id instead); the SAME call with shadow=false enqueues.
//   (4) HANDLER DISPATCH SEAM (mandatory c): HandlerRegistry.register wraps EVERY handler with the
//       shadow guard — deps.shadow=true suppresses the handler body (would-run log);
//       deps.shadow=false runs it (pure, no DB).
//   (5) REAL SIDE-EFFECTING HANDLER (mandatory c): refresh_semantic_docs driven with shadow deps
//       never invokes its external stubs (clone / token mint / embeddings) — the GitHub/LLM/embed
//       suppression on a real registered handler. (The shadow=false contrast for this handler is
//       the existing event_handlers_knowledge suite — its drives run with shadow=false deps.)
//   (6) RUNNER CLAIM (d — production-table mutation): a shadow runOneCycle does NOT claim — the
//       enqueued job stays 'ready' (work preserved for the real cutover, no lease-column mutation);
//       the SAME cycle with shadow=false claims + runs + settles 'done'.
//   (7) IDLE MAINTENANCE (d): shadow runIdleMaintenance does NOT reap a stuck job (reapStuckRuns
//       mutates core.background_jobs); the real one reaps it to 'dead'.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OutboxDispatchActivities } from "#backend/activities/outbox_dispatch.activity.js";
import type { CacheGitCloner } from "#backend/activities/clone_repository.activity.js";
import { RecordingEmbeddingsClient } from "#backend/adapters/embeddings_port.js";
import {
  type StartWorkflowCall,
} from "#backend/adapters/temporal_port.js";
import { PostgresOutboxRepo } from "#backend/domain/repos/outbox_repo.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { BackgroundJobsTemporalPort } from "#backend/runner/background_jobs_temporal_port.js";
import {
  buildBackgroundRunner,
  type BackgroundRunnerConfig,
} from "#backend/runner/background_runner_main.js";
import { HandlerRegistry, type HandlerDeps } from "#backend/runner/handler_registry.js";
import { registerEventHandlers } from "#backend/runner/handlers/event_handlers.js";
import {
  OutboxDispatcherLoop,
  type OutboxActivityFns,
} from "#backend/runner/outbox_dispatcher_loop.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { WORKFLOW_TYPE_TO_JOB_TYPE } from "#backend/runner/workflow_job_map.js";
import { type Clock, FakeClock, WallClock } from "#platform/clock.js";
import { BackgroundJobV1 } from "#contracts/background_job.v1.js";
import { DispatchRowInputV1 } from "#contracts/outbox_dispatch.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });          // destroys the OWN pool; no disposePool double-end

// AUTHORIZED DEVIATION (test isolation — same rationale as cutover_port.integration.test.ts):
// vitest.config.ts shuffles test order, and the claim/poll scans are table-wide
// (claimPendingRows over core.outbox; claim over core.background_jobs; pollAndEnqueue over
// core.scheduled_jobs), so per-test wipes keep claim targets, dedup, and enqueue counts exact.
// Safe because test:integration runs --no-file-parallelism (files never interleave) and the other
// writers clean their own rows.
beforeEach(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.background_jobs`.execute(db);
    await sql`DELETE FROM core.scheduled_jobs`.execute(db);
    await sql`DELETE FROM core.outbox`.execute(db);
  }
});
afterEach(() => { vi.restoreAllMocks(); }); // un-spies console.info between tests

/** Bounded test config (the cutover_port suite's proven shape): generous ceilings (ms-fast
 *  handlers never graze them), huge sleeps (the single-shot drive seams never enter them). */
const TEST_CONFIG: BackgroundRunnerConfig = {
  owner: "cs12-shadow-test", leaseS: 30, heartbeatS: 5, maxRuntimeS: 300, idleS: 30,
  pollIntervalS: 600, outboxIdleS: 600, outboxMaxAttempts: 5,
};

/** Direct INSERT into core.scheduled_jobs (the scheduler suite's seedSchedule shape). */
async function seedSchedule(opts: {
  scheduleId: string; jobType: string; cadenceSpec: string; nextRunAt: Date;
}): Promise<void> {
  await sql`INSERT INTO core.scheduled_jobs
      (schedule_id, job_type, cadence_kind, cadence_spec, input, enabled, next_run_at)
    VALUES (${opts.scheduleId}, ${opts.jobType}, 'interval', ${opts.cadenceSpec},
            CAST('{}' AS jsonb), true, ${opts.nextRunAt})`.execute(db);
}

async function readSchedule(scheduleId: string): Promise<{ next_run_at: Date; last_enqueued_at: Date | null }> {
  const r = await sql<{ next_run_at: Date; last_enqueued_at: Date | null }>`
    SELECT next_run_at, last_enqueued_at FROM core.scheduled_jobs
     WHERE schedule_id = ${scheduleId}`.execute(db);
  return r.rows[0]!;
}

/** Every background_jobs row minted for a schedule (dedup_key = schedule_id). */
async function jobsFor(dedupKey: string): Promise<Array<{ job_id: string; state: string }>> {
  const r = await sql<{ job_id: string; state: string }>`SELECT job_id, state
    FROM core.background_jobs WHERE dedup_key = ${dedupKey} ORDER BY created_at`.execute(db);
  return r.rows;
}

/** Seed one pending bootstrap-sink outbox row (installation_reconcile — NULL installation_id is the
 *  schema-exempt shape; the outbox_dispatcher_loop suite's idiom). */
async function seedReconcileRow(tag: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO core.outbox
      (id, sink, payload, schema_version, run_id, trace_context, delivery_id, installation_id, created_at)
    VALUES (${id}, 'installation_reconcile', CAST(${JSON.stringify({ tag })} AS JSONB), 1,
            NULL, CAST('{}' AS JSONB), ${`cs12-shadow-${tag}-${id}`}, NULL, ${new Date("2026-06-11T11:00:00.000Z")})`
    .execute(db);
  return id;
}

type OutboxRowState = {
  state: string; attempts: number; leased_until: Date | null; dispatched_at: Date | null;
};
async function outboxRowOf(id: string): Promise<OutboxRowState> {
  const r = await sql<OutboxRowState>`SELECT state, attempts, leased_until, dispatched_at
    FROM core.outbox WHERE id = ${id}`.execute(db);
  const row = r.rows[0]!;
  return { ...row, attempts: Number(row.attempts) };
}

/** REAL claim/markDispatched/markAttemptFailed + a recording dispatchRow stub (the
 *  outbox_dispatcher_loop suite's makeActivities idiom) so the shadow assertions count REAL
 *  on-disk transitions AND stub invocations. */
function makeOutboxActivities(clock: Clock): {
  activities: OutboxActivityFns; dispatched: Array<DispatchRowInputV1>; claims: { count: number };
} {
  const repo = new PostgresOutboxRepo({ clock });
  const acts = new OutboxDispatchActivities({ repo, db, clock, maxAttempts: 5 });
  const dispatched: Array<DispatchRowInputV1> = [];
  const claims = { count: 0 };
  const activities: OutboxActivityFns = {
    claimPendingRows: async (input) => {
      claims.count += 1;
      return acts.claimPendingRows(input);
    },
    dispatchRow: async (input) => {
      dispatched.push(DispatchRowInputV1.parse(input));
    },
    markDispatched: acts.markDispatched,
    markAttemptFailed: acts.markAttemptFailed,
    markPermanentlyFailed: acts.markPermanentlyFailed,
  };
  return { activities, dispatched, claims };
}

/** A StartWorkflowCall with the producers' envelope defaults (the cutover_port suite's shape). */
function startCall(o: {
  workflowType: string; workflowId: string; args: ReadonlyArray<unknown>;
}): StartWorkflowCall {
  return {
    workflowType: o.workflowType,
    workflowId: o.workflowId,
    taskQueue: "review-default",
    args: o.args,
    executionTimeoutSeconds: 900,
    runTimeoutSeconds: 900,
    searchAttributes: {},
    idReusePolicy: "ALLOW_DUPLICATE",
    idConflictPolicy: "USE_EXISTING",
  };
}

/** A leased-state job row for direct handler invocation (the handler_abort suite's fakeDeps idiom;
 *  only job_id/clock/shadow are read on the shadow path — the contract parse keeps it honest). */
function fakeDeps(jobType: string, shadow: boolean): HandlerDeps {
  const now = new Date();
  return {
    job: BackgroundJobV1.parse({
      job_id: randomUUID(),
      job_type: jobType,
      installation_id: null,
      payload: {},
      payload_sha256: "0".repeat(64),
      state: "leased",
      priority: 0,
      run_after: now,
      lease_owner: "cs12-shadow-test",
      attempt_token: randomUUID(),
      leased_until: now,
      timeout_at: now,
      heartbeat_at: null,
      attempts: 1,
      max_attempts: 5,
      finished_at: null,
      dead_reason: null,
      last_error: null,
      dedup_key: null,
      created_at: now,
      updated_at: now,
    }),
    clock: new WallClock(),
    shadow,
  };
}

describeDb("SHADOW mode no-side-effects contract (CS1.2)", () => {
  it("(1) SCHEDULER: shadow pollOnce neither enqueues nor advances next_run_at (would-enqueue log); shadow=false does both", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const clock = new FakeClock({ now: new Date("2026-06-11T12:00:00.000Z") });
    const scheduleId = `cs12-sched-${randomUUID()}`;
    const jobType = `cs12-job-${randomUUID()}`;
    // W3.8 (RM7): pollOnce default-denies job_types outside the scheduled-contract registry, so the
    // synthetic job_type rides the deps seam (zero-config — matching seedSchedule's `{}` input).
    const scheduledInputContracts = new Map([[jobType, z.object({}).strict()]]);
    await seedSchedule({ scheduleId, jobType, cadenceSpec: "300",
      nextRunAt: new Date("2026-06-11T11:59:00.000Z") });

    // SHADOW: the due schedule is OBSERVED, never acted on.
    const shadowHandles = buildBackgroundRunner({
      db, clock, config: TEST_CONFIG, shadow: true, scheduledInputContracts,
    });
    expect(await shadowHandles.pollOnce()).toBe(0);
    expect(await jobsFor(scheduleId)).toHaveLength(0);          // NO background job enqueued
    const afterShadow = await readSchedule(scheduleId);
    expect(afterShadow.next_run_at).toEqual(new Date("2026-06-11T11:59:00.000Z")); // NOT advanced
    expect(afterShadow.last_enqueued_at).toBeNull();             // NOT stamped
    const wouldLogs = infoSpy.mock.calls.filter((c) => String(c[0]).includes("would-enqueue"));
    expect(wouldLogs.length).toBeGreaterThanOrEqual(1);          // the observation log fired instead
    expect(wouldLogs.some((c) => String(c[0]).includes(scheduleId))).toBe(true);

    // CONTRAST (shadow=false): the SAME drive performs the effects — the existing behavior.
    const realHandles = buildBackgroundRunner({
      db, clock, config: TEST_CONFIG, shadow: false, scheduledInputContracts,
    });
    expect(await realHandles.pollOnce()).toBe(1);
    expect(await jobsFor(scheduleId)).toHaveLength(1);
    const afterReal = await readSchedule(scheduleId);
    expect(afterReal.next_run_at).toEqual(new Date("2026-06-11T12:05:00.000Z")); // clock.now() + 300s
    expect(afterReal.last_enqueued_at).toEqual(new Date("2026-06-11T12:00:00.000Z"));
  });

  it("(2) OUTBOX LOOP: shadow drainOnce never claims/leases, never dispatches, never marks; shadow=false drains the row", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const clock = new FakeClock({ now: new Date("2026-06-11T12:00:00.000Z") });
    const rowId = await seedReconcileRow("loop");
    const { activities, dispatched, claims } = makeOutboxActivities(clock);

    // SHADOW: the pass is fully suppressed — not even a claim (a lease stamp on core.outbox would
    // delay the live Temporal dispatcher's drain of the same row).
    const shadowLoop = new OutboxDispatcherLoop({ activities, clock, batchSize: 10, idleS: 2, shadow: true });
    expect(await shadowLoop.drainOnce()).toBe(0);                // returns 0 so run() idles (no busy-loop)
    expect(claims.count).toBe(0);                                // claimPendingRows NEVER invoked
    expect(dispatched).toHaveLength(0);                          // the dispatch stub NEVER invoked
    const afterShadow = await outboxRowOf(rowId);
    expect(afterShadow.state).toBe("pending");                   // NOT markDispatched
    expect(afterShadow.leased_until).toBeNull();                 // NO lease stamp
    expect(afterShadow.attempts).toBe(0);                        // NO markAttemptFailed
    expect(afterShadow.dispatched_at).toBeNull();

    // CONTRAST (shadow=false): the SAME drive performs the effects — claim, dispatch, markDispatched.
    const realLoop = new OutboxDispatcherLoop({ activities, clock, batchSize: 10, idleS: 2 });
    expect(await realLoop.drainOnce()).toBe(1);
    expect(claims.count).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.row_id).toBe(rowId);
    expect((await outboxRowOf(rowId)).state).toBe("dispatched");
  });

  it("(2b) COMPOSED outbox: buildBackgroundRunner threads shadow into drainOutboxOnce — the REAL dispatchRow never fires", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const clock = new FakeClock({ now: new Date("2026-06-11T12:00:00.000Z") });
    const rowId = await seedReconcileRow("composed");
    const shadowHandles = buildBackgroundRunner({ db, clock, config: TEST_CONFIG, shadow: true });

    // The composed loop wires the REAL dispatchRow (sink registry). If the shadow guard regressed,
    // the row would be leased and either dispatched or attempt-marked — the on-disk truth catches it.
    expect(await shadowHandles.drainOutboxOnce()).toBe(0);
    const after = await outboxRowOf(rowId);
    expect(after.state).toBe("pending");
    expect(after.leased_until).toBeNull();
    expect(after.attempts).toBe(0);
    expect(after.dispatched_at).toBeNull();
  });

  it("(3) OUTBOX PORT: shadow startWorkflow enqueues NO background job (would-enqueue log + sentinel); shadow=false enqueues", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const wfId = `cs12-recon/${randomUUID()}`;
    const call = startCall({
      workflowType: "reconcileInstallation",
      workflowId: wfId,
      args: [{ action: "created" }],
    });

    // SHADOW: no real background enqueue — the mandatory "no real review/background enqueue" half.
    const shadowPort = new BackgroundJobsTemporalPort({
      repo: new BackgroundJobsRepo(db),
      reviewJobs: new ReviewJobsRepo(db),
      workflowTypeToJobType: WORKFLOW_TYPE_TO_JOB_TYPE,
      shadow: true,
    });
    const sentinel = await shadowPort.startWorkflow(call, null);
    expect(sentinel).toContain("shadow");                        // a sentinel, never a real job_id
    expect(await jobsFor(wfId)).toHaveLength(0);                 // NO core.background_jobs row
    const wouldLogs = infoSpy.mock.calls.filter((c) => String(c[0]).includes("would-enqueue"));
    expect(wouldLogs.some((c) => String(c[0]).includes(wfId))).toBe(true);

    // CONTRAST (shadow=false): the SAME call enqueues — the existing cutover behavior.
    const realPort = new BackgroundJobsTemporalPort({
      repo: new BackgroundJobsRepo(db),
      reviewJobs: new ReviewJobsRepo(db),
      workflowTypeToJobType: WORKFLOW_TYPE_TO_JOB_TYPE,
    });
    const jobId = await realPort.startWorkflow(call, null);
    const rows = await jobsFor(wfId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.job_id).toBe(jobId);
  });

  it("(5) REAL HANDLER: refresh_semantic_docs with shadow deps never invokes its external stubs (clone / token / embed)", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const cloneCalls: Array<unknown> = [];
    const cloner: CacheGitCloner = {
      clone: async (args): Promise<void> => { cloneCalls.push(args); },
    };
    const tokenCalls: Array<number> = [];
    const emb = new RecordingEmbeddingsClient();
    const registry = new HandlerRegistry();
    registerEventHandlers(registry, {
      dsn: INTEGRATION_DSN!,
      refreshCloner: cloner,
      refreshGetToken: async (gid: number): Promise<string> => { tokenCalls.push(gid); return "tok"; },
      refreshEmbeddings: emb,
    });

    const handler = registry.get("refresh_semantic_docs")!;
    await handler(
      {
        schema_version: 1,
        installation_id: randomUUID(),
        repository_id: randomUUID(),
        triggered_by: "default_branch_push",
        head_sha: "f".repeat(40),
      },
      new AbortController().signal,
      fakeDeps("refresh_semantic_docs", true),
    );

    // The mandatory (c) suppression: NO external call started — not the clone, not the token mint,
    // not an embed. (The shadow=false contrast for this exact handler is the existing
    // event_handlers_knowledge suite, whose drives run with shadow=false deps.)
    expect(cloneCalls).toHaveLength(0);
    expect(tokenCalls).toHaveLength(0);
    expect(emb.callCount()).toBe(0);
    expect(infoSpy.mock.calls.some((c) =>
      String(c[0]).includes("would-run") && String(c[0]).includes("refresh_semantic_docs"))).toBe(true);
  });

  it("(6) RUNNER CLAIM: shadow runOneCycle never claims — the job stays 'ready' (work preserved); shadow=false settles it 'done'", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const jobType = `cs12-job-${randomUUID()}`;
    const ran: Array<string> = [];
    const shadowHandles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG, shadow: true });
    const realHandles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
    shadowHandles.registry.register(jobType, async () => { ran.push("shadow"); });
    realHandles.registry.register(jobType, async () => { ran.push("real"); });
    const repo = new BackgroundJobsRepo(db);
    const jobId = await repo.enqueue({ jobType, payload: { n: 1 } });

    // SHADOW: no claim (claiming stamps lease columns on core.background_jobs — a production
    // mutation — and a settle would CONSUME queued work the real cutover must still execute).
    const r = await shadowHandles.runOneCycle();
    expect(r.outcome).toBe("idle");
    expect(ran).toEqual([]);
    expect((await repo.getById(jobId))!.state).toBe("ready");    // untouched: preserved for cutover

    // CONTRAST (shadow=false): the SAME cycle claims, dispatches, settles — the existing behavior.
    const r2 = await realHandles.runOneCycle();
    expect(r2.outcome).toBe("done");
    expect(r2.jobId).toBe(jobId);
    expect(ran).toEqual(["real"]);
  });

  it("(7) IDLE MAINTENANCE: shadow runIdleMaintenance does NOT reap a stuck job; the real one reaps it to 'dead'", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const shadowHandles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG, shadow: true });
    const realHandles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
    const repo = new BackgroundJobsRepo(db);
    const jobId = await repo.enqueue({ jobType: `cs12-stuck-${randomUUID()}`, payload: {}, maxAttempts: 1 });
    // Force the reaper's exact predicate: leased + expired lease + attempts exhausted.
    await sql`UPDATE core.background_jobs
        SET state = 'leased', leased_until = now() - interval '1 minute', attempts = 1,
            lease_owner = 'cs12-shadow-test', attempt_token = gen_random_uuid()
      WHERE job_id = ${jobId}`.execute(db);

    await shadowHandles.runnerLoop.runIdleMaintenance();
    expect((await repo.getById(jobId))!.state).toBe("leased");   // NOT reaped — no production mutation

    await realHandles.runnerLoop.runIdleMaintenance();
    expect((await repo.getById(jobId))!.state).toBe("dead");     // the existing reap behavior
  });
});

// ─── (4) the handler dispatch seam — pure, no DB ─────────────────────────────────────────────────
describe("HandlerRegistry shadow guard (CS1.2 — every registered handler is wrapped)", () => {
  it("deps.shadow=true suppresses the handler body (would-run log); deps.shadow=false runs it", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const calls: Array<unknown> = [];
    const registry = new HandlerRegistry();
    registry.register("cs12-fake", async (payload) => { calls.push(payload); });
    const handler = registry.get("cs12-fake")!;

    await handler({ n: 1 }, new AbortController().signal, fakeDeps("cs12-fake", true));
    expect(calls).toHaveLength(0);                               // suppressed at the registry seam
    expect(infoSpy.mock.calls.some((c) =>
      String(c[0]).includes("would-run") && String(c[0]).includes("cs12-fake"))).toBe(true);

    await handler({ n: 2 }, new AbortController().signal, fakeDeps("cs12-fake", false));
    expect(calls).toEqual([{ n: 2 }]);                           // the existing behavior
    vi.restoreAllMocks();
  });
});
