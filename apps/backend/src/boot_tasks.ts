// The PURE boot-composition seam for the combined backend entrypoint (main.ts) — Phase 4d review
// blocker #6, reshaped by CS1.1 (cutover-safety plan finding CS1). resolveBootTasks decides WHICH
// long-running tasks join main.ts's fail-loud Promise.all, from env alone, over INJECTED thunks:
// no I/O happens here (nothing binds, connects, or polls), so the composition is unit-testable
// without booting HTTP/Temporal/Postgres, and a garbage mode value refuses boot BEFORE the HTTP
// server ever binds.
//
// ## CODEMASTER_RUNTIME_MODE — ONE mode, mutually exclusive runtimes (CS1.1)
//
// The previous shape was TWO independent cutover booleans (CODEMASTER_RUN_BACKGROUND_RUNNER for
// the boot list + CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS for the outbox sink port) whose 2×2
// combinations allowed the Temporal workers AND the Postgres background runner to boot TOGETHER —
// both fire the SAME crons (mutex_janitor, review_run_reaper, retention sweeps, …) and drain the
// SAME core.outbox, so the joined boot double-runs every cron (audit C7/C9/RC8/C8/RT1). ONE mode
// replaces both booleans and makes the runtimes mutually exclusive BY CONSTRUCTION — the branches
// below are disjoint; no mode value yields both a Temporal task and the background runner:
//
//   * "temporal" (DEFAULT — unset/"" parse to it, byte-identical to the pre-mode boot): the
//     Temporal review worker + the Temporal outbox-dispatcher worker. The Postgres background
//     runner does NOT boot.
//   * "postgres": ONLY the Postgres background runner (runner + scheduler + outbox-drain loops,
//     background_runner_main.ts). NO Temporal task boots — the SchedulerLoop replaces the Temporal
//     Schedules' crons and the OutboxDispatcherLoop drains core.outbox onto the Postgres jobs
//     platform (the runner ALWAYS wires the BackgroundJobsTemporalPort; the old outbox boolean is
//     subsumed by the mode).
//   * "shadow": ONLY the background runner, exactly as "postgres" (same exclusivity), with the
//     mode threaded through to deps.runBackgroundRunner so the runner knows it is shadowing
//     (the CS-followup tasks define shadow-specific behavior over this seam).
//   * anything else: throws — fail-loud (a typo'd cutover mode silently defaulting either way is
//     worse than a crash-loop).
//
// ## The two REPLACED booleans REFUSE boot when still set
//
// CODEMASTER_RUN_BACKGROUND_RUNNER and CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS are REMOVED — nothing
// reads them for behavior anymore. parseRuntimeMode REFUSES boot (naming the replacement) when
// either is still set: a set-but-now-ignored cutover flag is exactly the hazard class the mode
// removes — an operator deploying stale env must get a crash-loop naming the migration, never a
// silently different runtime than the one their env was written for.

/** The runtime-mode env var (read by {@link parseRuntimeMode}). See the module doc. */
export const RUNTIME_MODE_ENV = "CODEMASTER_RUNTIME_MODE";

/** REMOVED boot boolean (CS1.1): setting it refuses boot — {@link RUNTIME_MODE_ENV} replaced it. */
export const DEPRECATED_RUN_BACKGROUND_RUNNER_ENV = "CODEMASTER_RUN_BACKGROUND_RUNNER";

/** REMOVED outbox-port boolean (CS1.1): setting it refuses boot — the mode subsumed it (the
 *  background runner ALWAYS uses the Postgres-enqueue port; Temporal is absent in its modes). */
export const DEPRECATED_OUTBOX_USE_BACKGROUND_JOBS_ENV = "CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS";

/** The bounded runtime-mode vocabulary. See the module doc for what each mode boots. */
export type RuntimeMode = "temporal" | "postgres" | "shadow";

/** The modes under which the Postgres background runner boots — "temporal" is excluded BY TYPE
 *  (the CS1.1 exclusivity invariant, visible in the signature of every runner entrypoint). */
export type BackgroundRunnerMode = Exclude<RuntimeMode, "temporal">;

const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = ["temporal", "postgres", "shadow"];

/**
 * Strict parse of {@link RUNTIME_MODE_ENV}. Unset/"" → "temporal" (back-compat: the pre-mode boot
 * shape); the three literal modes parse to themselves; ANYTHING else throws naming the valid
 * values (fail-loud — the readRunBackgroundRunnerFlag posture this parser replaces). Also REFUSES
 * boot while either REMOVED boolean is still set (module doc: stale cutover env must crash-loop
 * naming the migration, never be silently ignored).
 */
export function parseRuntimeMode(env: NodeJS.ProcessEnv): RuntimeMode {
  for (const removed of [
    DEPRECATED_RUN_BACKGROUND_RUNNER_ENV,
    DEPRECATED_OUTBOX_USE_BACKGROUND_JOBS_ENV,
  ]) {
    // The keys are this module's own consts — not an attacker-controlled object-key sink; the
    // prototype-pollution threat model does not apply (the envPositiveSeconds idiom).
    // eslint-disable-next-line security/detect-object-injection
    const stale = env[removed];
    if (stale !== undefined && stale !== "") {
      throw new Error(
        `${removed} is REMOVED (CS1.1) and no longer controls anything — a set-but-ignored ` +
          `cutover flag is exactly the hazard the runtime mode replaces. Unset it and set ` +
          `${RUNTIME_MODE_ENV}=temporal|postgres|shadow instead (got ${removed}='${stale}').`,
      );
    }
  }
  // eslint-disable-next-line security/detect-object-injection
  const raw = env[RUNTIME_MODE_ENV];
  if (raw === undefined || raw === "") {
    return "temporal";
  }
  if ((RUNTIME_MODES as ReadonlyArray<string>).includes(raw)) {
    return raw as RuntimeMode;
  }
  throw new Error(
    `${RUNTIME_MODE_ENV} must be one of temporal|postgres|shadow (or unset → temporal); got '${raw}'`,
  );
}

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
  /** The Postgres background runtime (runner/background_runner_main.ts). Receives the resolved
   *  mode ("postgres" | "shadow") so the runner knows whether it is shadowing — and so the
   *  type-level exclusivity holds: this thunk can never be invoked with "temporal". */
  runBackgroundRunner: (mode: BackgroundRunnerMode) => Promise<void>;
}>;

/**
 * Resolve the concurrent boot-task list for main.ts's fail-loud Promise.all. PURE composition:
 * reads env, returns thunks (the Temporal thunks BY IDENTITY; the runner thunk binds the resolved
 * mode), NEVER invokes — main.ts owns when the tasks run, after the HTTP server binds.
 *
 * The CS1.1 EXCLUSIVITY invariant lives in the disjoint branches below: "temporal" returns the two
 * Temporal tasks and NEVER the background runner; "postgres"/"shadow" return ONLY the background
 * runner and NEVER a Temporal task. There is no mode under which both runtimes boot (the old
 * two-boolean shape allowed exactly that — double-cron / double-drain). Throws on a garbage mode
 * value and while either removed boolean is still set ({@link parseRuntimeMode}).
 */
export function resolveBootTasks(env: NodeJS.ProcessEnv, deps: BootDeps): ReadonlyArray<BootTask> {
  const mode = parseRuntimeMode(env);
  if (mode === "temporal") {
    return [
      { name: "temporal-worker", run: deps.runWorker },
      { name: "temporal-outbox-dispatcher", run: deps.runOutboxDispatcherWorker },
    ];
  }
  // "postgres" | "shadow": the Postgres runtime ONLY — never any Temporal task. The thunk binds
  // the narrowed mode so the runner knows whether it is shadowing (still no invocation here).
  return [{ name: "background-runner", run: async () => deps.runBackgroundRunner(mode) }];
}
