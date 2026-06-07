// Entrypoint for the outbox-dispatcher worker — a SEPARATE worker/bundle from the review-pipeline worker
// (main.ts). It bundles ONLY the OutboxDispatcherWorkflow on its own task queue, registers the 4 outbox
// activities, wires the (previously inert) temporal_workflow_start sink to a real client, and ensures the
// dispatcher singleton is running. Mirrors main.ts's NativeConnection → Worker.create → worker.run shape.
//
// Why a separate worker: a Temporal worker bundles ONE workflowsPath. The review worker bundles
// review_pull_request.workflow; the dispatcher needs its own bundle (outbox_dispatcher.workflow) on a
// distinct queue so review pollers never receive OutboxDispatcherWorkflow tasks they can't run.

import { createRequire } from "node:module";

import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";

import { RealTemporalClient } from "#backend/adapters/real_temporal_client.js";
import { registerTemporalWorkflowStartSink } from "#backend/outbox/sinks/temporal_workflow_start.js";
import { registerInstallationReconcileSink } from "#backend/outbox/sinks/installation_reconcile.js";

import { buildOutboxActivities } from "./build_outbox_activities.js";
import {
  ensureCronSchedule,
  ensureIntervalSchedule,
  type EnsureCronScheduleArgs,
  type EnsureIntervalScheduleArgs,
} from "./ensure_schedule.js";
import { ensureOutboxDispatcherSingleton } from "./outbox_dispatcher_singleton.js";
import { resolveWorkerTemporalConfig } from "./temporal_config.js";

// createRequire bound to THIS module's URL so the relative specifiers resolve whether the worker runs from
// .ts (tsx) or compiled .js. Temporal loads workflowsPath/payloadConverterPath itself (absolute paths).
const require_ = createRequire(import.meta.url);

/** The dispatcher's own task queue (distinct from the review queue); env-overridable. */
function dispatcherTaskQueue(): string {
  const q = process.env["CODEMASTER_OUTBOX_TASK_QUEUE"];
  return q !== undefined && q !== "" ? q : "outbox-dispatcher";
}

/** The combined-pod REVIEW worker's task queue. The Wave-1 liveness schedules target this queue (NOT the
 *  dispatcher's) because the review worker's `workflowsPath` bundle (all_workflows.ts) re-exports the
 *  mutex-janitor + review-run-reaper workflows — so a fired schedule lands a start this pod can run. */
const REVIEW_TASK_QUEUE = "review-default";

/**
 * Wave-1 liveness-backstop cron schedules (ADR-0074 / ADR-0064). Cadence + schedule/workflow ids are
 * byte-faithful with the frozen Python (mutex_janitor.py / review_run_reaper.py); the workflowType strings
 * are the registered camelCase TS function names (combined-pod-worker decision, ADR-0074 §3).
 */
const WAVE1_LIVENESS_SCHEDULES: ReadonlyArray<EnsureCronScheduleArgs> = [
  {
    scheduleId: "codemaster-mutex-janitor",
    workflowType: "mutexJanitorWorkflow",
    workflowId: "codemaster-mutex-janitor-workflow",
    taskQueue: REVIEW_TASK_QUEUE,
    cronExpression: "*/5 * * * *",
  },
  {
    scheduleId: "codemaster-review-run-reaper",
    workflowType: "reviewRunReaperWorkflow",
    workflowId: "codemaster-review-run-reaper-workflow",
    taskQueue: REVIEW_TASK_QUEUE,
    cronExpression: "*/10 * * * *",
  },
];

/**
 * Wave-4 Confluence ingest INTERVAL schedules (combined-pod worker reuse — ADR-0075). Cadence + schedule/
 * workflow ids are byte-faithful with the frozen Python (confluence_sync_workflow.py /
 * mark_stale_chunks_workflow.py); the workflowType strings are the registered camelCase TS function names.
 * The taskQueue is OVERRIDDEN to the review queue (the ported `CONFLUENCE_SYNC_TASK_QUEUE` "confluence-sync"
 * const is vestigial in the combined-pod port — the 3 confluence workflows are bundled into THIS pod's
 * `all_workflows.ts` and registered on "review-default"). There is NO schedule for triggerPageResync — it is
 * admin-triggered on approval revocation, not periodic.
 *   - refresh-confluence-corpus    → confluenceIngestWorkflow, every 6h  (21600s).
 *   - mark-stale-confluence-chunks → markStaleChunksWorkflow,  every 24h (86400s).
 */
const CONFLUENCE_INTERVAL_SCHEDULES: ReadonlyArray<EnsureIntervalScheduleArgs> = [
  {
    scheduleId: "refresh-confluence-corpus",
    workflowType: "confluenceIngestWorkflow",
    workflowId: "refresh-confluence-corpus-workflow",
    taskQueue: REVIEW_TASK_QUEUE,
    intervalSeconds: 6 * 60 * 60,
    // RefreshConfluenceInputV1() default-constructs to { schema_version: 1 } (1:1 with the Python action).
    actionInput: { schema_version: 1 },
  },
  {
    scheduleId: "mark-stale-confluence-chunks",
    workflowType: "markStaleChunksWorkflow",
    workflowId: "mark-stale-confluence-chunks-workflow",
    taskQueue: REVIEW_TASK_QUEUE,
    intervalSeconds: 24 * 60 * 60,
    // MarkStaleChunksInputV1() default-constructs to { schema_version: 1 }. WITHOUT this the activity's
    // MarkStaleChunksInputV1.parse(undefined) throws ZodError and the 24h sweep retries forever.
    actionInput: { schema_version: 1 },
  },
];

/** Bring up the outbox-dispatcher worker + singleton and run until shutdown. */
export async function runOutboxDispatcherWorker(): Promise<void> {
  const temporal = resolveWorkerTemporalConfig(process.env);
  const taskQueue = dispatcherTaskQueue();
  const connectOpts = temporal.tls ? { address: temporal.address, tls: {} } : { address: temporal.address };

  // Worker connection (NativeConnection) — polls the dispatcher queue + runs the bundled workflow.
  const connection = await NativeConnection.connect(connectOpts);
  const activities = buildOutboxActivities();
  const worker = await Worker.create({
    connection,
    namespace: temporal.namespace,
    taskQueue,
    workflowsPath: require_.resolve("../workflows/outbox_dispatcher.workflow"),
    activities,
    dataConverter: { payloadConverterPath: require_.resolve("./data_converter") },
  });

  // Client connection (Connection — a distinct type from NativeConnection). The data converter MUST match
  // the worker's for wire byte-parity. Used for the sink's start_workflow calls + the singleton bootstrap.
  const clientConnection = await Connection.connect(connectOpts);
  const client = new Client({
    connection: clientConnection,
    namespace: temporal.namespace,
    dataConverter: { payloadConverterPath: require_.resolve("./data_converter") },
  });

  // Wire the previously-inert temporal_workflow_start sink to a REAL client (dispatched review rows now
  // actually start workflows). ALSO dual-register the SAME handler under the `installation_reconcile` sink
  // name: reconcile/repair outbox rows carry sink="installation_reconcile" (the NULL-installation_id schema
  // exemption), so without this registration getSink("installation_reconcile") throws → the row dead-letters.
  // 1:1 with Python, which ships a dedicated installation_reconcile sink (codemaster/worker/main.py:990) —
  // we register the identical temporal_workflow_start handler instance under both sink names.
  const temporalPort = new RealTemporalClient(client);
  registerTemporalWorkflowStartSink(temporalPort);
  registerInstallationReconcileSink(temporalPort);
  await ensureOutboxDispatcherSingleton(client, { taskQueue });

  // ── Wave-1 liveness-backstop Temporal Schedules (ADR-0074 / ADR-0064) ──
  // Idempotently register the mutex-janitor (every 5 min) + review-run-reaper (every 10 min) cron
  // schedules. FAIL-OPEN (log + continue) per the Python `worker/main.py` boot block: a registration
  // failure (Temporal transient / RBAC) MUST NOT crash worker startup — the next pod's idempotent ensure
  // retries. `ensureCronSchedule` itself swallows `ScheduleAlreadyRunning`, so an already-registered
  // schedule (incl. one an operator paused for an incident) is never clobbered.
  for (const schedule of WAVE1_LIVENESS_SCHEDULES) {
    try {
      await ensureCronSchedule(client, schedule);
      console.info(`schedule ensured: ${schedule.scheduleId}`);
    } catch (err) {
      console.error(`ensureCronSchedule(${schedule.scheduleId}) failed; worker continues`, err);
    }
  }

  // ── Wave-4 Confluence ingest INTERVAL Temporal Schedules (combined-pod, ADR-0075) ──
  // Idempotently register the corpus-sync (every 6h) + stale-sweep (every 24h) interval schedules. Same
  // FAIL-OPEN posture as the Wave-1 block: a registration failure (Temporal transient / RBAC) MUST NOT
  // crash worker startup — the next pod's idempotent ensure retries; `ensureIntervalSchedule` swallows
  // `ScheduleAlreadyRunning` so an already-registered (or operator-paused) schedule is never clobbered.
  for (const schedule of CONFLUENCE_INTERVAL_SCHEDULES) {
    try {
      await ensureIntervalSchedule(client, schedule);
      console.info(`schedule ensured: ${schedule.scheduleId}`);
    } catch (err) {
      console.error(`ensureIntervalSchedule(${schedule.scheduleId}) failed; worker continues`, err);
    }
  }

  await worker.run();
}

// Main-module entrypoint guard — run the worker and fail LOUD on any startup error (same idiom as main.ts).
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runOutboxDispatcherWorker().catch((err: unknown) => {
    process.stderr.write(
      `outbox-dispatcher worker FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
