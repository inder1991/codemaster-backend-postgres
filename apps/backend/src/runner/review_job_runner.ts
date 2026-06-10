import type { Clock } from "#platform/clock.js";
import type { ReviewJobsRepo } from "./review_jobs_repo.js";
import type { ReviewJobV1 } from "#contracts/review_jobs.v1.js";
import { cancellableSleep } from "./clock_async.js";
import { DEFAULT_LEDGER_RETENTION_DAYS } from "#backend/integrations/llm/invocation_ledger.js";
import {
  recordClaimLatencyMs,
  recordCrashLoopReaped,
  recordHandlerDurationMs,
  recordHeartbeatFailure,
  recordJobOutcome,
  recordLeaseSteal,
  recordRetryAttempt,
  recordStaleTokenWrite,
} from "./runner_metrics.js";

/**
 * The narrow ledger-pruner seam the {@link RunnerLoop} idle cycle depends on (W6.4 / D2). The concrete
 * {@link import("#backend/integrations/llm/invocation_ledger.js").LlmInvocationLedger} satisfies it
 * structurally; typing the loop's dep to this PORT (not the concrete class) keeps the runner free of a
 * Postgres-pool dependency in tests — a counting/in-memory stub can stand in.
 */
export type LedgerPrunerPort = {
  /** DELETE every ledger row older than `days` days; returns how many rows were deleted (cross-tenant). */
  pruneOlderThan(days: number): Promise<number>;
};

/**
 * The retention sweep is throttled to AT MOST ONCE per this many seconds (default 21600 = 6h), read once
 * from `CODEMASTER_LLM_LEDGER_PRUNE_INTERVAL_S`. A non-positive or non-numeric value falls back to the
 * default so a misconfiguration can never make the runner prune on EVERY idle cycle (which would hammer
 * the cross-tenant DELETE). The throttle is measured on `clock.monotonic()` (clock_random gate — no raw
 * wall-clock read, no raw timer).
 */
export const DEFAULT_LEDGER_PRUNE_INTERVAL_S: number = (() => {
  const raw = process.env["CODEMASTER_LLM_LEDGER_PRUNE_INTERVAL_S"];
  if (raw === undefined) return 21600;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 21600;
})();
export type JobHandler = (job: ReviewJobV1, signal: AbortSignal) => Promise<void>;
export type RunOutcome = "idle" | "done" | "failed" | "lease_lost" | "cancelled";

/**
 * Terminal supersede/abort signal the shell throws so {@link runOneJob} settles the job `cancelled`
 * (via `markCancelled`) instead of `markFailed`'s retry/dead-letter path (E3). The shell raises this for
 * the supersede/lost-claim family — `PrMutexLostClaim` / `StaleWriteError` / `StateDrift` /
 * `CurrentRunMismatch` / an aborted `signal` — so a loser exits clean and is NEVER re-enqueued.
 * `reason` is the bounded human-readable cause persisted to `core.review_jobs.cancel_reason`.
 */
export class TerminalCancelError extends Error {
  constructor(public readonly reason: string, cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "TerminalCancelError";
  }
}
/** Sentinel the hard-runtime race resolves to when the handler overran `maxRuntimeS`. */
const HARD_TIMEOUT = Symbol("hard-timeout");

/**
 * The CHECK-valid `core.review_runs.cancel_reason` written when {@link runOneJob} terminally cancels a run via
 * {@link ReviewJobsRepo.terminalSettle}. The run-side column is constrained to
 * {superseded|operator_cancelled|timeout|repository_disabled|installation_suspended|shutdown}; `terminalSettle`
 * does NOT set `superseded_by_run_id`, so we deliberately AVOID the run-side `'superseded'` value (which carries
 * the coupled `ck_review_runs_supersede_reason` invariant — the upstream supersede primitive owns setting
 * `superseded_by_run_id`). Every {@link TerminalCancelError} (`superseded`/`mutex-lost`/`aborted`/…) maps to the
 * generic `'operator_cancelled'`; the precise free-text cause is preserved on `review_jobs.cancel_reason`.
 */
const RUN_CANCEL_REASON = "operator_cancelled";
export async function runOneJob(o: { repo: ReviewJobsRepo; clock: Clock; owner: string; leaseS: number;
  heartbeatS: number; maxRuntimeS: number; handler: JobHandler }): Promise<{ outcome: RunOutcome; jobId?: string }> {
  const leaseMs = o.leaseS * 1000;
  const claimStart = o.clock.monotonic();
  const job = await o.repo.claim({ owner: o.owner, leaseMs, maxRuntimeMs: o.maxRuntimeS * 1000 });
  recordClaimLatencyMs((o.clock.monotonic() - claimStart) * 1000);
  if (!job) { recordJobOutcome({ outcome: "idle" }); return { outcome: "idle" }; }
  const token = job.attempt_token!;
  if (job.attempts > 1) recordLeaseSteal();   // a reclaim minted attempts > 1 → a prior owner crashed
  const handlerStart = o.clock.monotonic();
  const work = new AbortController();   // cooperative stop of the handler (lease-loss OR runtime ceiling)
  const stop = new AbortController();    // stops the heartbeat + hard-timeout helpers once the job settles
  const hb = (async () => {
    try {
      while (!stop.signal.aborted) {
        await cancellableSleep(o.clock, o.heartbeatS, stop.signal);
        if (stop.signal.aborted) break;
        const held = await o.repo.heartbeat({ jobId: job.job_id, owner: o.owner, token, leaseMs }); // false past timeout_at too
        if (!held) { recordHeartbeatFailure(); work.abort(new Error("lease lost or timed out")); break; }
      }
    } catch { work.abort(new Error("heartbeat error")); }   // never let the hb loop throw out
  })();
  // HARD runtime ceiling — guarantees the worker slot returns even if the handler ignores `work.signal`.
  const hardTimeout = (async (): Promise<typeof HARD_TIMEOUT | undefined> => {
    await cancellableSleep(o.clock, o.maxRuntimeS, stop.signal);
    if (stop.signal.aborted) return undefined;            // job settled first → no timeout
    work.abort(new Error("max runtime exceeded"));         // cooperative nudge for well-behaved handlers
    return HARD_TIMEOUT;
  })();
  // F4: whether THIS attempt is the last one. Read off the claimed row (`claim()` already incremented
  // `attempts`; nothing else mutates it before settlement) so it is identical to markFailed's CASE predicate.
  const isLastAttempt = job.attempts >= job.max_attempts;

  /**
   * Settle a FAILURE: when this is the last attempt the run must die WITH the job — route through the
   * ATOMIC {@link ReviewJobsRepo.terminalSettle} (job→dead, run→FAILED, ONE txn — no split-brain, F4). When
   * attempts remain it is a plain retry — `markFailed` re-enqueues the job (`ready`) and the run stays
   * RUNNING (the next attempt re-uses the same run). A stale token → 0 rows → `lease_lost`.
   */
  const settleFailure = async (error: string): Promise<RunOutcome> => {
    if (isLastAttempt) {
      const r = await o.repo.terminalSettle({ jobId: job.job_id, owner: o.owner, token, runId: job.run_id,
        jobState: "dead", runState: "FAILED", reason: error });
      if (!r.applied) recordStaleTokenWrite({ op: "markFailed" });
      return r.applied ? "failed" : "lease_lost";
    }
    const r = await o.repo.markFailed({ jobId: job.job_id, owner: o.owner, token, error, baseBackoffMs: 1000 });
    if (!r.applied) recordStaleTokenWrite({ op: "markFailed" });
    else recordRetryAttempt();   // attempts remain by construction → this is a retry (run stays RUNNING)
    return r.applied ? "failed" : "lease_lost";
  };

  let outcome: RunOutcome;
  try {
    const handlerDone: Promise<undefined> = o.handler(job, work.signal).then(() => undefined);
    const raced = await Promise.race([handlerDone, hardTimeout]);
    if (raced === HARD_TIMEOUT) {
      // Handler overran the ceiling (and may still be running, orphaned — it violated the honor-`signal`
      // contract). Settle as failed; the fence guards against any late completion write.
      outcome = await settleFailure(`max runtime ${o.maxRuntimeS}s exceeded`);
    } else {
      const done = await o.repo.markDone({ jobId: job.job_id, owner: o.owner, token });
      if (!done.applied) recordStaleTokenWrite({ op: "markDone" });
      outcome = done.applied ? "done" : "lease_lost";
    }
  } catch (e) {
    if (e instanceof TerminalCancelError) {
      // Supersede/abort loser (E3): settle 'cancelled' — terminal, NEVER re-enqueued (markFailed would
      // bounce it back to 'ready' while attempts remain). ATOMIC (F4): the job AND its run move together via
      // `terminalSettle` (job→cancelled, run→CANCELLED, ONE txn) so a cancelled job never strands a RUNNING
      // run. Fenced like markDone: a stolen lease ⇒ 0 rows ⇒ neither row touched ⇒ `lease_lost`.
      const c = await o.repo.terminalSettle({ jobId: job.job_id, owner: o.owner, token, runId: job.run_id,
        jobState: "cancelled", runState: "CANCELLED", reason: e.reason, runCancelReason: RUN_CANCEL_REASON });
      if (!c.applied) recordStaleTokenWrite({ op: "markFailed" });   // lease was stolen → loser; bounded op label
      outcome = c.applied ? "cancelled" : "lease_lost";
    } else {
      outcome = await settleFailure(e instanceof Error ? e.message : String(e));
    }
  } finally { stop.abort(); await hb; await hardTimeout; }   // immediate stop (cancellableSleep wakes); helpers never mask `outcome`
  recordHandlerDurationMs((o.clock.monotonic() - handlerStart) * 1000);
  recordJobOutcome({ outcome });
  return { outcome, jobId: job.job_id };
}

export class RunnerLoop {
  #stopped = false;
  readonly #stop = new AbortController();                  // wakes the idle sleep immediately on stop()
  // Monotonic marker of the last ledger prune (W6.4 / D2). Sentinel `-Infinity` so the FIRST idle cycle
  // always clears the throttle (no wall-clock read; the gap is measured on `clock.monotonic()`).
  #lastPruneMonotonic = Number.NEGATIVE_INFINITY;
  constructor(private o: { repo: ReviewJobsRepo; clock: Clock; ledger: LedgerPrunerPort; owner: string;
    leaseS: number; heartbeatS: number; maxRuntimeS: number; idleS: number; handler: JobHandler }) {}
  stop() { this.#stopped = true; this.#stop.abort(); }     // wire to process.on('SIGTERM', () => loop.stop())

  /**
   * The idle-cycle maintenance sweep (W6.1 reaper + W6.4 throttled ledger prune), run between job claims
   * when the queue is empty. Factored out so it is independently exercisable (the throttle is deterministic
   * under a {@link FakeClock}). Always: run the UNIFIED reaper (job+run+mutex+audit, D3 gate ④). Then, AT
   * MOST ONCE per {@link DEFAULT_LEDGER_PRUNE_INTERVAL_S}, prune the LLM-invocation ledger of rows older
   * than {@link DEFAULT_LEDGER_RETENTION_DAYS} days — throttled on `clock.monotonic()` (clock_random gate:
   * no wall-clock read, no raw timer).
   */
  async runIdleMaintenance(): Promise<void> {
    recordCrashLoopReaped(await this.o.repo.reapStuckRuns()); // unified reaper: job+run+mutex+audit (D3, gate ④)
    const nowMonotonic = this.o.clock.monotonic();
    if (nowMonotonic - this.#lastPruneMonotonic >= DEFAULT_LEDGER_PRUNE_INTERVAL_S) {
      await this.o.ledger.pruneOlderThan(DEFAULT_LEDGER_RETENTION_DAYS);
      this.#lastPruneMonotonic = nowMonotonic;              // reset the throttle marker after the sweep
    }
  }

  async run(): Promise<void> {
    while (!this.#stopped) {
      const { outcome } = await runOneJob(this.o);          // an in-flight job ALWAYS runs to completion (drain)
      if (outcome === "idle" && !this.#stopped) {
        await this.runIdleMaintenance();                    // reaper (W6.1) + throttled ledger prune (W6.4)
        await cancellableSleep(this.o.clock, this.o.idleS, this.#stop.signal); // stop() interrupts this wait (v3 #6)
      }
    }
  }
}
