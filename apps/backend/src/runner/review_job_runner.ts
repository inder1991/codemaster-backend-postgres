import type { Clock } from "#platform/clock.js";
import type { ReviewJobsRepo } from "./review_jobs_repo.js";
import type { ReviewJobV1 } from "#contracts/review_jobs.v1.js";
import { cancellableSleep } from "./clock_async.js";
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
  let outcome: RunOutcome;
  try {
    const handlerDone: Promise<undefined> = o.handler(job, work.signal).then(() => undefined);
    const raced = await Promise.race([handlerDone, hardTimeout]);
    if (raced === HARD_TIMEOUT) {
      // Handler overran the ceiling (and may still be running, orphaned — it violated the honor-`signal`
      // contract). Settle as failed; the fence guards against any late completion write.
      const r = await o.repo.markFailed({ jobId: job.job_id, owner: o.owner, token,
        error: `max runtime ${o.maxRuntimeS}s exceeded`, baseBackoffMs: 1000 });
      if (!r.applied) recordStaleTokenWrite({ op: "markFailed" });
      else if (!r.terminal) recordRetryAttempt();
      outcome = r.applied ? "failed" : "lease_lost";
    } else {
      const done = await o.repo.markDone({ jobId: job.job_id, owner: o.owner, token });
      if (!done.applied) recordStaleTokenWrite({ op: "markDone" });
      outcome = done.applied ? "done" : "lease_lost";
    }
  } catch (e) {
    if (e instanceof TerminalCancelError) {
      // Supersede/abort loser (E3): settle 'cancelled' — terminal, NEVER re-enqueued (markFailed would
      // bounce it back to 'ready' while attempts remain). Fenced like markDone: a stolen lease ⇒ 0 rows.
      const c = await o.repo.markCancelled({ jobId: job.job_id, owner: o.owner, token, reason: e.reason });
      if (!c.applied) recordStaleTokenWrite({ op: "markFailed" });   // lease was stolen → loser; bounded op label
      outcome = c.applied ? "cancelled" : "lease_lost";
    } else {
      const r = await o.repo.markFailed({ jobId: job.job_id, owner: o.owner, token,
        error: e instanceof Error ? e.message : String(e), baseBackoffMs: 1000 });
      if (!r.applied) recordStaleTokenWrite({ op: "markFailed" });
      else if (!r.terminal) recordRetryAttempt();
      outcome = r.applied ? "failed" : "lease_lost";
    }
  } finally { stop.abort(); await hb; await hardTimeout; }   // immediate stop (cancellableSleep wakes); helpers never mask `outcome`
  recordHandlerDurationMs((o.clock.monotonic() - handlerStart) * 1000);
  recordJobOutcome({ outcome });
  return { outcome, jobId: job.job_id };
}

export class RunnerLoop {
  #stopped = false;
  readonly #stop = new AbortController();                  // wakes the idle sleep immediately on stop()
  constructor(private o: { repo: ReviewJobsRepo; clock: Clock; owner: string; leaseS: number; heartbeatS: number;
    maxRuntimeS: number; idleS: number; handler: JobHandler }) {}
  stop() { this.#stopped = true; this.#stop.abort(); }     // wire to process.on('SIGTERM', () => loop.stop())
  async run(): Promise<void> {
    while (!this.#stopped) {
      const { outcome } = await runOneJob(this.o);          // an in-flight job ALWAYS runs to completion (drain)
      if (outcome === "idle" && !this.#stopped) {
        recordCrashLoopReaped(await this.o.repo.reapCrashLooped()); // bounded cleanup of maxed-out crashed leases (v3 #2)
        await cancellableSleep(this.o.clock, this.o.idleS, this.#stop.signal); // stop() interrupts this wait (v3 #6)
      }
    }
  }
}
