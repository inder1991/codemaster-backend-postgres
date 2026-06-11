import { describe, expect, it } from "vitest";
import { WallClock } from "#platform/clock.js";
import { SystemRandom } from "#platform/randomness.js";
import { runWithRetry, type RetryPolicy } from "#backend/runner/run_with_retry.js";
const clock = new WallClock(); const random = new SystemRandom();
const P: RetryPolicy = { startToCloseS: 0.05, initialIntervalS: 0.001, maxIntervalS: 0.005, backoff: 2, maxAttempts: 3,
  nonRetryable: (e) => (e as Error).name === "Terminal" };
describe("runWithRetry", () => {
  it("retries transient then succeeds", async () => {
    let n = 0; expect(await runWithRetry(clock, random, P, async () => { if (++n < 3) throw new Error("t"); return "ok"; })).toBe("ok"); expect(n).toBe(3);
  });
  it("does not retry non-retryable", async () => {
    let n = 0; const err = Object.assign(new Error("x"), { name: "Terminal" });
    await expect(runWithRetry(clock, random, P, async () => { n++; throw err; })).rejects.toThrow("x"); expect(n).toBe(1);
  });
  it("HARD-times-out an attempt that ignores the abort signal", async () => {
    // fn never resolves and ignores signal → the timeout must still reject the attempt:
    await expect(runWithRetry(clock, random, { ...P, maxAttempts: 1 }, () => new Promise(() => {}))).rejects.toThrow(/timeout/i);
  });
});

// W1.9c (H1) — the COMPOSED shell abort must flow into runWithRetry's signal contract: no NEW
// attempt is dispatched after the outer abort (the in-process gate-① posture), the abort is
// FORWARDED into every per-attempt signal (so signal-honoring work like the cloner stops), and an
// abort observed on a failed attempt short-circuits the remaining retry budget.
describe("runWithRetry — outer abort signal (W1.9c)", () => {
  it("does NOT dispatch when the outer signal is already aborted (zero fn calls)", async () => {
    const ac = new AbortController();
    ac.abort(new Error("composed shell abort"));
    let n = 0;
    await expect(
      runWithRetry(clock, random, P, async () => { n++; return "never"; }, ac.signal),
    ).rejects.toThrow(/composed shell abort/);
    expect(n).toBe(0);
  });

  it("an abort observed on a FAILED attempt stops retrying and rethrows that attempt's error", async () => {
    const ac = new AbortController();
    let n = 0;
    const transient = new Error("transient-during-abort");
    await expect(
      runWithRetry(clock, random, { ...P, initialIntervalS: 60 }, async () => {
        n++; ac.abort(new Error("shell abort")); throw transient;
      }, ac.signal),
    ).rejects.toThrow("transient-during-abort");
    expect(n).toBe(1); // the 60s backoff was never entered; no second attempt fired
  });

  it("an abort DURING the between-attempt backoff wakes the sleep and stops the loop", async () => {
    const ac = new AbortController();
    let n = 0;
    const started = Date.now();
    setTimeout(() => ac.abort(new Error("late shell abort")), 20);
    await expect(
      runWithRetry(clock, random, { ...P, initialIntervalS: 60, maxIntervalS: 60 }, async () => {
        n++; throw new Error("transient-pre-backoff");
      }, ac.signal),
    ).rejects.toThrow("transient-pre-backoff");
    expect(n).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000); // far below the 60s backoff — the abort woke it
  });

  it("forwards the outer abort into the per-attempt signal (in-flight work observes it)", async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const pending = runWithRetry(clock, random, { ...P, startToCloseS: 30, maxAttempts: 1 }, (signal) => {
      seen = signal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }, ac.signal);
    // Let the attempt start, then fire the composed abort — the per-attempt signal must observe it.
    await new Promise((r) => setTimeout(r, 10));
    expect(seen?.aborted).toBe(false);
    ac.abort(new Error("composed mid-attempt abort"));
    await expect(pending).rejects.toThrow(/composed mid-attempt abort/);
    expect(seen?.aborted).toBe(true);
  });
});
