// Phase 3d.3: the CUTOVER HINGE — BackgroundJobsTemporalPort + the flag-gated outbox sink port
// selection (resolveOutboxPort). With CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS=true the event-driven
// outbox sinks (`temporal_workflow_start` / `installation_reconcile`) ENQUEUE core.background_jobs
// rows instead of starting Temporal workflows; the default (unset/false) keeps the existing
// RealTemporalClient path byte-identical. Proves:
//   (1) TRANSLATION: startWorkflow({workflowType, workflowId, args:[input]}) enqueues ONE
//       background_job with job_type = WORKFLOW_TYPE_TO_JOB_TYPE[workflowType], payload = args[0]
//       (the producers' single positional workflow input — github_webhook_persistence.ts /
//       _repair_dispatcher.ts / _push_emitters.ts all stamp `args: [payload]`), dedup_key =
//       workflowId; the returned run_id-shaped string IS the enqueued job_id.
//   (1b) IDEMPOTENCY: a second startWorkflow with the SAME workflowId while the first job is ACTIVE
//       returns the SAME job_id (the dedup overlap=SKIP analogue of id_conflict_policy USE_EXISTING).
//   (2) FAIL-LOUD: an UNMAPPED workflowType (e.g. the unmigrated `reviewPullRequest`) throws
//       PermanentSinkError naming the workflow_type — never a silent drop; nothing is enqueued.
//   (3) FAIL-LOUD: a non-1-element / non-object `args` shape throws BEFORE any enqueue.
//   (4) cancelWorkflow / signalWorkflow throw — the outbox sinks only ever call startWorkflow (the
//       review supersede path is DB flipCurrentRun, not a Temporal signal; admin-console signals
//       ride _admin_temporal_port.ts, a different port wiring entirely).
//   (5) FLAG SELECTION: resolveOutboxPort returns the caller's Temporal port when the flag is
//       unset/false/0 (the DEFAULT — additive + cold until Phase 4), a BackgroundJobsTemporalPort
//       when true/1 (without ever invoking the Temporal-port thunk), and throws on garbage.
//   (6) END-TO-END CUTOVER PARITY (flag ON): a seeded `temporal_workflow_start` outbox row → ONE
//       drain pass (buildBackgroundRunner.drainOutboxOnce → the registered sink →
//       BackgroundJobsTemporalPort.enqueue) → ONE runner cycle (runOneCycle → reconcile handler) →
//       the reconcile DB effect lands on core.installations and the outbox row is 'dispatched'.
//       webhook-shape → outbox → Postgres-enqueue → handler: ZERO Temporal anywhere in the chain
//       (the Temporal-port thunk THROWS if touched).
//   (7) Same end-to-end through the `installation_reconcile` sink, seeded via the REAL producer
//       repo call (PostgresOutboxRepo.appendReconcile — the exact byte path
//       github_webhook_persistence.ts writes, NULL installation_id schema exemption included).
//   (8) FLAG OFF (default): the SAME sink + drain pass routes the row to the Temporal port
//       (RecordingTemporalClient observes the startWorkflow call) and NO background_job is enqueued.
//
// Determinism note (the W4 suite's proven pattern): drain passes + runner cycles run under a
// WallClock composition; generous ceilings (ms-fast upserts never graze them) keep outcomes
// deterministic without timing sensitivity.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { randomInt, randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { WallClock } from "#platform/clock.js";
import { disposePool } from "#platform/db/database.js";
import {
  RecordingTemporalClient,
  type StartWorkflowCall,
  type TemporalClientPort,
} from "#backend/adapters/temporal_port.js";
import {
  PostgresOutboxRepo,
  RECONCILE_PAYLOAD_SCHEMA_VERSION,
} from "#backend/domain/repos/outbox_repo.js";
import { PermanentSinkError, resetRegistryForTesting } from "#backend/outbox/sink_registry.js";
import { registerInstallationReconcileSink } from "#backend/outbox/sinks/installation_reconcile.js";
import { registerTemporalWorkflowStartSink } from "#backend/outbox/sinks/temporal_workflow_start.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import {
  BackgroundJobsTemporalPort,
  OUTBOX_USE_BACKGROUND_JOBS_ENV,
  resolveOutboxPort,
} from "#backend/runner/background_jobs_temporal_port.js";
import {
  buildBackgroundRunner,
  type BackgroundRunnerConfig,
} from "#backend/runner/background_runner_main.js";
import { WORKFLOW_TYPE_TO_JOB_TYPE } from "#backend/runner/workflow_job_map.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }

/** Unique GitHub surrogate installation ids, tracked for teardown (the reconcile suite's idiom; a
 *  DISTINCT range from event_handlers_reconcile's 2.0–2.08B so concurrent leftovers never collide). */
const ghIids: Array<number> = [];
function nextGhIid(): number {
  const v = randomInt(2_080_000_000, 2_120_000_000);
  ghIids.push(v);
  return v;
}

beforeAll(() => {
  if (!INTEGRATION_DSN) return;
  // The reconcile activity self-resolves the DSN from process.env (no injection seam — 1:1 with its
  // Temporal dispatch); mirror the test DSN so the activity pool hits the disposable DB.
  process.env.CODEMASTER_PG_CORE_DSN = INTEGRATION_DSN;
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  resetRegistryForTesting(); // leave the module-global sink registry clean for any same-process suite
  if (ghIids.length > 0) {
    // core.users / core.repositories FK rows cascade with the installations DELETE (confdeltype 'c').
    await pool.query(`DELETE FROM core.installations WHERE github_installation_id = ANY($1::bigint[])`, [
      ghIids,
    ]);
    await pool.query(`DELETE FROM core.ad_users WHERE principal_name LIKE 'cutover-%@acme.com'`);
  }
  await db?.destroy();                       // the test's OWN pool
  // The reconcile activity resolves the shared platform pool from CODEMASTER_PG_CORE_DSN; dispose it.
  await disposePool(INTEGRATION_DSN);
});

// AUTHORIZED DEVIATION (test isolation — same rationale as outbox_dispatcher_loop /
// event_handlers_reconcile): vitest.config.ts shuffles test order, and both claim scans
// (claimPendingRows over core.outbox; claim over core.background_jobs) are table-wide, so per-test
// wipes keep claim counts + dedup assertions exact. Safe because test:integration runs
// --no-file-parallelism (files never interleave) and the other writers clean their own rows. The
// module-global sink registry is reset per test for the same reason (each test wires its OWN port).
beforeEach(async () => {
  resetRegistryForTesting();
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.background_jobs`.execute(db);
    await sql`DELETE FROM core.outbox`.execute(db);
  }
});

/** Bounded test config (the W4 suite's proven shape): generous ceilings (ms-fast upserts never graze
 *  them), huge sleeps (the single-shot drive seams never enter them). */
const TEST_CONFIG: BackgroundRunnerConfig = {
  owner: "cutover-port-test", leaseS: 30, heartbeatS: 5, maxRuntimeS: 300, idleS: 30,
  pollIntervalS: 600, outboxIdleS: 600, outboxMaxAttempts: 5,
};

/** Serialized GitHubInstallationPayloadV1 dict (the bare-dict workflow input the producers stamp as
 *  the single `args[0]` element — github_webhook_persistence.ts builds exactly this shape). */
function installationPayload(args: {
  action: "created" | "deleted" | "suspended" | "unsuspended";
  gid: number;
  login: string;
}): Record<string, unknown> {
  return {
    action: args.action,
    installation: {
      id: args.gid,
      account: { id: args.gid, login: args.login, type: "Organization" },
    },
    sender: { id: args.gid + 1, login: args.login, type: "User" },
  };
}

/** A StartWorkflowCall with the producers' envelope defaults (the shape the sink handler constructs
 *  after TemporalWorkflowStartPayloadV1.parse fills timeouts/search_attributes). */
function startCall(o: {
  workflowType: string;
  workflowId: string;
  args: ReadonlyArray<unknown>;
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

type JobRow = {
  job_id: string; job_type: string; payload: Record<string, unknown>;
  dedup_key: string | null; state: string;
};
async function allJobs(): Promise<Array<JobRow>> {
  const r = await sql<JobRow>`SELECT job_id, job_type, payload, dedup_key, state
    FROM core.background_jobs ORDER BY created_at`.execute(db);
  return r.rows;
}

/** The producers' reconcile envelope (byte-shape of github_webhook_persistence.ts's `envelope`). */
function reconcileEnvelope(o: { gid: number; login: string; action: "created" | "suspended" }): Record<string, unknown> {
  return {
    workflow_type: "reconcileInstallation",
    workflow_id: `reconcile-installation/${o.gid}`,
    task_queue: "review-default",
    args: [installationPayload({ action: o.action, gid: o.gid, login: o.login })],
    id_reuse_policy: "ALLOW_DUPLICATE",
    id_conflict_policy: "USE_EXISTING",
  };
}

/** A Temporal-port thunk that MUST NOT be reached (flag-ON paths never build a Temporal client). */
function forbiddenTemporalPort(): never {
  throw new Error("makeTemporalPort must not be invoked when the cutover flag is ON");
}

describeDb("BackgroundJobsTemporalPort + flag-gated outbox sink port (Phase 3d.3 cutover hinge)", () => {
  it("(1) startWorkflow translates workflowType→job_type, args[0]→payload, workflowId→dedup_key; returns the job_id", async () => {
    const gid = nextGhIid();
    const login = `cutover-${gid}`;
    const repo = new BackgroundJobsRepo(db);
    const port = new BackgroundJobsTemporalPort({
      repo,
      workflowTypeToJobType: WORKFLOW_TYPE_TO_JOB_TYPE,
    });

    const input = installationPayload({ action: "created", gid, login });
    const jobId = await port.startWorkflow(
      startCall({ workflowType: "reconcileInstallation", workflowId: "wf-x", args: [input] }),
    );

    const jobs = await allJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job_id).toBe(jobId);           // the returned "run id" IS the enqueued job_id
    expect(jobs[0]!.job_type).toBe("reconcile_installation");
    expect(jobs[0]!.payload).toEqual(input);       // payload = the single positional workflow input
    expect(jobs[0]!.dedup_key).toBe("wf-x");
    expect(jobs[0]!.state).toBe("ready");
  });

  it("(1b) a second startWorkflow with the SAME workflowId while the job is active returns the SAME job_id (USE_EXISTING analogue)", async () => {
    const gid = nextGhIid();
    const login = `cutover-${gid}`;
    const port = new BackgroundJobsTemporalPort({
      repo: new BackgroundJobsRepo(db),
      workflowTypeToJobType: WORKFLOW_TYPE_TO_JOB_TYPE,
    });
    const call = startCall({
      workflowType: "reconcileInstallation",
      workflowId: `reconcile-installation/${gid}`,
      args: [installationPayload({ action: "created", gid, login })],
    });

    const first = await port.startWorkflow(call);
    const second = await port.startWorkflow(call);
    expect(second).toBe(first);                    // dedup overlap=SKIP coalesced the re-dispatch
    expect(await allJobs()).toHaveLength(1);
  });

  it("(2) an UNMAPPED workflowType throws PermanentSinkError naming it; nothing is enqueued", async () => {
    const port = new BackgroundJobsTemporalPort({
      repo: new BackgroundJobsRepo(db),
      workflowTypeToJobType: WORKFLOW_TYPE_TO_JOB_TYPE,
    });
    const call = startCall({ workflowType: "reviewPullRequest", workflowId: "wf-rev", args: [{ a: 1 }] });

    await expect(port.startWorkflow(call)).rejects.toBeInstanceOf(PermanentSinkError);
    await expect(port.startWorkflow(call)).rejects.toThrow(/reviewPullRequest/);
    // Prototype-chain lookups must NOT resolve ("constructor" is a function on a raw record).
    await expect(
      port.startWorkflow(startCall({ workflowType: "constructor", workflowId: "wf-c", args: [{}] })),
    ).rejects.toBeInstanceOf(PermanentSinkError);
    expect(await allJobs()).toHaveLength(0);
  });

  it("(3) a non-1-element or non-object args shape throws BEFORE any enqueue", async () => {
    const port = new BackgroundJobsTemporalPort({
      repo: new BackgroundJobsRepo(db),
      workflowTypeToJobType: WORKFLOW_TYPE_TO_JOB_TYPE,
    });
    const base = { workflowType: "reconcileInstallation", workflowId: "wf-args" };

    await expect(port.startWorkflow(startCall({ ...base, args: [] }))).rejects.toBeInstanceOf(PermanentSinkError);
    await expect(port.startWorkflow(startCall({ ...base, args: [{}, {}] }))).rejects.toBeInstanceOf(PermanentSinkError);
    await expect(port.startWorkflow(startCall({ ...base, args: ["not-an-object"] }))).rejects.toBeInstanceOf(PermanentSinkError);
    await expect(port.startWorkflow(startCall({ ...base, args: [[1, 2]] }))).rejects.toBeInstanceOf(PermanentSinkError);
    expect(await allJobs()).toHaveLength(0);
  });

  it("(4) cancelWorkflow / signalWorkflow throw — the outbox sinks only start", async () => {
    // Widened to the PORT type — the realistic caller view (the concrete class omits the params
    // entirely; a TS implementation may take fewer params than its interface).
    const port: TemporalClientPort = new BackgroundJobsTemporalPort({
      repo: new BackgroundJobsRepo(db),
      workflowTypeToJobType: WORKFLOW_TYPE_TO_JOB_TYPE,
    });
    await expect(port.cancelWorkflow({ workflowId: "wf-x" })).rejects.toThrow(/not supported/);
    await expect(
      port.signalWorkflow({ workflowId: "wf-x", signalName: "s", payload: {} }),
    ).rejects.toThrow(/not supported/);
  });

  it("(5) resolveOutboxPort: default/false → the caller's Temporal port; true/1 → BackgroundJobsTemporalPort; garbage → throws", async () => {
    const repo = new BackgroundJobsRepo(db);
    const recording = new RecordingTemporalClient();

    // DEFAULT (unset) + every explicit OFF spelling → EXACTLY the caller's Temporal port instance.
    for (const env of [{}, { [OUTBOX_USE_BACKGROUND_JOBS_ENV]: "" },
      { [OUTBOX_USE_BACKGROUND_JOBS_ENV]: "false" }, { [OUTBOX_USE_BACKGROUND_JOBS_ENV]: "0" }]) {
      expect(
        await resolveOutboxPort({ env, backgroundJobs: repo, makeTemporalPort: () => recording }),
      ).toBe(recording);
    }

    // ON spellings → the Postgres-enqueue port; the Temporal-port thunk is NEVER invoked.
    for (const on of ["true", "1"]) {
      const port = await resolveOutboxPort({
        env: { [OUTBOX_USE_BACKGROUND_JOBS_ENV]: on },
        backgroundJobs: repo,
        makeTemporalPort: forbiddenTemporalPort,
      });
      expect(port).toBeInstanceOf(BackgroundJobsTemporalPort);
    }

    // Garbage is a refused boot, not a silent default — this flag is the Phase-4 cutover hinge.
    await expect(
      resolveOutboxPort({
        env: { [OUTBOX_USE_BACKGROUND_JOBS_ENV]: "yes" },
        backgroundJobs: repo,
        makeTemporalPort: () => recording,
      }),
    ).rejects.toThrow(/CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS/);
  });

  it("(6) E2E flag ON: temporal_workflow_start outbox row → drain pass enqueues the job → runner cycle applies the reconcile; ZERO Temporal", async () => {
    const gid = nextGhIid();
    const login = `cutover-${gid}`;
    // Seed the installations row directly (the repair-suite idiom): it carries the outbox row's
    // NOT-NULL installation_id FK AND gives the 'suspended' reconcile a row to stamp.
    const ins = await pool.query<{ installation_id: string }>(
      `INSERT INTO core.installations (github_installation_id, account_login, account_type)
       VALUES ($1, $2, 'Organization') RETURNING installation_id`,
      [gid, login],
    );
    const installationUuid = ins.rows[0]!.installation_id;

    // The cutover wiring: flag ON → BackgroundJobsTemporalPort registered under BOTH sink names.
    const port = await resolveOutboxPort({
      env: { [OUTBOX_USE_BACKGROUND_JOBS_ENV]: "true" },
      backgroundJobs: new BackgroundJobsRepo(db),
      makeTemporalPort: forbiddenTemporalPort,
    });
    registerTemporalWorkflowStartSink(port);
    registerInstallationReconcileSink(port);

    // A `temporal_workflow_start` row carrying the producers' envelope (workflow_type + args:[input]).
    const envelope = reconcileEnvelope({ gid, login, action: "suspended" });
    await sql`INSERT INTO core.outbox
        (id, sink, payload, schema_version, run_id, trace_context, delivery_id, installation_id)
      VALUES (${randomUUID()}, 'temporal_workflow_start', CAST(${JSON.stringify(envelope)} AS JSONB), 2,
              NULL, CAST('{}' AS JSONB), ${`cutover-it6-${gid}`}, ${installationUuid})`.execute(db);

    const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });

    // ONE drain pass: outbox row → sink → BackgroundJobsTemporalPort → core.background_jobs.
    expect(await handles.drainOutboxOnce()).toBe(1);
    const outboxRow = await sql<{ state: string; last_error: string | null }>`
      SELECT state, last_error FROM core.outbox WHERE delivery_id = ${`cutover-it6-${gid}`}`.execute(db);
    expect(outboxRow.rows[0]!.state).toBe("dispatched");
    expect(outboxRow.rows[0]!.last_error).toBeNull();
    const jobs = await allJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job_type).toBe("reconcile_installation");
    expect(jobs[0]!.dedup_key).toBe(`reconcile-installation/${gid}`); // workflow_id → dedup_key
    expect(jobs[0]!.payload).toEqual(installationPayload({ action: "suspended", gid, login }));

    // ONE runner cycle: the registered reconcile_installation handler applies the DB effect.
    const cycle = await handles.runOneCycle();
    expect(cycle.outcome).toBe("done");
    expect(cycle.jobId).toBe(jobs[0]!.job_id);
    const after = await pool.query<{ suspended_at: Date | null }>(
      `SELECT suspended_at FROM core.installations WHERE github_installation_id = $1`,
      [gid],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]!.suspended_at).not.toBeNull(); // webhook-shape → outbox → job → handler: DONE
  });

  it("(7) E2E flag ON through the installation_reconcile sink, seeded via the REAL producer append (appendReconcile)", async () => {
    const gid = nextGhIid();
    const login = `cutover-${gid}`;
    const port = await resolveOutboxPort({
      env: { [OUTBOX_USE_BACKGROUND_JOBS_ENV]: "true" },
      backgroundJobs: new BackgroundJobsRepo(db),
      makeTemporalPort: forbiddenTemporalPort,
    });
    registerTemporalWorkflowStartSink(port);
    registerInstallationReconcileSink(port);

    // The byte-faithful producer path (github_webhook_persistence.ts): sink='installation_reconcile',
    // NULL installation_id (the ck_outbox_installation_id_required exemption), envelope payload.
    await new PostgresOutboxRepo().appendReconcile({
      db,
      payload: reconcileEnvelope({ gid, login, action: "created" }),
      schemaVersion: RECONCILE_PAYLOAD_SCHEMA_VERSION,
      deliveryId: `cutover-it7-${gid}`,
    });

    const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
    expect(await handles.drainOutboxOnce()).toBe(1);
    const jobs = await allJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job_type).toBe("reconcile_installation");

    expect((await handles.runOneCycle()).outcome).toBe("done");
    const created = await pool.query<{ account_login: string; suspended_at: Date | null }>(
      `SELECT account_login, suspended_at FROM core.installations WHERE github_installation_id = $1`,
      [gid],
    );
    expect(created.rows).toHaveLength(1);          // the reconcile handler CREATED the installation
    expect(created.rows[0]!.account_login).toBe(login);
    expect(created.rows[0]!.suspended_at).toBeNull();
  });

  it("(8) flag OFF (default): the SAME sink + drain pass starts on the Temporal port; NO background_job is enqueued", async () => {
    const gid = nextGhIid();
    const login = `cutover-${gid}`;
    const recording = new RecordingTemporalClient();
    const port = await resolveOutboxPort({
      env: {},                                     // DEFAULT — the flag is absent
      backgroundJobs: new BackgroundJobsRepo(db),
      makeTemporalPort: () => recording,
    });
    expect(port).toBe(recording);                  // selection: the existing Temporal port, unchanged
    registerTemporalWorkflowStartSink(port);
    registerInstallationReconcileSink(port);

    await new PostgresOutboxRepo().appendReconcile({
      db,
      payload: reconcileEnvelope({ gid, login, action: "created" }),
      schemaVersion: RECONCILE_PAYLOAD_SCHEMA_VERSION,
      deliveryId: `cutover-it8-${gid}`,
    });

    const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
    expect(await handles.drainOutboxOnce()).toBe(1);

    // The row dispatched via startWorkflow on the TEMPORAL port — the pre-cutover behavior.
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]!.workflowType).toBe("reconcileInstallation");
    expect(recording.calls[0]!.workflowId).toBe(`reconcile-installation/${gid}`);
    expect(recording.calls[0]!.args).toEqual([installationPayload({ action: "created", gid, login })]);
    expect(await allJobs()).toHaveLength(0);       // NOTHING enqueued on the Postgres platform
    const outboxRow = await sql<{ state: string }>`
      SELECT state FROM core.outbox WHERE delivery_id = ${`cutover-it8-${gid}`}`.execute(db);
    expect(outboxRow.rows[0]!.state).toBe("dispatched");
  });
});
