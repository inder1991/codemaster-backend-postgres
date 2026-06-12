// The PURE boot-composition seam for the combined backend entrypoint (main.ts). resolveBootTasks
// decides WHICH long-running tasks join main.ts's fail-loud Promise.all, from env alone, over an
// INJECTED thunk: no I/O happens here (nothing binds, connects, or polls), so the composition is
// unit-testable without booting HTTP/Postgres, and a garbage mode value refuses boot BEFORE the
// HTTP server ever binds.
//
// ## CODEMASTER_RUNTIME_MODE — the Postgres runtime (Temporal removed)
//
// Temporal has been torn out entirely (the @temporalio worker / workflows / client are gone). The
// runtime is the Postgres background runner — runner + scheduler + outbox-drain loops
// (background_runner_main.ts). The mode vocabulary survives only to distinguish the live runtime
// from SHADOW (observe-only, no side effects):
//
//   * "postgres" (DEFAULT — unset/"" parse to it): the live background runner.
//   * "shadow": the background runner in observe-only mode (the mode threaded through so the runner
//     knows it is shadowing — the CS1.2 no-side-effects contract).
//   * "temporal": REFUSED — the Temporal runtime no longer exists; a stale `temporal` env must
//     crash-loop naming the removal, never silently boot nothing.
//   * anything else: throws — fail-loud.
//
// ## Removed booleans REFUSE boot
//
// CODEMASTER_RUN_BACKGROUND_RUNNER and CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS were removed at the
// cutover (CS1.1); parseRuntimeMode still refuses boot (naming the replacement) when either is set
// — a set-but-ignored cutover flag is exactly the hazard the mode removed.

/** The runtime-mode env var (read by {@link parseRuntimeMode}). See the module doc. */
export const RUNTIME_MODE_ENV = "CODEMASTER_RUNTIME_MODE";

/** REMOVED boot boolean (CS1.1): setting it refuses boot — {@link RUNTIME_MODE_ENV} replaced it. */
export const DEPRECATED_RUN_BACKGROUND_RUNNER_ENV = "CODEMASTER_RUN_BACKGROUND_RUNNER";

/** REMOVED outbox-port boolean (CS1.1): setting it refuses boot — the background runner always uses
 *  the Postgres-enqueue port. */
export const DEPRECATED_OUTBOX_USE_BACKGROUND_JOBS_ENV = "CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS";

/** The bounded runtime-mode vocabulary (Temporal removed). See the module doc. */
export type RuntimeMode = "postgres" | "shadow";

/** The mode the background runner boots under (Temporal is gone, so this is RuntimeMode itself; the
 *  alias is kept so the runner entrypoints read as before). */
export type BackgroundRunnerMode = RuntimeMode;

const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = ["postgres", "shadow"];

/**
 * Strict parse of {@link RUNTIME_MODE_ENV}. Unset/"" → "postgres" (the live runtime); "postgres"/
 * "shadow" parse to themselves; "temporal" throws naming the removal; anything else throws naming
 * the valid values. Also REFUSES boot while either REMOVED boolean is still set.
 */
export function parseRuntimeMode(env: NodeJS.ProcessEnv): RuntimeMode {
  for (const removed of [
    DEPRECATED_RUN_BACKGROUND_RUNNER_ENV,
    DEPRECATED_OUTBOX_USE_BACKGROUND_JOBS_ENV,
  ]) {
    // The keys are this module's own consts — not an attacker-controlled object-key sink.
    // eslint-disable-next-line security/detect-object-injection
    const stale = env[removed];
    if (stale !== undefined && stale !== "") {
      throw new Error(
        `${removed} is REMOVED (CS1.1) and no longer controls anything. Unset it and set ` +
          `${RUNTIME_MODE_ENV}=postgres|shadow instead (got ${removed}='${stale}').`,
      );
    }
  }
  // eslint-disable-next-line security/detect-object-injection
  const raw = env[RUNTIME_MODE_ENV];
  if (raw === undefined || raw === "") {
    return "postgres";
  }
  if (raw === "temporal") {
    throw new Error(
      `${RUNTIME_MODE_ENV}=temporal is REMOVED — the Temporal runtime was torn out. ` +
        `Set ${RUNTIME_MODE_ENV}=postgres (or shadow), or unset it (defaults to postgres).`,
    );
  }
  if ((RUNTIME_MODES as ReadonlyArray<string>).includes(raw)) {
    return raw as RuntimeMode;
  }
  throw new Error(`${RUNTIME_MODE_ENV} must be postgres|shadow (or unset → postgres); got '${raw}'`);
}

/** Bounded task-name vocabulary of the combined boot (log/diagnostic labels, never user input). */
export type BootTaskName = "background-runner";

/** One long-running boot task: a name (for logs) + the thunk main.ts awaits in its Promise.all. */
export type BootTask = Readonly<{ name: BootTaskName; run: () => Promise<void> }>;

/** What {@link resolveBootTasks} composes over — the runner THUNK, injected so tests never boot
 *  anything. It blocks for the process lifetime when run (the supervised runner loops). */
export type BootDeps = Readonly<{
  /** The Postgres background runtime (runner/background_runner_main.ts). Receives the resolved mode
   *  so the runner knows whether it is shadowing. */
  runBackgroundRunner: (mode: BackgroundRunnerMode) => Promise<void>;
}>;

/**
 * Resolve the concurrent boot-task list for main.ts's fail-loud Promise.all. PURE composition:
 * reads env, returns the runner thunk bound to the resolved mode, NEVER invokes — main.ts owns when
 * it runs, after the HTTP server binds. Throws on a garbage/temporal mode or a stale removed boolean
 * ({@link parseRuntimeMode}).
 */
export function resolveBootTasks(env: NodeJS.ProcessEnv, deps: BootDeps): ReadonlyArray<BootTask> {
  const mode = parseRuntimeMode(env);
  return [{ name: "background-runner", run: async () => deps.runBackgroundRunner(mode) }];
}
