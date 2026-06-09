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
