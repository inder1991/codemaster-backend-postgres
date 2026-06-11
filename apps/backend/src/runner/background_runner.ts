import { ZodError } from "zod";
import type { Clock } from "#platform/clock.js";
import type { BackgroundJobsRepo } from "./background_jobs_repo.js";
import type { HandlerDeps, HandlerRegistry } from "./handler_registry.js";
import { PermanentJobError } from "./errors.js";
import { cancellableSleep } from "./clock_async.js";
import { extractRetryAtHint } from "./retry_hints.js";
import {
  recordBackgroundJobOutcome,
  recordClaimLatencyMs,
  recordCrashLoopReaped,
  recordHandlerDurationMs,
  recordHandlerOrphanSettled,
  recordHeartbeatFailure,
  recordLeaseSteal,
  recordNoHandlerDeadLetter,
  recordRetryAttempt,
  recordStaleTokenWrite,
} from "./runner_metrics.js";

// Phase 3a W2b: the GENERIC background runner over core.background_jobs — the 1:1 generalization
// (over job_type) of the PROVEN review_jobs runner (review_job_runner.ts::runOneJob/RunnerLoop):
// same claim → run → settle shape, same heartbeat loop, same HARD-timeout race + F4 orphan
// observer, same fenced settle discipline. Deliberate divergences (mirroring the W2a repo's
// divergences from ReviewJobsRepo):
//   * DISPATCH is by registry lookup (job_type → JobHandler), not a single injected handler. A
//     claimed job whose job_type has NO registered handler is DEAD-LETTERED (terminalSettle,
//     dead_reason `no handler for <job_type>`) + metered — NOT retried forever (retry cannot
//     conjure a handler; the wiring bug surfaces once per enqueue, not max_attempts times).
//   * The payload is hash-VERIFIED (BackgroundJobsRepo.verifyPayload) BEFORE the handler runs; a
//     mismatch is a POISON PILL → terminalSettle dead (retry cannot fix corrupted bytes).
//   * Handler throws are CLASSIFIED at the settle seam (Phase 4a W4a.1, mirroring the outbox's
//     RetryableSinkError/PermanentSinkError split): PermanentJobError (./errors.js) and a bare
//     ZodError (the payload fails its contract — the SAME bytes re-parse identically on retry)
//     dead-letter IMMEDIATELY; everything else keeps the bounded markFailed retry/backoff curve.
//   * settleFailure has NO isLastAttempt fork: BackgroundJobsRepo.markFailed ALREADY dead-letters
//     atomically at exhaustion (CASE state→'dead' + dead_reason + finished_at in ONE fenced
//     UPDATE) — there is no review_run second row to keep in lockstep, so runOneJob's
//     terminalSettle-on-last-attempt branch collapses away.
//   * No 'cancelled' outcome / TerminalCancelError path: supersede semantics are review-specific.
//   * The idle cycle has NO ledger pruner (W6.4 is review-runner-specific); it runs ONLY the
//     stuck-job reaper.

export type BackgroundRunOutcome = "idle" | "done" | "failed" | "lease_lost" | "no_handler";

/** Sentinel the hard-runtime race resolves to when the handler overran `maxRuntimeS`. */
const HARD_TIMEOUT = Symbol("hard-timeout");

export async function runOneBackgroundJob(o: { repo: BackgroundJobsRepo; registry: HandlerRegistry;
  clock: Clock; owner: string; leaseS: number; heartbeatS: number; maxRuntimeS: number;
  /** CS1.2 SHADOW posture: true → the cycle is suppressed BEFORE the claim (see the top guard).
   *  Default false (the production behavior). */
  shadow?: boolean;
}): Promise<{ outcome: BackgroundRunOutcome; jobId?: string }> {
  if (o.shadow === true) {
    // CS1.2 SHADOW guard — do not CLAIM: a claim stamps the lease columns on core.background_jobs
    // (a production-table mutation) and the subsequent settle would CONSUME queued work the real
    // cutover must still execute. Silent per cycle (BackgroundRunnerLoop.run() logs the posture
    // once; runBackgroundRunner's boot line names the mode); the HandlerRegistry shadow wrapper +
    // HandlerDeps.shadow stay as defense-in-depth for any path that runs a handler anyway.
    return { outcome: "idle" };
  }
  const leaseMs = o.leaseS * 1000;
  const claimStart = o.clock.monotonic();
  const job = await o.repo.claim({ owner: o.owner, leaseMs, maxRuntimeMs: o.maxRuntimeS * 1000 });
  recordClaimLatencyMs((o.clock.monotonic() - claimStart) * 1000);
  if (!job) { recordBackgroundJobOutcome({ outcome: "idle" }); return { outcome: "idle" }; }
  const token = job.attempt_token!;
  if (job.attempts > 1) recordLeaseSteal();   // a reclaim minted attempts > 1 → a prior owner crashed

  /** Terminal poison-pill settle (no-handler / payload-integrity / permanent error): job→dead REGARDLESS of attempts. */
  const settlePoison = async (reason: string, outcome: BackgroundRunOutcome): Promise<BackgroundRunOutcome> => {
    const r = await o.repo.terminalSettle({ jobId: job.job_id, owner: o.owner, token, reason });
    if (!r.applied) recordStaleTokenWrite({ op: "markFailed" });   // lease was stolen → loser; bounded op label
    return r.applied ? outcome : "lease_lost";
  };

  // Dispatch seam ① — registry lookup. NO registered handler is a wiring bug, not a transient
  // fault: dead-letter NOW (terminal, never re-enqueued) + the bounded no-handler counter.
  const handler = o.registry.get(job.job_type);
  if (handler === undefined) {
    recordNoHandlerDeadLetter();
    const outcome = await settlePoison(`no handler for ${job.job_type}`, "no_handler");
    recordBackgroundJobOutcome({ outcome });
    return { outcome, jobId: job.job_id };
  }

  // Dispatch seam ② — payload integrity. A hash mismatch (corruption / out-of-band edit) must never
  // drive a handler, and retrying cannot fix stored bytes → POISON PILL, terminal dead.
  let payload: Record<string, unknown>;
  try {
    payload = o.repo.verifyPayload(job);
  } catch (e) {
    const outcome = await settlePoison(e instanceof Error ? e.message : String(e), "failed");
    recordBackgroundJobOutcome({ outcome });
    return { outcome, jobId: job.job_id };
  }

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

  /**
   * Settle a FAILURE. Unlike runOneJob there is NO isLastAttempt/terminalSettle fork:
   * {@link BackgroundJobsRepo.markFailed} already dead-letters ATOMICALLY at exhaustion (state
   * CASE → 'dead' + dead_reason + finished_at in the same fenced UPDATE) — no second row exists to
   * keep in lockstep. A stale token → 0 rows → `lease_lost`. Only a NON-terminal applied failure
   * is a retry (the job went back to 'ready').
   */
  const settleFailure = async (error: string): Promise<BackgroundRunOutcome> => {
    const r = await o.repo.markFailed({ jobId: job.job_id, owner: o.owner, token, error, baseBackoffMs: 1000 });
    if (!r.applied) recordStaleTokenWrite({ op: "markFailed" });
    else if (!r.terminal) recordRetryAttempt();   // re-enqueued 'ready' — the next claim retries it
    return r.applied ? "failed" : "lease_lost";
  };

  // shadow is structurally false here (the top guard returned before any claim), but thread the
  // RESOLVED flag rather than a literal so the HandlerDeps contract always carries the runner's
  // actual posture (CS1.2 — the registry wrapper reads it).
  const deps: HandlerDeps = { job, clock: o.clock, shadow: o.shadow ?? false };
  let outcome: BackgroundRunOutcome;
  try {
    const handlerPromise: Promise<void> = handler(payload, work.signal, deps);
    const handlerDone: Promise<undefined> = handlerPromise.then(() => undefined);
    const raced = await Promise.race([handlerDone, hardTimeout]);
    if (raced === HARD_TIMEOUT) {
      // Handler overran the ceiling (and may still be running, orphaned — it violated the honor-`signal`
      // contract). `work.signal` was already aborted by the hardTimeout helper (line above) as the
      // cooperative nudge; we additionally OBSERVE the orphaned handler so a LATE settlement (it keeps
      // running and resolves/throws AFTER this race already settled) is swallowed here and can NEVER
      // surface as an unhandled rejection — and meter it (F4). The .catch is attached BEFORE settlement
      // returns so the observer is wired no matter how the orphan eventually completes.
      recordHandlerOrphanSettled({ phase: "after_hard_timeout" });
      handlerPromise.catch(() => undefined); // observe + swallow any late orphan rejection (no unhandled)
      // Settle as failed; the fence guards against any late completion write.
      outcome = await settleFailure(`max runtime ${o.maxRuntimeS}s exceeded`);
    } else {
      const done = await o.repo.markDone({ jobId: job.job_id, owner: o.owner, token });
      if (!done.applied) recordStaleTokenWrite({ op: "markDone" });
      outcome = done.applied ? "done" : "lease_lost";
    }
  } catch (e) {
    // Dispatch seam ③ — failure classification (Phase 4a W4a.1 + CS4.4; mirrors the outbox's
    // RetryableSinkError/PermanentSinkError split). PermanentJobError is the handler-declared
    // "retry CANNOT succeed" signal; a bare ZodError means the stored payload failed its contract —
    // the SAME bytes re-parse identically on every retry. Both dead-letter IMMEDIATELY
    // (terminalSettle, dead_reason = the message) instead of burning the bounded attempts.
    // A THROTTLE fault (GitHubRateLimitExceeded / LlmRateLimitError — retry_hints.ts) is the
    // OPPOSITE pole: deferRetry re-enqueues at the Retry-After/resetAt hint WITHOUT consuming the
    // attempt, so a routine rate-limit window can never dead-letter the job (CS4.4 — H3/RC6/XH2).
    // Everything else is presumed transient → the markFailed retry/backoff curve.
    const msg = e instanceof Error ? e.message : String(e);
    const retryAt = extractRetryAtHint(e, o.clock);
    if (e instanceof PermanentJobError || e instanceof ZodError) {
      outcome = await settlePoison(msg, "failed");
    } else if (retryAt !== null) {
      const r = await o.repo.deferRetry({ jobId: job.job_id, owner: o.owner, token, error: msg, runAfter: retryAt });
      if (!r.applied) recordStaleTokenWrite({ op: "markFailed" });   // bounded op label (the failure-settle family)
      outcome = r.applied ? "failed" : "lease_lost";
    } else {
      outcome = await settleFailure(msg);
    }
  } finally { stop.abort(); await hb; await hardTimeout; }   // immediate stop (cancellableSleep wakes); helpers never mask `outcome`
  recordHandlerDurationMs((o.clock.monotonic() - handlerStart) * 1000);
  recordBackgroundJobOutcome({ outcome });
  return { outcome, jobId: job.job_id };
}

export class BackgroundRunnerLoop {
  #stopped = false;
  readonly #stop = new AbortController();                  // wakes the idle sleep immediately on stop()
  constructor(private o: { repo: BackgroundJobsRepo; registry: HandlerRegistry; clock: Clock;
    owner: string; leaseS: number; heartbeatS: number; maxRuntimeS: number; idleS: number;
    /** CS1.2 SHADOW posture, threaded into every runOneBackgroundJob cycle + the idle reaper. */
    shadow?: boolean }) {}
  stop() { this.#stopped = true; this.#stop.abort(); }     // wire to process.on('SIGTERM', () => loop.stop())

  /**
   * The idle-cycle maintenance sweep, run between job claims when the queue is empty: the
   * stuck-job reaper (expired lease + attempts exhausted → dead; the rows claim() will never
   * reclaim). Factored out so it is independently exercisable. The review runner's throttled
   * ledger prune (W6.4) is deliberately ABSENT — it is review-pipeline-specific, not platform.
   * CS1.2 SHADOW guard: reapStuckRuns is an UPDATE on core.background_jobs (a production-table
   * mutation) — suppressed in shadow (run() logs the posture once; per-cycle logging would spam
   * every idleS seconds).
   */
  async runIdleMaintenance(): Promise<void> {
    if (this.o.shadow === true) {
      return;
    }
    recordCrashLoopReaped(await this.o.repo.reapStuckRuns());
  }

  async run(): Promise<void> {
    if (this.o.shadow === true) {
      // CS1.2: announce the posture ONCE per run — every cycle below is claim-suppressed
      // (runOneBackgroundJob's top guard) and the idle reaper is a no-op (runIdleMaintenance).
      console.info(
        "background runner loop shadow-mode: job claiming + idle maintenance SUPPRESSED " +
          "(CS1.2 no-side-effects contract)",
      );
    }
    while (!this.#stopped) {
      const { outcome } = await runOneBackgroundJob(this.o); // an in-flight job ALWAYS runs to completion (drain)
      if (outcome === "idle" && !this.#stopped) {
        await this.runIdleMaintenance();                     // stuck-job reaper between claims
        await cancellableSleep(this.o.clock, this.o.idleS, this.#stop.signal); // stop() interrupts this wait
      }
    }
  }
}
