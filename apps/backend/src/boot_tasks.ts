// The PURE boot-composition seam for the combined backend entrypoint (main.ts) — Phase 4d review
// blocker #6. resolveBootTasks decides WHICH long-running tasks join main.ts's fail-loud
// Promise.all, from env alone, over INJECTED thunks: no I/O happens here (nothing binds, connects,
// or polls), so the composition is unit-testable without booting HTTP/Temporal/Postgres, and a
// garbage flag value refuses boot BEFORE the HTTP server ever binds.
//
// ## CODEMASTER_RUN_BACKGROUND_RUNNER — the Phase-4 cutover boot flag (default OFF)
//
//   * unset/""/"false"/"0" (DEFAULT): the task list is BYTE-IDENTICAL to the pre-flag boot — the
//     Temporal review worker + the Temporal outbox-dispatcher worker. The Postgres background
//     runner does NOT boot.
//   * "true"/"1": runBackgroundRunner() JOINS the concurrent boot — the runner + scheduler +
//     outbox-drain loops (background_runner_main.ts) run in THIS process alongside the API.
//   * anything else: throws — fail-loud (the readUseBackgroundJobsFlag posture: a typo'd cutover
//     flag silently defaulting either way is worse than a crash-loop).
//
// ⚠️ The flag MUST stay OFF while the Temporal worker (with its Temporal Schedules) is also in the
// boot: the background runner's SchedulerLoop polls core.scheduled_jobs for the SAME crons
// (mutex_janitor, review_run_reaper, retention sweeps, …) that the Temporal Schedules still fire —
// booting both DOUBLE-RUNS every cron. The flag flips ON only at the Phase-4 cutover, when the
// Temporal worker (and its Schedules) is REMOVED from this boot and the Postgres runtime takes
// over. It pairs with CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS (background_jobs_temporal_port.ts):
// flipping THAT flag requires THIS one — the runner is the only consumer of the enqueued jobs.

/** The boot flag (read by {@link resolveBootTasks}). See the module doc for the cutover rules. */
export const RUN_BACKGROUND_RUNNER_ENV = "CODEMASTER_RUN_BACKGROUND_RUNNER";

/** Bounded task-name vocabulary of the combined boot (log/diagnostic labels, never user input). */
export type BootTaskName = "temporal-worker" | "temporal-outbox-dispatcher" | "background-runner";

/** One long-running boot task: a name (for logs) + the thunk main.ts awaits in its Promise.all. */
export type BootTask = Readonly<{ name: BootTaskName; run: () => Promise<void> }>;

/** What {@link resolveBootTasks} composes over — THUNKS, injected so tests never boot anything.
 *  Each blocks for the process lifetime when run (worker.run() / the supervised runner loops). */
export type BootDeps = Readonly<{
  /** The Temporal review worker (worker/main.ts). */
  runWorker: () => Promise<void>;
  /** The Temporal outbox-dispatcher worker (worker/outbox_dispatcher_main.ts). */
  runOutboxDispatcherWorker: () => Promise<void>;
  /** The Postgres background runtime (runner/background_runner_main.ts) — flag-gated OFF. */
  runBackgroundRunner: () => Promise<void>;
}>;

/** Strict boolean parse of {@link RUN_BACKGROUND_RUNNER_ENV} — garbage REFUSES to boot (the
 *  readUseBackgroundJobsFlag idiom). Accepted: "true"/"1" → on; unset/""/"false"/"0" → off. */
function readRunBackgroundRunnerFlag(env: NodeJS.ProcessEnv): boolean {
  // The key is the module's own const — not an attacker-controlled object-key sink; the
  // prototype-pollution threat model does not apply (the envPositiveSeconds idiom).
  // eslint-disable-next-line security/detect-object-injection
  const raw = env[RUN_BACKGROUND_RUNNER_ENV];
  if (raw === undefined || raw === "" || raw === "false" || raw === "0") {
    return false;
  }
  if (raw === "true" || raw === "1") {
    return true;
  }
  throw new Error(
    `${RUN_BACKGROUND_RUNNER_ENV} must be one of true|1|false|0 (or unset); got '${raw}'`,
  );
}

/**
 * Resolve the concurrent boot-task list for main.ts's fail-loud Promise.all. PURE composition:
 * reads env, returns the injected thunks BY IDENTITY (never wraps, NEVER invokes — main.ts owns
 * when the tasks run, after the HTTP server binds). Flag OFF (default): the two Temporal workers,
 * byte-identical to the pre-flag boot. Flag ON: the background runner joins them (the Phase-4
 * cutover posture — see the module doc's double-cron warning). Throws on a garbage flag value.
 */
export function resolveBootTasks(env: NodeJS.ProcessEnv, deps: BootDeps): ReadonlyArray<BootTask> {
  const tasks: Array<BootTask> = [
    { name: "temporal-worker", run: deps.runWorker },
    { name: "temporal-outbox-dispatcher", run: deps.runOutboxDispatcherWorker },
  ];
  if (readRunBackgroundRunnerFlag(env)) {
    tasks.push({ name: "background-runner", run: deps.runBackgroundRunner });
  }
  return tasks;
}
