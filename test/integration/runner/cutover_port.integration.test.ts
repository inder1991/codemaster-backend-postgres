// Phase 3d.3, reshaped by CS1.1: the CUTOVER HINGE — BackgroundJobsTemporalPort + the runner's
// ALWAYS-POSTGRES sink wiring (wireOutboxSinks). The event-driven outbox sinks
// (`temporal_workflow_start` / `installation_reconcile`) ENQUEUE core.background_jobs /
// core.review_jobs rows instead of starting Temporal workflows — unconditionally: the old
// flag-gated selection (CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS / resolveOutboxPort, with a
// RealTemporalClient fallback) is REMOVED because the runner only boots under
// CODEMASTER_RUNTIME_MODE=postgres|shadow, where Temporal is absent by construction
// (boot_tasks.ts mutual exclusivity; temporal-mode outbox draining is the separate Temporal
// dispatcher worker, outbox_dispatcher_main.ts). Proves:
//   (1) TRANSLATION: startWorkflow({workflowType, workflowId, args:[input]}) enqueues ONE
//       background_job with job_type = WORKFLOW_TYPE_TO_JOB_TYPE[workflowType], payload = args[0]
//       (the producers' single positional workflow input — github_webhook_persistence.ts /
//       _repair_dispatcher.ts / _push_emitters.ts all stamp `args: [payload]`), dedup_key =
//       workflowId; the returned run_id-shaped string IS the enqueued job_id.
//   (1b) IDEMPOTENCY: a second startWorkflow with the SAME workflowId while the first job is ACTIVE
//       returns the SAME job_id (the dedup overlap=SKIP analogue of id_conflict_policy USE_EXISTING).
//   (2) FAIL-LOUD: an UNMAPPED workflowType (a bogus never-migrated string) throws
//       PermanentSinkError naming the workflow_type — never a silent drop; nothing is enqueued.
//   (3) FAIL-LOUD: a non-1-element / non-object `args` shape throws BEFORE any enqueue.
//   (4) cancelWorkflow / signalWorkflow throw — the outbox sinks only ever call startWorkflow (the
//       review supersede path is DB flipCurrentRun, not a Temporal signal; admin-console signals
//       are synchronous DB transitions in the admin routes, a different concern entirely).
//   (6) END-TO-END CUTOVER PARITY: a seeded `temporal_workflow_start` outbox row → ONE drain pass
//       (buildBackgroundRunner.drainOutboxOnce → the registered sink →
//       BackgroundJobsTemporalPort.enqueue) → ONE runner cycle (runOneCycle → reconcile handler) →
//       the reconcile DB effect lands on core.installations and the outbox row is 'dispatched'.
//       webhook-shape → outbox → Postgres-enqueue → handler: ZERO Temporal anywhere in the chain.
//       (6)/(7)/(11) drive wireOutboxSinks — the runner's REAL boot wiring (CS1.1: it binds BOTH
//       sinks to the Postgres-enqueue port unconditionally), so these chains exercise the exact
//       production composition, not a hand-built port.
//   (7) Same end-to-end through the `installation_reconcile` sink, seeded via the REAL producer
//       repo call (PostgresOutboxRepo.appendReconcile — the exact byte path
//       github_webhook_persistence.ts writes, NULL installation_id schema exemption included).
//
// Phase 4d W4d.1 (F6 — the review trigger leaves Temporal): `reviewPullRequest` is SPECIAL-CASED
// onto the REVIEW-JOBS platform (core.review_jobs — the runner the review shell executes), NOT the
// generic background_jobs map:
//   (9) startWorkflow('reviewPullRequest', args:[allocated ReviewPullRequestPayloadV1]) enqueues
//       ONE core.review_jobs row carrying the payload's run_id/review_id/installation_id + the
//       payload itself (ReviewJobsRepo.enqueue validates + canonicalizes + hashes it); the returned
//       string is the review job_id; NOTHING lands on core.background_jobs.
//   (10) FAIL-LOUD: a reviewPullRequest row whose args[0] does NOT parse as
//       ReviewPullRequestPayloadV1 throws PermanentSinkError; NEITHER table gets a row.
//   (11) END-TO-END: a seeded `temporal_workflow_start` outbox row stamped with the REAL
//       producer envelope shape (github_webhook_persistence.ts::buildOuterPayload — workflow_type
//       'reviewPullRequest', args:[the fully-allocated payload]) → ONE drain pass → the outbox row
//       is 'dispatched' and core.review_jobs (NOT background_jobs) carries the job.
//   (12) Every MAPPED event workflow_type still routes onto core.background_jobs (and never onto
//       review_jobs) — the 6-entry WORKFLOW_TYPE_TO_JOB_TYPE registry is unchanged by the special-case.
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
  type StartWorkflowCall,
  type TemporalClientPort,
} from "#backend/adapters/temporal_port.js";
import {
  PostgresOutboxRepo,
  RECONCILE_PAYLOAD_SCHEMA_VERSION,
} from "#backend/domain/repos/outbox_repo.js";
import { PermanentSinkError, resetRegistryForTesting } from "#backend/outbox/sink_registry.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { BackgroundJobsTemporalPort } from "#backend/runner/background_jobs_temporal_port.js";
import {
  buildBackgroundRunner,
  wireOutboxSinks,
  type BackgroundRunnerConfig,
} from "#backend/runner/background_runner_main.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { WORKFLOW_TYPE_TO_JOB_TYPE } from "#backend/runner/workflow_job_map.js";
import { type ReviewPullRequestPayloadV1 } from "#contracts/review_pull_request.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { minimalReviewPayload, seedRun } from "./_fixtures.js";

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

/** Seeded review chains (pull_request_reviews → review_runs, via the shared {@link seedRun} fixture),
 *  tracked for afterAll teardown — review_jobs.run_id is FK-anchored on review_runs, so the W4d.1
 *  review-route tests need real run rows. */
const seededRuns: Array<{ runId: string; reviewId: string }> = [];
async function seedRunTracked(): Promise<{ runId: string; reviewId: string; installationId: string }> {
  const s = await seedRun(db);
  seededRuns.push({ runId: s.runId, reviewId: s.reviewId });
  return s;
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
  if (seededRuns.length > 0) {
    // FK order: review_jobs → review_runs → pull_request_reviews (the seedRun chain).
    const runIds = seededRuns.map((s) => s.runId);
    const reviewIds = seededRuns.map((s) => s.reviewId);
    await pool.query(`DELETE FROM core.review_jobs WHERE run_id = ANY($1::uuid[])`, [runIds]);
    await pool.query(`DELETE FROM core.review_runs WHERE run_id = ANY($1::uuid[])`, [runIds]);
    await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = ANY($1::uuid[])`, [reviewIds]);
  }
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
// event_handlers_reconcile / review_jobs_repo): vitest.config.ts shuffles test order, and the claim
// scans (claimPendingRows over core.outbox; claim over core.background_jobs / core.review_jobs) are
// table-wide, so per-test wipes keep claim counts + dedup + the W4d.1 routing assertions exact. Safe
// because test:integration runs --no-file-parallelism (files never interleave) and the other writers
// clean their own rows. The module-global sink registry is reset per test for the same reason (each
// test wires its OWN port).
beforeEach(async () => {
  resetRegistryForTesting();
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.background_jobs`.execute(db);
    await sql`DELETE FROM core.review_jobs`.execute(db);
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
  dedup_key: string | null; state: string; installation_id: string | null; max_attempts: number;
};
async function allJobs(): Promise<Array<JobRow>> {
  const r = await sql<JobRow>`SELECT job_id, job_type, payload, dedup_key, state, installation_id, max_attempts
    FROM core.background_jobs ORDER BY created_at`.execute(db);
  return r.rows;
}

type ReviewJobRow = {
  job_id: string; run_id: string; review_id: string; installation_id: string;
  delivery_id: string | null; payload: Record<string, unknown>; state: string;
};
async function allReviewJobs(): Promise<Array<ReviewJobRow>> {
  // tenant:exempt reason=test-assertion-scan follow_up=FOLLOW-UP-gf3-error-mode
  const r = await sql<ReviewJobRow>`SELECT job_id, run_id, review_id, installation_id, delivery_id, payload, state
    FROM core.review_jobs ORDER BY created_at`.execute(db);
  return r.rows;
}

/** The cutover port over BOTH platform repos (W4d.1: review_jobs joined background_jobs). */
function makeCutoverPort(): BackgroundJobsTemporalPort {
  return new BackgroundJobsTemporalPort({
    repo: new BackgroundJobsRepo(db),
    reviewJobs: new ReviewJobsRepo(db),
    workflowTypeToJobType: WORKFLOW_TYPE_TO_JOB_TYPE,
  });
}

/** The REAL review producer envelope (byte-shape of github_webhook_persistence.ts::buildOuterPayload).
 *  The workflow_type literal is deliberately HARDCODED here — the test pins the byte string the
 *  producer stamps on outbox rows, independent of the production const. */
function reviewStartEnvelope(payload: ReviewPullRequestPayloadV1): Record<string, unknown> {
  return {
    workflow_type: "reviewPullRequest",
    workflow_id: `review/${payload.installation_id}/${payload.repository_id}/${payload.pr_number}`,
    task_queue: "review-default",
    args: [payload],
    id_reuse_policy: "ALLOW_DUPLICATE",
    id_conflict_policy: "USE_EXISTING",
    execution_timeout_seconds: 1800,
    run_timeout_seconds: 1800,
  };
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

describeDb("BackgroundJobsTemporalPort + the runner's always-Postgres sink wiring (Phase 3d.3 cutover hinge, CS1.1)", () => {
  it("(1) startWorkflow translates workflowType→job_type, args[0]→payload, workflowId→dedup_key; returns the job_id", async () => {
    const gid = nextGhIid();
    const login = `cutover-${gid}`;
    const port = makeCutoverPort();

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
    const port = makeCutoverPort();
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

  it("(1c) startWorkflow threads the caller's installationId onto the enqueued row; omitted → NULL (platform-scoped)", async () => {
    // W4b.1 review blocker #1 (tenant identity lost in cutover) — port-level half: the port's
    // 2nd param lands as core.background_jobs.installation_id (the column is FK-free by design,
    // so any UUID exercises it).
    const gid = nextGhIid();
    const login = `cutover-${gid}`;
    const port = makeCutoverPort();
    const tenantUuid = randomUUID();
    const input = installationPayload({ action: "created", gid, login });

    await port.startWorkflow(
      startCall({ workflowType: "reconcileInstallation", workflowId: "wf-tenant", args: [input] }),
      tenantUuid,
    );
    await port.startWorkflow(
      startCall({ workflowType: "reconcileInstallation", workflowId: "wf-platform", args: [input] }),
      // installationId omitted — the platform-scoped (NULL) default
    );

    const jobs = await allJobs();
    expect(jobs).toHaveLength(2);
    const byKey = new Map(jobs.map((j) => [j.dedup_key, j]));
    expect(byKey.get("wf-tenant")!.installation_id).toBe(tenantUuid);   // tenant identity SURVIVES
    expect(byKey.get("wf-platform")!.installation_id).toBeNull();       // platform-scoped by design
  });

  it("(1d) per-workflow-type retry budgets survive the cutover (RC5 / W1.9d): each mapped job_type keeps its Temporal attempt budget", async () => {
    // The Temporal proxies carried tuned per-workflow curves; the platform must enqueue each
    // job_type with ITS budget on max_attempts, not the repo default (3) — otherwise an
    // out-of-order `installation_repositories` webhook (H4) dead-letters in ~3s instead of
    // redriving across the Temporal-parity window. Parity sources pinned in
    // test/unit/runner/workflow_job_map.test.ts.
    const port = makeCutoverPort();
    for (const workflowType of Object.keys(WORKFLOW_TYPE_TO_JOB_TYPE)) {
      await port.startWorkflow(
        startCall({ workflowType, workflowId: `budget-${workflowType}`, args: [{ probe: 1 }] }),
      );
    }

    const byType = new Map((await allJobs()).map((j) => [j.job_type, j.max_attempts]));
    expect(byType.get("reconcile_installation")).toBe(5);
    expect(byType.get("reconcile_repositories")).toBe(10); // the H4 out-of-order absorption window
    expect(byType.get("repair_installation_repositories")).toBe(12); // the GitHub-outage hydrate window
    expect(byType.get("sync_code_owners")).toBe(5);
    expect(byType.get("refresh_semantic_docs")).toBe(3);
    expect(byType.get("trigger_page_resync")).toBe(3);
  });

  it("(2) an UNMAPPED workflowType throws PermanentSinkError naming it; nothing is enqueued", async () => {
    const port = makeCutoverPort();
    const call = startCall({ workflowType: "someNeverMigratedWorkflow", workflowId: "wf-bogus", args: [{ a: 1 }] });

    await expect(port.startWorkflow(call)).rejects.toBeInstanceOf(PermanentSinkError);
    await expect(port.startWorkflow(call)).rejects.toThrow(/someNeverMigratedWorkflow/);
    // Prototype-chain lookups must NOT resolve ("constructor" is a function on a raw record).
    await expect(
      port.startWorkflow(startCall({ workflowType: "constructor", workflowId: "wf-c", args: [{}] })),
    ).rejects.toBeInstanceOf(PermanentSinkError);
    expect(await allJobs()).toHaveLength(0);
  });

  it("(3) a non-1-element or non-object args shape throws BEFORE any enqueue", async () => {
    const port = makeCutoverPort();
    const base = { workflowType: "reconcileInstallation", workflowId: "wf-args" };

    await expect(port.startWorkflow(startCall({ ...base, args: [] }))).rejects.toBeInstanceOf(PermanentSinkError);
    await expect(port.startWorkflow(startCall({ ...base, args: [{}, {}] }))).rejects.toBeInstanceOf(PermanentSinkError);
    await expect(port.startWorkflow(startCall({ ...base, args: ["not-an-object"] }))).rejects.toBeInstanceOf(PermanentSinkError);
    await expect(port.startWorkflow(startCall({ ...base, args: [[1, 2]] }))).rejects.toBeInstanceOf(PermanentSinkError);
    expect(await allJobs()).toHaveLength(0);
  });

  it("(3b) a DEEP non-JSON payload value (NaN) on the background route throws PermanentSinkError — deterministic poison never burns the outbox retry curve (W1.9e)", async () => {
    // BackgroundJobsRepo.enqueue's strict JSON-tree validation (W4c.1 #9) throws a ZodError on a
    // nested NaN/undefined/Date — the SAME bytes fail identically on every redelivery, so the
    // dispatch path must classify it PERMANENT (dead-letter on attempt 1), not retryable noise.
    const port = makeCutoverPort();
    const call = startCall({
      workflowType: "reconcileInstallation",
      workflowId: "wf-deep-poison",
      args: [{ nested: { bad: Number.NaN } }],
    });

    await expect(port.startWorkflow(call)).rejects.toBeInstanceOf(PermanentSinkError);
    await expect(port.startWorkflow(call)).rejects.toThrow(/reconcileInstallation/);
    expect(await allJobs()).toHaveLength(0);
  });

  it("(4) cancelWorkflow / signalWorkflow throw — the outbox sinks only start", async () => {
    // Widened to the PORT type — the realistic caller view (the concrete class omits the params
    // entirely; a TS implementation may take fewer params than its interface).
    const port: TemporalClientPort = makeCutoverPort();
    await expect(port.cancelWorkflow({ workflowId: "wf-x" })).rejects.toThrow(/not supported/);
    await expect(
      port.signalWorkflow({ workflowId: "wf-x", signalName: "s", payload: {} }),
    ).rejects.toThrow(/not supported/);
  });

  it("(6) E2E (runner boot wiring): temporal_workflow_start outbox row → drain pass enqueues the job → runner cycle applies the reconcile; ZERO Temporal", async () => {
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

    // The runner's REAL boot wiring (CS1.1): BOTH sinks bound to the Postgres-enqueue port,
    // unconditionally — no flag, no Temporal client anywhere in this process.
    wireOutboxSinks(db);

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
    // W4b.1 review blocker #1 — full-chain half: the outbox row's installation_id rode
    // DispatchRow → SinkContext → sink handler → port → enqueue; tenant identity SURVIVES cutover.
    expect(jobs[0]!.installation_id).toBe(installationUuid);

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

  it("(7) E2E through the installation_reconcile sink, seeded via the REAL producer append (appendReconcile)", async () => {
    const gid = nextGhIid();
    const login = `cutover-${gid}`;
    wireOutboxSinks(db);

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
    // appendReconcile writes a NULL-installation_id outbox row (the schema exemption) → the
    // SinkContext carries installationId=null → the job stays platform-scoped (NULL) by design.
    expect(jobs[0]!.installation_id).toBeNull();

    expect((await handles.runOneCycle()).outcome).toBe("done");
    const created = await pool.query<{ account_login: string; suspended_at: Date | null }>(
      `SELECT account_login, suspended_at FROM core.installations WHERE github_installation_id = $1`,
      [gid],
    );
    expect(created.rows).toHaveLength(1);          // the reconcile handler CREATED the installation
    expect(created.rows[0]!.account_login).toBe(login);
    expect(created.rows[0]!.suspended_at).toBeNull();
  });

  // ─── Phase 4d W4d.1 (F6): the review trigger routes onto the REVIEW-JOBS platform ──────────────

  it("(9) startWorkflow('reviewPullRequest') enqueues a core.review_jobs row — NOT a background_job — carrying run_id/review_id/installation_id/payload", async () => {
    const s = await seedRunTracked();
    const payload = minimalReviewPayload(s);
    const port = makeCutoverPort();

    const jobId = await port.startWorkflow(
      startCall({
        workflowType: "reviewPullRequest",
        workflowId: `review/${payload.installation_id}/${payload.repository_id}/${payload.pr_number}`,
        args: [payload],
      }),
    );

    const reviewRows = await allReviewJobs();
    expect(reviewRows).toHaveLength(1);
    expect(reviewRows[0]!.job_id).toBe(jobId);     // the returned string IS the review job_id
    expect(reviewRows[0]!.run_id).toBe(s.runId);
    expect(reviewRows[0]!.review_id).toBe(s.reviewId);
    expect(reviewRows[0]!.installation_id).toBe(s.installationId);
    // CS4.1 RT3: the payload's delivery_id is PERSISTED onto the job row (the admin/debug timeline
    // join column) — and, being non-null, it ENGAGES enqueue's delivery_id identity cross-check.
    expect(reviewRows[0]!.delivery_id).toBe(payload.delivery_id);
    expect(reviewRows[0]!.payload).toEqual(payload); // the durable workflow-argument store holds it
    expect(reviewRows[0]!.state).toBe("ready");
    expect(await allJobs()).toHaveLength(0);       // the review trigger NEVER lands on background_jobs
  });

  it("(9b) a REDELIVERED reviewPullRequest dispatch (same active run) returns the SAME job_id — no unique-violation noise; ONE row (CS4.1 RC6/H9)", async () => {
    // The crash window: enqueue succeeded but markDispatched did not → the outbox row REDELIVERS the
    // SAME envelope. The re-driven startWorkflow must coalesce onto the existing active job instead of
    // 23505-ing the row toward dead-letter while a job is already enqueued/running.
    const s = await seedRunTracked();
    const payload = minimalReviewPayload(s);
    const port = makeCutoverPort();
    const call = startCall({
      workflowType: "reviewPullRequest",
      workflowId: `review/${payload.installation_id}/${payload.repository_id}/${payload.pr_number}`,
      args: [payload],
    });

    const first = await port.startWorkflow(call);
    const second = await port.startWorkflow(call);   // the redelivery — must NOT throw
    expect(second).toBe(first);                      // idempotent: the EXISTING review job_id
    const reviewRows = await allReviewJobs();
    expect(reviewRows).toHaveLength(1);              // exactly ONE core.review_jobs row
    expect(reviewRows[0]!.job_id).toBe(first);
    expect(reviewRows[0]!.state).toBe("ready");
  });

  it("(9c) the dispatching outbox ROW's delivery_id cross-checks the payload identity — a divergence is PERMANENT, a match engages the persisted column (W1.9e)", async () => {
    // Pre-W1.9e the port sourced the enqueue envelope's delivery_id FROM the payload itself, so
    // assertPayloadIdentityMatchesEnvelope's delivery_id arm compared the payload against itself
    // (tautological). The row's delivery_id (the producer stamps ONE webhook delivery id on BOTH —
    // github_webhook_persistence.ts) is the INDEPENDENT identity source: threaded through the port's
    // 3rd param it makes the cross-check real, and a divergent pair (a drifted/poisoned producer)
    // must dead-letter PERMANENTLY instead of retrying toward the same deterministic mismatch.
    const s = await seedRunTracked();
    const payload = minimalReviewPayload(s);
    const port = makeCutoverPort();
    const call = startCall({
      workflowType: "reviewPullRequest",
      workflowId: `review/${payload.installation_id}/${payload.repository_id}/${payload.pr_number}`,
      args: [payload],
    });

    await expect(
      port.startWorkflow(call, payload.installation_id, "dlv-DIVERGED-from-payload"),
    ).rejects.toBeInstanceOf(PermanentSinkError);
    await expect(
      port.startWorkflow(call, payload.installation_id, "dlv-DIVERGED-from-payload"),
    ).rejects.toThrow(/delivery_id/);
    expect(await allReviewJobs()).toHaveLength(0); // nothing was written on the mismatch

    // The MATCHING row delivery_id (the production shape) enqueues with the cross-check engaged.
    const jobId = await port.startWorkflow(call, payload.installation_id, payload.delivery_id);
    const rows = await allReviewJobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.job_id).toBe(jobId);
    expect(rows[0]!.delivery_id).toBe(payload.delivery_id);
  });

  it("(10) a reviewPullRequest dispatch whose args[0] is not a valid ReviewPullRequestPayloadV1 throws PermanentSinkError; NEITHER table gets a row", async () => {
    const port = makeCutoverPort();
    const call = startCall({
      workflowType: "reviewPullRequest",
      workflowId: "wf-rev-malformed",
      args: [{ schema_version: 2, not_a_review_payload: true }],
    });

    await expect(port.startWorkflow(call)).rejects.toBeInstanceOf(PermanentSinkError);
    await expect(port.startWorkflow(call)).rejects.toThrow(/reviewPullRequest/);
    expect(await allReviewJobs()).toHaveLength(0);
    expect(await allJobs()).toHaveLength(0);
  });

  it("(11) E2E (runner boot wiring): a temporal_workflow_start outbox row with the REAL review envelope → drain pass enqueues core.review_jobs (NOT background_jobs); ZERO Temporal", async () => {
    const gid = nextGhIid();
    const login = `cutover-${gid}`;
    // The outbox row's installation_id is FK-anchored on core.installations (and NOT NULL for this
    // sink per ck_outbox_installation_id_required) — seed the installation, then tie the payload's
    // installation_id to it so the persisted review_jobs.installation_id is the SAME tenant.
    const ins = await pool.query<{ installation_id: string }>(
      `INSERT INTO core.installations (github_installation_id, account_login, account_type)
       VALUES ($1, $2, 'Organization') RETURNING installation_id`,
      [gid, login],
    );
    const installationUuid = ins.rows[0]!.installation_id;
    const seeded = await seedRunTracked();
    const payload = minimalReviewPayload({
      runId: seeded.runId, reviewId: seeded.reviewId, installationId: installationUuid,
    });

    wireOutboxSinks(db);

    // The producer byte path: ONE temporal_workflow_start row whose payload is the buildOuterPayload
    // envelope (workflow_type='reviewPullRequest', args:[the fully-allocated v2 payload]). W1.9e:
    // the row's delivery_id is the SAME webhook delivery id the payload carries — the producer
    // stamps one value on both (github_webhook_persistence.ts), and the port now cross-checks them.
    const envelope = reviewStartEnvelope(payload);
    const rowId = randomUUID();
    await sql`INSERT INTO core.outbox
        (id, sink, payload, schema_version, run_id, trace_context, delivery_id, installation_id)
      VALUES (${rowId}, 'temporal_workflow_start', CAST(${JSON.stringify(envelope)} AS JSONB), 2,
              NULL, CAST('{}' AS JSONB), ${payload.delivery_id}, ${installationUuid})`.execute(db);

    const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
    expect(await handles.drainOutboxOnce()).toBe(1);

    const outboxRow = await sql<{ state: string; last_error: string | null }>`
      SELECT state, last_error FROM core.outbox WHERE id = ${rowId}`.execute(db);
    expect(outboxRow.rows[0]!.state).toBe("dispatched");
    expect(outboxRow.rows[0]!.last_error).toBeNull();

    const reviewRows = await allReviewJobs();
    expect(reviewRows).toHaveLength(1);            // the review trigger landed on the REVIEW runner
    expect(reviewRows[0]!.run_id).toBe(seeded.runId);
    expect(reviewRows[0]!.review_id).toBe(seeded.reviewId);
    expect(reviewRows[0]!.installation_id).toBe(installationUuid);
    // CS4.1 RT3 end-to-end: the webhook delivery_id rode producer envelope → outbox → drain → port →
    // enqueue and landed on the persisted job row (the admin/debug timeline join holds).
    expect(reviewRows[0]!.delivery_id).toBe(payload.delivery_id);
    expect(reviewRows[0]!.payload).toEqual(payload);
    expect(reviewRows[0]!.state).toBe("ready");
    expect(await allJobs()).toHaveLength(0);       // NOT a background_jobs row
  });

  it("(11b) E2E: an outbox row whose delivery_id DIVERGES from the payload's dead-letters PERMANENTLY on the first drain (W1.9e)", async () => {
    // The full chain — claimPending → drain loop → dispatchRow → SinkContext → sink handler →
    // port → enqueue identity assert: a row/payload delivery_id divergence is a deterministic
    // identity fault (the SAME bytes mismatch on every redelivery), so the row must go DEAD on
    // attempt 1 with the divergence named in last_error — never burn the 5-attempt outbox curve,
    // and never enqueue a review job under a divergent identity.
    const gid = nextGhIid();
    const login = `cutover-${gid}`;
    const ins = await pool.query<{ installation_id: string }>(
      `INSERT INTO core.installations (github_installation_id, account_login, account_type)
       VALUES ($1, $2, 'Organization') RETURNING installation_id`,
      [gid, login],
    );
    const installationUuid = ins.rows[0]!.installation_id;
    const seeded = await seedRunTracked();
    const payload = minimalReviewPayload({
      runId: seeded.runId, reviewId: seeded.reviewId, installationId: installationUuid,
    });

    wireOutboxSinks(db);

    const rowId = randomUUID();
    await sql`INSERT INTO core.outbox
        (id, sink, payload, schema_version, run_id, trace_context, delivery_id, installation_id)
      VALUES (${rowId}, 'temporal_workflow_start',
              CAST(${JSON.stringify(reviewStartEnvelope(payload))} AS JSONB), 2,
              NULL, CAST('{}' AS JSONB), ${`DIVERGED-${payload.delivery_id}`}, ${installationUuid})`.execute(db);

    const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
    expect(await handles.drainOutboxOnce()).toBe(1);

    const outboxRow = await sql<{ state: string; last_error: string | null }>`
      SELECT state, last_error FROM core.outbox WHERE id = ${rowId}`.execute(db);
    expect(outboxRow.rows[0]!.state).toBe("dead");               // PERMANENT — attempt 1, no retry burn
    expect(outboxRow.rows[0]!.last_error).toMatch(/delivery_id/); // the dead row names the divergence
    expect(await allReviewJobs()).toHaveLength(0);               // no job under a divergent identity
    expect(await allJobs()).toHaveLength(0);
  });

  it("(12) every MAPPED event workflow_type still routes onto background_jobs (and never review_jobs)", async () => {
    const port = makeCutoverPort();
    for (const [workflowType, jobType] of Object.entries(WORKFLOW_TYPE_TO_JOB_TYPE)) {
      const jobId = await port.startWorkflow(
        startCall({ workflowType, workflowId: `wf-map-${workflowType}`, args: [{ probe: jobType }] }),
      );
      expect(jobId).toBeTruthy();
    }
    const jobs = await allJobs();
    expect(jobs.map((j) => j.job_type).sort()).toEqual(Object.values(WORKFLOW_TYPE_TO_JOB_TYPE).sort());
    expect(await allReviewJobs()).toHaveLength(0); // the special-case never siphons mapped types
  });
});
