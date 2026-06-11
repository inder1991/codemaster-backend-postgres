import type { Clock } from "#platform/clock.js";
import type { BackgroundJobV1 } from "#contracts/background_job.v1.js";

/**
 * Phase 3a W2b: the job_type → handler dispatch seam of the GENERIC background-job platform.
 *
 * The runner ({@link import("./background_runner.js").runOneBackgroundJob}) claims a
 * `core.background_jobs` row, looks its `job_type` up here, and dispatches the row's VERIFIED
 * payload to the registered handler. The registry is populated ONCE at the composition root
 * (the de-Temporal analogue of the Temporal worker's `activities=[...]` registry); a claimed job
 * whose job_type has NO entry is DEAD-LETTERED by the runner (terminalSettle, dead_reason
 * `no handler for <job_type>`) + metered — NEVER retried forever.
 */

/**
 * Per-invocation runtime context the RUNNER provides to a handler. Composition-root services
 * (DB repos, API clients, …) are closed over at `register(...)` time — the buildActivities idiom —
 * NOT threaded through here; this bundle carries only what the runner itself owns per claim:
 *   * `job`    — the claimed row (job_id / installation_id / attempts / max_attempts context).
 *   * `clock`  — the mandatory Clock seam (clock_random gate: handlers never read wall time raw).
 *   * `shadow` — the CS1.2 no-side-effects posture (CODEMASTER_RUNTIME_MODE=shadow). When true,
 *     the {@link HandlerRegistry.register} wrapper SUPPRESSES the handler body entirely (logged
 *     would-run) — no external call (GitHub / LLM / embed / clone) and no production-table write
 *     can start. REQUIRED (not optional) so every constructor of a HandlerDeps bundle decides the
 *     posture explicitly; the runner threads its own resolved flag.
 */
export type HandlerDeps = {
  job: BackgroundJobV1;
  clock: Clock;
  shadow: boolean;
};

/**
 * One job_type's unit of work. `payload` is the hash-verified stored payload
 * ({@link import("./background_jobs_repo.js").BackgroundJobsRepo.verifyPayload}) typed `unknown` —
 * each handler owns parsing it with its OWN Zod contract (the platform's payload is opaque).
 * `signal` is the cooperative-cancellation seam: the runner aborts it on lease loss AND at the
 * hard runtime ceiling; handlers SHOULD honor it (an ignoring handler is force-settled `failed`
 * and observed by the F4 orphan observer — it can never hang the worker slot).
 */
export type JobHandler = (payload: unknown, signal: AbortSignal, deps: HandlerDeps) => Promise<void>;

export class HandlerRegistry {
  readonly #handlers = new Map<string, JobHandler>();

  /**
   * Bind a job_type to its handler. Fail-loud at the composition root: an empty job_type or a
   * DUPLICATE registration throws immediately (a silent last-write-wins would mask a wiring bug
   * the same way a missing Temporal activity registration did — surface it at boot, not at claim).
   *
   * CS1.2 SHADOW guard — EVERY registered handler is wrapped at this SINGLE choke point: when the
   * dispatch arrives with `deps.shadow === true`, the wrapper logs the would-run observation and
   * returns WITHOUT invoking the handler body, so no handler (current or future) can perform an
   * external call (GitHub / LLM / embed / clone) or a production-table write in shadow mode. The
   * guard lives HERE — not copy-pasted into 13 handler bodies — so forgetting it is structurally
   * impossible for anything that registers through this registry ([[eliminate_over_detect]]).
   */
  register(jobType: string, handler: JobHandler): void {
    if (jobType.length === 0) {
      throw new Error("HandlerRegistry.register: job_type must be non-empty");
    }
    if (this.#handlers.has(jobType)) {
      throw new Error(`HandlerRegistry.register: duplicate handler registration for job_type '${jobType}'`);
    }
    const guarded: JobHandler = async (payload, signal, deps) => {
      if (deps.shadow) {
        console.info(
          `shadow-mode: would-run job_type=${jobType} job_id=${deps.job.job_id} — handler ` +
            `SUPPRESSED (no external calls, no production writes; CS1.2 no-side-effects contract)`,
        );
        return;
      }
      await handler(payload, signal, deps);
    };
    this.#handlers.set(jobType, guarded);
  }

  /** The handler for `jobType`, or undefined — the runner dead-letters the undefined case. */
  get(jobType: string): JobHandler | undefined {
    return this.#handlers.get(jobType);
  }

  /** Registered job_types (diagnostics / boot logging). */
  registeredTypes(): ReadonlyArray<string> {
    return [...this.#handlers.keys()];
  }
}
