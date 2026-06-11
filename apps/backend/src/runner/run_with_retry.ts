import type { Clock } from "#platform/clock.js";
import type { Random } from "#platform/randomness.js";
import { cancellableSleep } from "./clock_async.js";
export type RetryPolicy = { startToCloseS: number; initialIntervalS: number; maxIntervalS: number; backoff: number;
  maxAttempts: number; nonRetryable: (e: unknown) => boolean };
// CONTRACT: every wrapped operation MUST honor `signal` — abort in-flight fetches (pass to fetch), kill subprocesses
// (process-group kill on abort). The Promise.race below guarantees the WRAPPER returns on timeout; honoring `signal`
// guarantees the underlying WORK actually stops (no orphaned subprocess / socket). Both are required.
//
// `outerSignal` (W1.9c — H1) is the COMPOSED caller abort (the review shell's runner-∪-mutex-loss signal): when it
// fires, (a) NO new attempt is dispatched (pre-attempt gate — the in-process gate-① posture), (b) it is FORWARDED
// into the per-attempt signal so signal-honoring work stops in flight, (c) a failed attempt short-circuits the
// remaining budget (rethrow, no backoff), and (d) the between-attempt backoff sleep wakes immediately.
export async function runWithRetry<T>(clock: Clock, random: Random, policy: RetryPolicy,
  fn: (signal: AbortSignal) => Promise<T>, outerSignal?: AbortSignal): Promise<T> {
  let interval = policy.initialIntervalS; let lastErr: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (outerSignal?.aborted) {
      // Pre-attempt abort gate: prefer the last attempt's REAL error (the abort raced an already-failing
      // operation); on a first-attempt abort surface the abort reason itself — never dispatch fn.
      throw lastErr ?? (outerSignal.reason instanceof Error
        ? outerSignal.reason
        : new Error("runWithRetry: aborted before dispatch"));
    }
    const ac = new AbortController();
    const forward = (): void => { ac.abort(outerSignal?.reason); };
    outerSignal?.addEventListener("abort", forward, { once: true });
    const timeout = clock.sleep(policy.startToCloseS).then(() => "__timeout__" as const);
    let res: T | "__timeout__";
    try { res = await Promise.race([fn(ac.signal), timeout]); }
    catch (e) {
      lastErr = e;
      if (policy.nonRetryable(e) || attempt === policy.maxAttempts || outerSignal?.aborted === true) throw e;
      await backoff(clock, random, interval, outerSignal);
      interval = Math.min(interval * policy.backoff, policy.maxIntervalS); continue;
    }
    finally { outerSignal?.removeEventListener("abort", forward); }
    if (res === "__timeout__") {
      ac.abort(new Error(`startToClose ${policy.startToCloseS}s exceeded`)); // cooperative stop of the underlying work
      lastErr = new Error(`timeout after ${policy.startToCloseS}s`);
      if (attempt === policy.maxAttempts || outerSignal?.aborted === true) throw lastErr;
      await backoff(clock, random, interval, outerSignal);
      interval = Math.min(interval * policy.backoff, policy.maxIntervalS); continue;
    }
    return res;
  }
  throw lastErr;
}

/** Jittered backoff sleep (±25% via the randomness seam — avoids herd). Abort-aware when an outer
 *  signal is present: the abort WAKES the sleep so the loop's pre-attempt gate throws promptly. */
async function backoff(clock: Clock, random: Random, intervalS: number, outerSignal?: AbortSignal): Promise<void> {
  const jittered = intervalS * random.uniform(0.75, 1.25);
  if (outerSignal === undefined) {
    await clock.sleep(jittered);
    return;
  }
  await cancellableSleep(clock, jittered, outerSignal);
}
