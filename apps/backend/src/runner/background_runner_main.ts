import { hostname } from "node:os";

import type { Kysely } from "kysely";

import type { Clock } from "#platform/clock.js";
import { WallClock } from "#platform/clock.js";
import { disposePool, tenantKysely } from "#platform/db/database.js";

import { BackgroundJobsRepo } from "./background_jobs_repo.js";
import {
  BackgroundRunnerLoop,
  runOneBackgroundJob,
  type BackgroundRunOutcome,
} from "./background_runner.js";
import { HandlerRegistry } from "./handler_registry.js";
import { SchedulerLoop, pollAndEnqueue } from "./scheduler.js";

// Phase 3a W4: the background-runner PROCESS ENTRYPOINT — composes the W2b BackgroundRunnerLoop
// (claim/dispatch/settle over core.background_jobs) + the W3 SchedulerLoop (the Postgres poller
// replacing Temporal Schedules) + the W2b HandlerRegistry into ONE Temporal-free runtime process.
// Closes the F6 review finding's composition gap: the three pieces existed but nothing wired them
// into a bootable process.
//
// ## NOT STARTED IN PRODUCTION YET (deliberate)
//
// The registry boots EMPTY — no job handler exists until the Phase 3b+ workflow migrations land and
// register their handlers in {@link buildBackgroundRunner} (the buildActivities idiom: composition-
// root services are closed over at registration time, not threaded through HandlerDeps). Until then
// NO deployment manifest / Helm chart / Procfile boots this entrypoint: the file is wired but cold.
// Booting it early would be harmless-but-useless (an empty registry dead-letters any claimed job as
// `no handler for <job_type>` rather than retry-looping — the W2b no-handler posture), but the
// schedules that feed core.scheduled_jobs are also Phase 3b+ work, so the process stays unbooted
// until there is real work to run.
//
// ## Shape
//
//   * {@link buildBackgroundRunner} — the PURE composition seam: constructs registry + both loops
//     over ONE shared db/clock/repo (the ADR-0062 single-pool invariant: `tenantKysely(dsn)` in
//     prod; tests inject their own Kysely + FakeClock). Also returns single-shot drive seams
//     (`runOneCycle` / `pollOnce`) bound to the SAME pieces the loops own, so tests and operator
//     diagnostics can drive exactly one claim/dispatch/settle or one poll pass without the loops.
//   * {@link resolveBackgroundRunnerConfig} — env parsing, fail-loud (missing DSN / garbage numbers
//     refuse to boot; a half-configured runner is worse than no runner).
//   * {@link runBackgroundRunner} — the process entrypoint: build, run BOTH loops concurrently,
//     wire SIGINT/SIGTERM → stop() both + drain (an in-flight job/poll always completes; the loops'
//     cancellableSleep wakes immediately), then dispose the shared pool. A crash in EITHER loop
//     stops the other, drains it, and re-throws — fail-loud; supervision is the platform's restart
//     policy (same posture as SchedulerLoop.run's propagating poll errors).

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
  /** The job_type → handler dispatch seam. EMPTY at W4; Phase 3b+ migrations register here. */
  registry: HandlerRegistry;
  runnerLoop: BackgroundRunnerLoop;
  schedulerLoop: SchedulerLoop;
  /** Drive exactly ONE claim → dispatch → settle cycle over the SAME pieces `runnerLoop` owns. */
  runOneCycle(): Promise<{ outcome: BackgroundRunOutcome; jobId?: string }>;
  /** Drive exactly ONE scheduler poll pass over the SAME pieces `schedulerLoop` owns. */
  pollOnce(): Promise<number>;
};

/**
 * The PURE composition seam: construct the HandlerRegistry + BackgroundRunnerLoop + SchedulerLoop
 * sharing ONE BackgroundJobsRepo over the injected db/clock. No I/O happens here (the pg pool is
 * lazy); callers own when the loops actually start.
 */
export function buildBackgroundRunner(deps: BackgroundRunnerDeps): BackgroundRunnerHandles {
  const { db, clock, config } = deps;
  const repo = new BackgroundJobsRepo(db);

  // Phase 3b+ registers job handlers HERE as the workflow migrations land (one register() per
  // job_type, composition-root services closed over at registration — the buildActivities idiom).
  // EMPTY at W4 ship: a claimed job with no handler dead-letters (`no handler for <job_type>`),
  // never retry-loops, so an accidentally-early enqueue surfaces once instead of burning attempts.
  const registry = new HandlerRegistry();

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

  return {
    registry,
    runnerLoop: new BackgroundRunnerLoop({ ...runnerArgs, idleS: config.idleS }),
    schedulerLoop: new SchedulerLoop({ ...schedulerArgs, pollIntervalS: config.pollIntervalS }),
    runOneCycle: async () => runOneBackgroundJob(runnerArgs),
    pollOnce: async () => pollAndEnqueue(schedulerArgs),
  };
}

/** Parse a positive finite number from env, falling back when unset/empty; fail-loud on garbage. */
function envPositiveSeconds(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
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
  return n;
}

/**
 * Resolve the DSN + loop tunables from env. Fail-loud: a missing DSN or a non-positive/garbage
 * interval refuses to boot (a half-configured runner silently mis-leasing jobs is worse than a
 * crash-loop the platform surfaces). Defaults: lease 60s / heartbeat 15s / hard ceiling 900s
 * (background work — Confluence sync, retention — runs minutes, not the review pipeline's seconds) /
 * idle 5s / scheduler poll 30s. `owner` is hostname+pid — traceable to the pod, no random seam.
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
  return {
    dsn,
    config: {
      owner: `bg-runner-${hostname()}-${process.pid}`,
      leaseS: envPositiveSeconds(env, "CODEMASTER_BG_LEASE_S", 60),
      heartbeatS: envPositiveSeconds(env, "CODEMASTER_BG_HEARTBEAT_S", 15),
      maxRuntimeS: envPositiveSeconds(env, "CODEMASTER_BG_MAX_RUNTIME_S", 900),
      idleS: envPositiveSeconds(env, "CODEMASTER_BG_IDLE_S", 5),
      pollIntervalS: envPositiveSeconds(env, "CODEMASTER_BG_SCHEDULER_POLL_S", 30),
    },
  };
}

/**
 * The process entrypoint: build over the ADR-0062 shared pool + WallClock, run BOTH loops
 * concurrently, and shut down gracefully — SIGINT/SIGTERM stop() both loops, which DRAIN (an
 * in-flight job/poll pass always completes; the idle/poll cancellableSleep wakes immediately).
 * A crash in either loop stops + drains the other before the error re-throws (fail-loud; the
 * platform's restart policy is the supervisor). The shared pool is disposed after both loops
 * settle so no socket leaks across the exit path.
 *
 * NOT booted by any deployment yet — see the module doc (Phase 3b+ registers handlers first).
 */
export async function runBackgroundRunner(): Promise<void> {
  const { dsn, config } = resolveBackgroundRunnerConfig(process.env);
  const db = tenantKysely<unknown>(dsn); // THE shared ADR-0062 pool for this DSN
  const handles = buildBackgroundRunner({ db, clock: new WallClock(), config });

  const stopBoth = (): void => {
    handles.runnerLoop.stop();
    handles.schedulerLoop.stop();
  };
  process.once("SIGINT", stopBoth);
  process.once("SIGTERM", stopBoth);

  console.info(
    `background runner starting: owner=${config.owner} ` +
      `registered_job_types=[${handles.registry.registeredTypes().join(", ")}] ` +
      `(lease=${config.leaseS}s heartbeat=${config.heartbeatS}s maxRuntime=${config.maxRuntimeS}s ` +
      `idle=${config.idleS}s schedulerPoll=${config.pollIntervalS}s)`,
  );

  // allSettled (not all) so a crash in one loop still WAITS for the other to drain after stopBoth()
  // — Promise.all would reject immediately and leave the survivor's rejection unobserved.
  const results = await Promise.allSettled([
    handles.runnerLoop.run().catch((e: unknown) => {
      stopBoth();
      throw e;
    }),
    handles.schedulerLoop.run().catch((e: unknown) => {
      stopBoth();
      throw e;
    }),
  ]);

  process.removeListener("SIGINT", stopBoth);
  process.removeListener("SIGTERM", stopBoth);
  await disposePool(dsn);

  const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failure !== undefined) {
    throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
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
