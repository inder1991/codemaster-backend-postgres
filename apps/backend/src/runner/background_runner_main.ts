import { createRequire } from "node:module";
import { hostname } from "node:os";

import type { Kysely } from "kysely";

import { OutboxDispatchActivities } from "#backend/activities/outbox_dispatch.activity.js";
import type { TemporalClientPort } from "#backend/adapters/temporal_port.js";
import { PostgresOutboxRepo } from "#backend/domain/repos/outbox_repo.js";
import { registerInstallationReconcileSink } from "#backend/outbox/sinks/installation_reconcile.js";
import { registerTemporalWorkflowStartSink } from "#backend/outbox/sinks/temporal_workflow_start.js";

import type { Clock } from "#platform/clock.js";
import { WallClock } from "#platform/clock.js";
import { disposePool, tenantKysely } from "#platform/db/database.js";

import { BackgroundJobsRepo } from "./background_jobs_repo.js";
import { resolveOutboxPort } from "./background_jobs_temporal_port.js";
import {
  BackgroundRunnerLoop,
  runOneBackgroundJob,
  type BackgroundRunOutcome,
} from "./background_runner.js";
import { ensureScheduledJobs } from "./cron_schedules.js";
import { HandlerRegistry } from "./handler_registry.js";
import { registerCronHandlers } from "./handlers/cron_handlers.js";
import { registerEventHandlers } from "./handlers/event_handlers.js";
import { OutboxDispatcherLoop } from "./outbox_dispatcher_loop.js";
import { recordRunnerLoopCrashed } from "./runner_metrics.js";
import { SchedulerLoop, pollAndEnqueue } from "./scheduler.js";

// Phase 3a W4: the background-runner PROCESS ENTRYPOINT — composes the W2b BackgroundRunnerLoop
// (claim/dispatch/settle over core.background_jobs) + the W3 SchedulerLoop (the Postgres poller
// replacing Temporal Schedules) + the W2b HandlerRegistry into ONE Temporal-free runtime process.
// Closes the F6 review finding's composition gap: the three pieces existed but nothing wired them
// into a bootable process. Phase 3c adds the OutboxDispatcherLoop (the Postgres leased drain loop
// replacing the OutboxDispatcherWorkflow singleton) over the SAME shared pool/clock. Phase 3d.3
// adds the flag-gated outbox sink port ({@link wireOutboxSinks}): by DEFAULT the
// temporal_workflow_start / installation_reconcile sinks still dispatch via the RealTemporalClient;
// CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS=true (the Phase-4 cutover flip) routes them onto the
// Postgres background-jobs platform instead.
//
// ## NOT STARTED IN PRODUCTION YET (deliberate)
//
// Phase 3b W3b.1 registered the FIRST handlers (registerCronHandlers: mutex_janitor +
// review_run_reaper — the 2 interval crons migrated off Temporal Schedules) and runBackgroundRunner
// seeds their core.scheduled_jobs rows at startup (ensureScheduledJobs — the ensureCronSchedule
// idempotency, as ON CONFLICT DO NOTHING). The process itself stays COLD: NO deployment manifest /
// Helm chart / Procfile boots this entrypoint yet; the Temporal schedules keep firing the same
// idempotent sweeps until the runner is deployed (and Phase 4 deletes the Temporal side). Later
// Phase 3b waves register their handlers in {@link buildBackgroundRunner} (the buildActivities
// idiom: composition-root services are closed over at registration time, not threaded through
// HandlerDeps) and append their CRON_SCHEDULES entries.
//
// ## Shape
//
//   * {@link buildBackgroundRunner} — the PURE composition seam: constructs registry + the three
//     loops over ONE shared db/clock (the ADR-0062 single-pool invariant: `tenantKysely(dsn)` in
//     prod; tests inject their own Kysely + FakeClock). Also returns single-shot drive seams
//     (`runOneCycle` / `pollOnce` / `drainOutboxOnce`) bound to the SAME pieces the loops own, so
//     tests and operator diagnostics can drive exactly one cycle/pass without the infinite loops.
//   * {@link resolveBackgroundRunnerConfig} — env parsing, fail-loud (missing DSN / garbage numbers
//     refuse to boot; a half-configured runner is worse than no runner).
//   * {@link runSupervisedLoops} — the PER-LOOP SUPERVISION seam (Phase 4b W4b.2, review blocker
//     #3): each loop's run() is awaited behind its OWN catch boundary, so one loop's escaped error
//     stops THAT loop alone (logged + codemaster_runner_loop_crashed_total{loop}) while the others
//     KEEP RUNNING. Pre-W4b.2 the composition tied the three run() promises into a fail-fast race
//     (any crash fired stopAll()) — a scheduler fault stopped background-job execution AND outbox
//     draining.
//   * {@link runBackgroundRunner} — the process entrypoint: build, run ALL loops concurrently under
//     runSupervisedLoops, wire SIGINT/SIGTERM → stop() all + drain (an in-flight job/poll/drain
//     always completes; the loops' cancellableSleep wakes immediately), then dispose the shared
//     pool. stopAll() fires ONLY on the signal path — NEVER as a side effect of one loop's failure.
//     The entrypoint returns once ALL loops have ended (graceful stop or crash), re-throwing
//     fail-loud when any loop crashed, so a fully-crashed runner exits non-zero and the platform
//     restarts it instead of lingering as a zombie.

/** Tunables for both loops. Resolved from env in prod ({@link resolveBackgroundRunnerConfig}). */
export type BackgroundRunnerConfig = {
  /** Lease-fencing identity stamped on claimed jobs (`lease_owner`); hostname+pid in prod. */
  owner: string;
  /** Job lease duration (seconds); the heartbeat extends it while the handler runs. */
  leaseS: number;
  /** Heartbeat cadence (seconds); must be comfortably below `leaseS`. */
  heartbeatS: number;
  /** HARD per-job runtime ceiling (seconds) — the W2b hard-timeout race force-settles past it. */
  maxRuntimeS: number;
  /** Runner idle sleep between empty claims (seconds); stuck-job reaping runs each idle cycle. */
  idleS: number;
  /** Scheduler poll cadence (seconds) over core.scheduled_jobs. */
  pollIntervalS: number;
  /** Outbox drain-loop idle sleep between empty claims (seconds) — the workflow's
   *  DEFAULT_DRAIN_INTERVAL_SECONDS=2 (Phase 3c). */
  outboxIdleS: number;
  /** Outbox dead-letter threshold. Resolved from the SAME env var the Temporal composition root
   *  reads (`CODEMASTER_OUTBOX_MAX_ATTEMPTS`, default 5 — build_outbox_activities.ts): both
   *  runtimes drain the same `core.outbox` table and MUST share one threshold. */
  outboxMaxAttempts: number;
};

/** What {@link buildBackgroundRunner} composes over: ONE shared Kysely (ADR-0062 pool) + Clock. */
export type BackgroundRunnerDeps = {
  /** Kysely over the SHARED process pool (`tenantKysely(dsn)` in prod — the ADR-0062 invariant). */
  db: Kysely<unknown>;
  clock: Clock;
  config: BackgroundRunnerConfig;
};

/** The composed runtime pieces + single-shot drive seams (tests / operator diagnostics). */
export type BackgroundRunnerHandles = {
  /** The job_type → handler dispatch seam. W3b.1 cron handlers pre-registered; later Phase 3b
   *  migrations register here. */
  registry: HandlerRegistry;
  runnerLoop: BackgroundRunnerLoop;
  schedulerLoop: SchedulerLoop;
  /** Phase 3c: the Postgres leased outbox drain loop (replaces the OutboxDispatcherWorkflow
   *  singleton). Run ONE per deployment — the rows are leased (SKIP LOCKED) so extra drainers are
   *  SAFE, but the original singleton intent (global created_at-ordered draining) wants one. */
  outboxLoop: OutboxDispatcherLoop;
  /** Drive exactly ONE claim → dispatch → settle cycle over the SAME pieces `runnerLoop` owns. */
  runOneCycle(): Promise<{ outcome: BackgroundRunOutcome; jobId?: string }>;
  /** Drive exactly ONE scheduler poll pass over the SAME pieces `schedulerLoop` owns. */
  pollOnce(): Promise<number>;
  /** Drive exactly ONE outbox drain pass over the SAME pieces `outboxLoop` owns. */
  drainOutboxOnce(): Promise<number>;
};

/**
 * The PURE composition seam: construct the HandlerRegistry + BackgroundRunnerLoop + SchedulerLoop
 * sharing ONE BackgroundJobsRepo over the injected db/clock. No I/O happens here (the pg pool is
 * lazy); callers own when the loops actually start.
 */
export function buildBackgroundRunner(deps: BackgroundRunnerDeps): BackgroundRunnerHandles {
  const { db, clock, config } = deps;
  const repo = new BackgroundJobsRepo(db);

  // Phase 3b waves register job handlers HERE as the workflow migrations land (one register() per
  // job_type, composition-root services closed over at registration — the buildActivities idiom).
  // A claimed job with no handler dead-letters (`no handler for <job_type>`), never retry-loops, so
  // an accidentally-early enqueue surfaces once instead of burning attempts.
  const registry = new HandlerRegistry();
  // W3b.1 + W3b.2 + W3d.1 + W3e.1: the 3 interval crons (mutex_janitor / review_run_reaper /
  // workspace_retention — the multi-step per-id fail-open janitor chain) + the 3 daily crons
  // (mark_stale_chunks / partition_maintenance / run_id_retention). No dsn / GitHub-client /
  // release-deps override here — the activities self-resolve their env config (CODEMASTER_PG_CORE_DSN;
  // partition maintenance prefers CODEMASTER_PG_MAINT_DSN; the workspace release activity reads
  // CODEMASTER_WORKSPACE_ROOT), exactly as under their Temporal dispatch, and the retention PR-closer
  // builds its deferred-Vault GitHub client on first use.
  registerCronHandlers(registry, {});
  // W3d.1: the 3 reconcile/repair EVENT-DRIVEN job_types (reconcile_installation /
  // reconcile_repositories / repair_installation_repositories). The next wave's outbox
  // temporal_workflow_start cutover routes the producers' workflow_type strings onto these via
  // workflow_job_map.ts.
  registerEventHandlers(registry, {});

  const runnerArgs = {
    repo,
    registry,
    clock,
    owner: config.owner,
    leaseS: config.leaseS,
    heartbeatS: config.heartbeatS,
    maxRuntimeS: config.maxRuntimeS,
  };
  const schedulerArgs = { repo, db, clock };

  // Phase 3c: the outbox drain loop — REUSES the proven Postgres-backed dispatch activities
  // (OutboxDispatchActivities, the exact 4 the Temporal worker registers via
  // buildOutboxActivities) over the SAME shared db/clock (ADR-0062). The dispatchRow sink routing
  // is untouched: temporal_workflow_start still dispatches via the RealTemporalClient until
  // Phase 3d rewires that sink.
  const outboxActivities = new OutboxDispatchActivities({
    repo: new PostgresOutboxRepo({ clock }),
    db,
    clock,
    maxAttempts: config.outboxMaxAttempts,
  });
  const outboxLoop = new OutboxDispatcherLoop({
    activities: {
      claimPendingRows: outboxActivities.claimPendingRows,
      dispatchRow: outboxActivities.dispatchRow,
      markDispatched: outboxActivities.markDispatched,
      markAttemptFailed: outboxActivities.markAttemptFailed,
    },
    clock,
    idleS: config.outboxIdleS,
  });

  return {
    registry,
    runnerLoop: new BackgroundRunnerLoop({ ...runnerArgs, idleS: config.idleS }),
    schedulerLoop: new SchedulerLoop({ ...schedulerArgs, pollIntervalS: config.pollIntervalS }),
    outboxLoop,
    runOneCycle: async () => runOneBackgroundJob(runnerArgs),
    pollOnce: async () => pollAndEnqueue(schedulerArgs),
    drainOutboxOnce: async () => outboxLoop.drainOnce(),
  };
}

/**
 * Build the flag-OFF (pre-cutover) Temporal port: a RealTemporalClient over a freshly-connected
 * `@temporalio/client` Client, with the SAME config resolver + data converter the outbox-dispatcher
 * worker uses (outbox_dispatcher_main.ts) so the wire bytes are identical whichever process drains
 * the row. DYNAMIC imports keep the whole Temporal client graph off this runtime's static import
 * graph (the deferred-Vault idiom from handlers/event_handlers.ts): the Phase-4 posture (flag ON)
 * never loads — let alone connects — any Temporal code. Invoked ONLY by {@link wireOutboxSinks}'s
 * flag-OFF branch; a connect failure crash-loops the boot (fail-loud — a drainer that cannot reach
 * Temporal cannot dispatch, same posture as the Temporal dispatcher worker's own boot).
 */
async function makeRealTemporalPort(): Promise<TemporalClientPort> {
  const { Client, Connection } = await import("@temporalio/client");
  const { RealTemporalClient } = await import("#backend/adapters/real_temporal_client.js");
  const { resolveWorkerTemporalConfig } = await import("#backend/worker/temporal_config.js");
  const temporal = resolveWorkerTemporalConfig(process.env);
  const connection = await Connection.connect(
    temporal.tls ? { address: temporal.address, tls: {} } : { address: temporal.address },
  );
  // createRequire bound to THIS module's URL so the data-converter specifier resolves whether the
  // runner runs from .ts (tsx) or compiled .js (the outbox_dispatcher_main.ts idiom).
  const require_ = createRequire(import.meta.url);
  const client = new Client({
    connection,
    namespace: temporal.namespace,
    dataConverter: { payloadConverterPath: require_.resolve("../worker/data_converter") },
  });
  return new RealTemporalClient(client);
}

/**
 * Phase 3d.3 — the CUTOVER HINGE: register the two event-driven outbox sinks
 * (`temporal_workflow_start` + `installation_reconcile`, both bound to the SAME port-shaped
 * handler) onto the flag-selected port, so this runtime's drain loop can dispatch the rows the
 * webhook producers append. Which port the sinks start work on is the cutover flag:
 *
 *   * CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS unset/false (DEFAULT): the RealTemporalClient — rows
 *     keep starting Temporal workflows, byte-identical with the Temporal dispatcher worker
 *     (outbox_dispatcher_main.ts), so a runner booted before Phase 4 changes NOTHING about where
 *     work executes.
 *   * true: the BackgroundJobsTemporalPort — rows enqueue core.background_jobs jobs that THIS
 *     process's runner loop executes (workflow_job_map.ts translation; an unmapped workflow_type
 *     fails loud into the row's last_error). Flipping this flag IS the Phase-4 cutover and
 *     REQUIRES this background runner process to be BOOTED — the runner loop is the only consumer
 *     of the enqueued jobs; with the flag on and no runner, jobs pile up unexecuted.
 *
 * Called once at process boot (runBackgroundRunner), BEFORE the drain loop starts — registerSink
 * throws on duplicates, so double-wiring fails loud.
 */
async function wireOutboxSinks(db: Kysely<unknown>): Promise<void> {
  const port = await resolveOutboxPort({
    env: process.env,
    backgroundJobs: new BackgroundJobsRepo(db),
    makeTemporalPort: makeRealTemporalPort,
  });
  registerTemporalWorkflowStartSink(port);
  registerInstallationReconcileSink(port);
}

// Upper bounds for the loop tunables (W4b.1 review blocker #2 — lease/heartbeat config was
// previously unguarded above zero). These are sanity ceilings that catch unit typos (a
// milliseconds value fat-fingered into a seconds var), not tuning guidance — the defaults sit
// 1–2 orders of magnitude below every bound. Rationale per bound:
//   * lease ≤ 3600 (1h): a crashed runner's leased job is un-reclaimable until the lease expires;
//     an hours-long lease turns a pod crash into an hours-long stall of that job.
//   * heartbeat ≤ 1800 (30min): structurally ≤ lease/2 (cross-field check below), so this only
//     catches parse-level typos before the cross-field check names the pair.
//   * max runtime ≤ 86400 (24h): background work (Confluence sync, retention) runs minutes; a
//     day-plus hard ceiling is a typo and timeout_at-based reaping would effectively never fire.
//   * idle / scheduler-poll / outbox-idle ≤ 3600 (1h): a sleep above an hour starves the queue /
//     skips cron cadences within their evaluation window.
const MAX_LEASE_S = 3_600;
const MAX_HEARTBEAT_S = 1_800;
const MAX_RUNTIME_CEILING_S = 86_400;
const MAX_IDLE_OR_POLL_S = 3_600;

/** Parse a positive finite number from env, falling back when unset/empty; fail-loud on garbage,
 *  non-positive values, and values above the var's documented ceiling `maxS` (the absurdly-large
 *  guard — W4b.1 review blocker #2). */
function envPositiveSeconds(env: NodeJS.ProcessEnv, name: string, fallback: number, maxS: number): number {
  // `name` is a bounded set of CODEMASTER_BG_* literals from resolveBackgroundRunnerConfig — not an
  // attacker-controlled object-key sink; the prototype-pollution threat model does not apply.
  // eslint-disable-next-line security/detect-object-injection
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number of seconds; got '${raw}'`);
  }
  if (n > maxS) {
    throw new Error(
      `${name} must be <= ${maxS} seconds; got '${raw}' — an absurdly large value is almost ` +
        `certainly a unit typo (milliseconds pasted into a seconds var) and must refuse boot, ` +
        `not silently configure an hours-long loop`,
    );
  }
  return n;
}

/** Parse a positive integer from env, falling back when unset/empty; fail-loud on garbage. */
function envPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  // `name` is a bounded set of CODEMASTER_* literals from resolveBackgroundRunnerConfig — not an
  // attacker-controlled object-key sink; the prototype-pollution threat model does not apply.
  // eslint-disable-next-line security/detect-object-injection
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer; got '${raw}'`);
  }
  return n;
}

/**
 * Resolve the DSN + loop tunables from env. Fail-loud: a missing DSN, a non-positive/garbage
 * interval, a value above its documented ceiling, or an invalid lease/heartbeat/runtime PAIR
 * refuses to boot (a half-configured runner silently mis-leasing jobs is worse than a crash-loop
 * the platform surfaces). Defaults: lease 60s / heartbeat 15s / hard ceiling 900s (background
 * work — Confluence sync, retention — runs minutes, not the review pipeline's seconds) / idle 5s /
 * scheduler poll 30s / outbox idle 2s (the workflow's drain interval) / outbox dead-letter
 * threshold 5. `owner` is hostname+pid — traceable to the pod, no random seam.
 *
 * Cross-field invariants (W4b.1 review blocker #2), validated AFTER parse so each error names the
 * offending env var(s) + the constraint:
 *   * heartbeatS <= leaseS/2 — the heartbeat must be able to beat at least TWICE per lease window;
 *     a heartbeat that can't outrun its own lease risks lease expiry mid-handler, at which point a
 *     second runner claims the still-running job → duplicate execution.
 *   * leaseS <= maxRuntimeS — a lease window longer than the hard runtime ceiling is nonsensical
 *     (the job would hit timeout_at and be reaped while its first lease is still live).
 */
export function resolveBackgroundRunnerConfig(
  env: NodeJS.ProcessEnv,
): { dsn: string; config: BackgroundRunnerConfig } {
  const dsn = env["CODEMASTER_PG_CORE_DSN"];
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set; the background runner cannot start without the core Postgres DSN",
    );
  }
  const config: BackgroundRunnerConfig = {
    owner: `bg-runner-${hostname()}-${process.pid}`,
    leaseS: envPositiveSeconds(env, "CODEMASTER_BG_LEASE_S", 60, MAX_LEASE_S),
    heartbeatS: envPositiveSeconds(env, "CODEMASTER_BG_HEARTBEAT_S", 15, MAX_HEARTBEAT_S),
    maxRuntimeS: envPositiveSeconds(env, "CODEMASTER_BG_MAX_RUNTIME_S", 900, MAX_RUNTIME_CEILING_S),
    idleS: envPositiveSeconds(env, "CODEMASTER_BG_IDLE_S", 5, MAX_IDLE_OR_POLL_S),
    pollIntervalS: envPositiveSeconds(env, "CODEMASTER_BG_SCHEDULER_POLL_S", 30, MAX_IDLE_OR_POLL_S),
    outboxIdleS: envPositiveSeconds(env, "CODEMASTER_BG_OUTBOX_IDLE_S", 2, MAX_IDLE_OR_POLL_S),
    outboxMaxAttempts: envPositiveInt(env, "CODEMASTER_OUTBOX_MAX_ATTEMPTS", 5),
  };
  if (config.heartbeatS > config.leaseS / 2) {
    throw new Error(
      `CODEMASTER_BG_HEARTBEAT_S (${config.heartbeatS}s) must be <= CODEMASTER_BG_LEASE_S/2 ` +
        `(lease=${config.leaseS}s → max heartbeat ${config.leaseS / 2}s): the heartbeat must beat ` +
        `at least twice per lease window, else the lease expires mid-handler and a second runner ` +
        `claims the still-running job → duplicate execution`,
    );
  }
  if (config.leaseS > config.maxRuntimeS) {
    throw new Error(
      `CODEMASTER_BG_LEASE_S (${config.leaseS}s) must be <= CODEMASTER_BG_MAX_RUNTIME_S ` +
        `(${config.maxRuntimeS}s): a lease window longer than the hard runtime ceiling is ` +
        `nonsensical — the job would be reaped at timeout_at while its first lease is still live`,
    );
  }
  return { dsn, config };
}

/** Bounded loop-name vocabulary of the supervision seam — doubles as the
 *  `codemaster_runner_loop_crashed_total{loop}` counter label (cardinality discipline). */
export type SupervisedLoopName = "runner" | "scheduler" | "outbox";

/** One crashed loop, as observed (caught + logged + metered) by {@link runSupervisedLoops}. */
export type LoopCrash = { loop: SupervisedLoopName; error: Error };

/** The narrow run() surface the supervisor needs — all three loop classes satisfy it structurally. */
type RunnableLoop = { run(): Promise<void> };

/**
 * Supervise ONE loop: await its run() behind a catch boundary so an escaped error CANNOT reach the
 * composition's Promise machinery as a rejection. On a crash: meter the bounded
 * `codemaster_runner_loop_crashed_total{loop}` counter, ERROR-log which loop + the error, and
 * resolve with the {@link LoopCrash} — the crashed loop has stopped ON ITS OWN (its run() exited);
 * nothing here touches the sibling loops. NEVER rejects (the catch body is metric-fail-safe +
 * console only), so the caller's Promise.all cannot fail-fast.
 */
async function superviseLoop(loop: SupervisedLoopName, runnable: RunnableLoop): Promise<LoopCrash | undefined> {
  try {
    await runnable.run();
    return undefined; // graceful: stop() ended the loop
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    recordRunnerLoopCrashed({ loop });
    console.error(
      `background runner: ${loop} loop CRASHED and stopped — the other loops KEEP RUNNING ` +
        `(W4b.2 per-loop supervision; this pod is DEGRADED until restarted): ${error.stack ?? error.message}`,
    );
    return { loop, error };
  }
}

/**
 * Run ALL THREE loops concurrently under PER-LOOP SUPERVISION (Phase 4b W4b.2, review blocker #3):
 * one loop's escaped error (a pass-level DB fault in the scheduler, a claim error in the runner /
 * outbox drainer — the loops' documented fail-loud run() contract) is caught at ITS OWN boundary,
 * logged + metered, and stops THAT loop alone; the other loops KEEP RUNNING. Resolves only when
 * EVERY loop has ended — graceful stop() or crash — with the list of observed crashes (empty on a
 * clean shutdown). The composition deliberately does NOT tie the run() promises into a fail-fast
 * race: superviseLoop never rejects, so this Promise.all cannot reject either. Calling the loops'
 * stop() is the CALLER's job (the SIGINT/SIGTERM path in {@link runBackgroundRunner}) — never a
 * side effect of one loop's failure.
 */
export async function runSupervisedLoops(loops: {
  runnerLoop: RunnableLoop;
  schedulerLoop: RunnableLoop;
  outboxLoop: RunnableLoop;
}): Promise<Array<LoopCrash>> {
  const outcomes = await Promise.all([
    superviseLoop("runner", loops.runnerLoop),
    superviseLoop("scheduler", loops.schedulerLoop),
    superviseLoop("outbox", loops.outboxLoop),
  ]);
  return outcomes.filter((o): o is LoopCrash => o !== undefined);
}

/**
 * The process entrypoint: build over the ADR-0062 shared pool + WallClock, run ALL THREE loops
 * (runner + scheduler + outbox drain) concurrently under {@link runSupervisedLoops}, and shut down
 * gracefully — SIGINT/SIGTERM stop() every loop, which DRAIN (an in-flight job/poll/drain pass
 * always completes; the idle/poll cancellableSleep wakes immediately). A crash in ONE loop stops
 * that loop ALONE (logged + metered; W4b.2 — pre-fix it fired stopAll() and tore down job
 * execution AND outbox draining together); the survivors keep running until a signal arrives. Once
 * ALL loops have ended the shared pool is disposed (no socket leaks across the exit path) and any
 * observed crash re-throws — fail-loud: a run in which a loop crashed never exits 0, and when EVERY
 * loop has crashed nothing keeps the process useful, so the throw lets the platform restart it
 * instead of leaving a zombie pod that looks healthy with zero live loops.
 *
 * NOT booted by any deployment yet — see the module doc (Phase 3b+ registers handlers first).
 */
export async function runBackgroundRunner(): Promise<void> {
  const { dsn, config } = resolveBackgroundRunnerConfig(process.env);
  const db = tenantKysely<unknown>(dsn); // THE shared ADR-0062 pool for this DSN
  const clock = new WallClock();
  const handles = buildBackgroundRunner({ db, clock, config });

  // Phase 3d.3: wire the event-driven outbox sinks onto the flag-selected port BEFORE the drain
  // loop starts (see wireOutboxSinks — flipping CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS is the
  // Phase-4 cutover). Fail-loud: a garbage flag value or (flag-OFF) an unreachable Temporal
  // refuses to boot rather than drain rows it cannot dispatch.
  await wireOutboxSinks(db);

  // Seed the cron schedules BEFORE the loops start (W3b.1) — idempotent ON CONFLICT DO NOTHING, so
  // concurrent pods / redeploys never clobber operator-paused/edited rows. Fail-loud: a runner that
  // cannot reach core.scheduled_jobs at boot should crash-loop visibly, not run schedule-less.
  await ensureScheduledJobs(db, clock);

  // stopAll fires ONLY here — the SIGINT/SIGTERM shutdown path. NEVER wire it to a loop's failure
  // (W4b.2 review blocker #3: the pre-fix .catch(stopAll) tie meant one loop's crash tore down all
  // three); a crashed loop stops alone inside runSupervisedLoops while the others keep running.
  const stopAll = (): void => {
    handles.runnerLoop.stop();
    handles.schedulerLoop.stop();
    handles.outboxLoop.stop();
  };
  process.once("SIGINT", stopAll);
  process.once("SIGTERM", stopAll);

  console.info(
    `background runner starting: owner=${config.owner} ` +
      `registered_job_types=[${handles.registry.registeredTypes().join(", ")}] ` +
      `(lease=${config.leaseS}s heartbeat=${config.heartbeatS}s maxRuntime=${config.maxRuntimeS}s ` +
      `idle=${config.idleS}s schedulerPoll=${config.pollIntervalS}s ` +
      `outboxIdle=${config.outboxIdleS}s outboxMaxAttempts=${config.outboxMaxAttempts})`,
  );

  // Per-loop SUPERVISION (W4b.2): resolves only when ALL THREE loops have ended — graceful stop()
  // via the signal path above, or a crash that stopped ITS loop alone. The process therefore stays
  // alive (and the survivors keep working) past any single loop's crash; if EVERY loop crashes,
  // nothing is left running, this await completes, and the fail-loud throw below exits the process
  // so the platform restarts it.
  const crashes = await runSupervisedLoops(handles);

  process.removeListener("SIGINT", stopAll);
  process.removeListener("SIGTERM", stopAll);
  await disposePool(dsn);

  if (crashes.length > 0) {
    // Fail-loud at EXIT: even when the surviving loops drained gracefully on SIGTERM, a run in
    // which any loop crashed must not exit 0 — the non-zero exit + the aggregate message record
    // the degraded run for the platform and the logs.
    throw new AggregateError(
      crashes.map((c) => c.error),
      `background runner: ${crashes.length} loop(s) crashed during this run — ` +
        crashes.map((c) => `${c.loop}: ${c.error.message}`).join("; "),
    );
  }
}

// Main-module entrypoint guard — fires ONLY under a direct `node .../background_runner_main.js`
// invocation (no prod manifest does this yet; see the module doc), never on import. Fail LOUD on
// any startup error (same idiom as worker/main.ts / outbox_dispatcher_main.ts).
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runBackgroundRunner().catch((err: unknown) => {
    process.stderr.write(
      `background runner FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
