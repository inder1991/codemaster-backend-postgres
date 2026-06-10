// Phase 4c W4c.2 review blocker #10 — runner-owned background-resource disposal.
//
// The handler modules' DEFAULT lazy clients construct long-lived background resources on first use
// — concretely the ConfluenceTokenProvider refresh loop (_confluence_page_sync.ts), a LIVE
// WallClock.sleep timer (a raw, un-unref'd setTimeout). Pre-fix nothing owned a handle to stop
// them: after SIGTERM stopped the runner/scheduler/outbox loops, a built refresh loop kept the
// event loop alive and the process HUNG instead of exiting promptly.
//
// The fix shape: every lazy builder that starts such a resource returns a DISPOSABLE (the client +
// a dispose() that stops the resource); the registration sites hand the dispose to THIS registry
// (threaded through {@link import("./handlers/cron_handlers.js").CronHandlersDeps} /
// {@link import("./handlers/event_handlers.js").EventHandlersDeps} by buildBackgroundRunner); and
// runBackgroundRunner's DISPOSE PHASE calls {@link DisposableRegistry.disposeAll} once ALL loops
// have ended, right before the shared pool is disposed.

/** One disposable background resource a handler/composition-root lazily constructs. */
export type RunnerDisposable = {
  /** Stable name for the shutdown log — composition-root literals (bounded vocabulary). */
  readonly name: string;
  /** Stop the resource. MUST be idempotent and MUST NOT itself trigger any lazily-deferred
   *  construction (disposing a never-used lazy client is a clean no-op). */
  dispose(): Promise<void>;
};

/**
 * The small shared registry the handler modules and {@link
 * import("./background_runner_main.js").buildBackgroundRunner} compose over. Registration order is
 * disposal order (FIFO — there are no inter-resource dependencies today; the refresh loops are
 * independent timers).
 */
export class DisposableRegistry {
  readonly #items: Array<RunnerDisposable> = [];

  public register(d: RunnerDisposable): void {
    this.#items.push(d);
  }

  /** Registered names, in registration (= disposal) order — shutdown-log / test observability. */
  public registeredNames(): ReadonlyArray<string> {
    return this.#items.map((d) => d.name);
  }

  /**
   * Dispose EVERY registered resource. Error-safe by design: this is the shutdown path — a failing
   * dispose is ERROR-logged and the remaining disposables still run (nothing useful can react to a
   * throw here, and an undisposed sibling timer would hang the very exit this phase exists to
   * unblock). Never rejects.
   */
  public async disposeAll(): Promise<void> {
    for (const d of this.#items) {
      try {
        await d.dispose();
      } catch (e) {
        console.error(
          `background runner: dispose '${d.name}' failed (continuing with the remaining ` +
            `disposables): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
        );
      }
    }
  }
}
