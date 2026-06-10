/**
 * F4 (review finding) — the hard-timeout race settles the job WHILE the orphaned handler may keep
 * running. Before the fix, `o.handler(job, work.signal).then(() => undefined)` had NO `.catch()`, so a
 * late settlement from the orphaned handler (one that ignored `work.signal` and rejected AFTER the
 * timeout race already resolved) was UNOBSERVED, and nothing metered that a handler overran its ceiling.
 *
 * This unit test drives `runOneJob` with an in-memory fake repo + a controllable clock so the
 * hard-timeout fires DETERMINISTICALLY (no wall-clock, no real timers) while the handler is still in
 * flight. The handler IGNORES `work.signal` and, AFTER the timeout settles the job, REJECTS. We assert:
 *   1. runOneJob returns outcome 'failed' (the timeout settled the job),
 *   2. the orphan-observed metric recorder (`recordHandlerOrphanSettled`) was called EXACTLY ONCE with
 *      the bounded label `phase: "after_hard_timeout"` (distinguishing "handler continued/threw AFTER
 *      hard-timeout settlement"),
 *   3. NO unhandled rejection escapes — the runner attaches a `.catch()` to the orphaned handler promise
 *      so the late rejection is swallowed (a process 'unhandledRejection' listener never fires).
 *
 * Why spy the recorder instead of an in-memory OTel exporter: `runner_metrics` caches its OTel
 * instruments at MODULE-import time, which (in this per-file test) happens BEFORE any MeterProvider is
 * registered — a counter cached against the no-op meter does NOT route to a later-registered provider
 * (verified). Spying the exported recorder asserts the runner's emit CONTRACT directly and
 * deterministically, the same observable surface a dashboard reads.
 *
 * test/ is OUT of the clock/random gate's scope, so the controllable clock + manual promise plumbing
 * here are sanctioned (the gate allowlists only THIS test tree's exemption, not src/).
 */
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as runnerMetrics from "#backend/runner/runner_metrics.js";
import { runOneJob } from "#backend/runner/review_job_runner.js";
import type { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import type { Clock } from "#platform/clock.js";
import type { ReviewJobV1 } from "#contracts/review_jobs.v1.js";

/**
 * A clock whose `sleep(seconds)` returns a promise we resolve ON DEMAND, keyed by the requested
 * duration. This lets the test fire the hard-timeout's `sleep(maxRuntimeS)` deterministically while the
 * handler is still pending — no wall-clock, no real `setTimeout`. `monotonic()` advances on `fireSleep`.
 */
class ControllableClock implements Clock {
  private monotonicSeconds = 0;
  private readonly pending = new Map<number, Array<() => void>>();

  public now(): Date {
    return new Date("2026-01-01T00:00:00.000Z");
  }
  public monotonic(): number {
    return this.monotonicSeconds;
  }
  public sleep(seconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const list = this.pending.get(seconds) ?? [];
      list.push(resolve);
      this.pending.set(seconds, list);
    });
  }
  /** Resolve every pending sleep of exactly `seconds` (advancing the monotonic axis by `seconds`). */
  public fireSleep(seconds: number): void {
    this.monotonicSeconds += seconds;
    const list = this.pending.get(seconds) ?? [];
    this.pending.delete(seconds);
    for (const resolve of list) resolve();
  }
}

/** Minimal in-memory ReviewJobsRepo double — only the methods runOneJob calls on the timeout path. */
function fakeRepo(): ReviewJobsRepo {
  const claimed: ReviewJobV1 = {
    job_id: randomUUID(),
    run_id: randomUUID(),
    review_id: randomUUID(),
    installation_id: randomUUID(),
    state: "leased",
    priority: 0,
    attempts: 3, // == max_attempts ⇒ isLastAttempt ⇒ terminalSettle path on the timeout failure
    max_attempts: 3,
    attempt_token: randomUUID(),
  };
  let claims = 0;
  return {
    claim: async () => (claims++ === 0 ? claimed : null),
    heartbeat: async () => true, // lease held the whole time; only the hard timeout settles the job
    markDone: async () => ({ applied: true }),
    markFailed: async () => ({ applied: true, terminal: true }),
    terminalSettle: async () => ({ applied: true }),
  } as unknown as ReviewJobsRepo;
}

// Capture any unhandled rejection that escapes during a test — the F4 defect would manifest here.
let unhandled: Array<unknown> = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
});

describe("runOneJob — orphaned handler that overruns the hard timeout (F4)", () => {
  it("settles 'failed', meters the orphan exactly once, and never leaks an unhandled rejection", async () => {
    const orphanSpy = vi.spyOn(runnerMetrics, "recordHandlerOrphanSettled");
    const clock = new ControllableClock();
    const repo = fakeRepo();

    // The handler IGNORES work.signal and rejects ONLY when we tell it to — AFTER the timeout settles.
    let rejectHandler: (e: unknown) => void = () => {};
    const handlerRejection = new Promise<void>((_resolve, reject) => {
      rejectHandler = reject;
    });
    const handler = async (): Promise<void> => {
      await handlerRejection; // never honors the abort signal; rejects only on our command
    };

    const runPromise = runOneJob({
      repo,
      clock,
      owner: "w1",
      leaseS: 2,
      heartbeatS: 0.2,
      maxRuntimeS: 1, // short ceiling so the hard timeout is the race winner
      handler,
    });

    // Let the runner reach its awaits (claim → race), then FIRE the hard-timeout sleep so HARD_TIMEOUT
    // wins the race while the handler is still pending.
    await Promise.resolve();
    await Promise.resolve();
    clock.fireSleep(1); // resolves cancellableSleep(maxRuntimeS=1) → hardTimeout returns HARD_TIMEOUT

    const result = await runPromise; // job settles 'failed' via terminalSettle (last attempt)
    expect(result.outcome).toBe("failed");

    // The orphan was metered EXACTLY once, with the bounded label distinguishing the post-timeout overrun.
    expect(orphanSpy).toHaveBeenCalledTimes(1);
    expect(orphanSpy).toHaveBeenCalledWith({ phase: "after_hard_timeout" });

    // NOW the orphaned handler — which the runner already abandoned — rejects late. The runner's `.catch`
    // must swallow it so it never escapes as an unhandled rejection.
    rejectHandler(new Error("orphaned handler exploded AFTER the hard-timeout settlement"));

    // Give the late rejection enough macrotask turns to surface as an unhandledRejection if it were NOT
    // observed (Node fires the event a few ticks after a handler-less promise rejects; ~80ms is ample).
    await new Promise((r) => setTimeout(r, 80));

    expect(unhandled).toEqual([]); // F4: NO unhandled rejection escapes — the orphan promise is observed
  });
});
