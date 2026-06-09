import type { Clock } from "#platform/clock.js";
import type { Random } from "#platform/randomness.js";
export type RetryPolicy = { startToCloseS: number; initialIntervalS: number; maxIntervalS: number; backoff: number;
  maxAttempts: number; nonRetryable: (e: unknown) => boolean };
// CONTRACT: every wrapped operation MUST honor `signal` — abort in-flight fetches (pass to fetch), kill subprocesses
// (process-group kill on abort). The Promise.race below guarantees the WRAPPER returns on timeout; honoring `signal`
// guarantees the underlying WORK actually stops (no orphaned subprocess / socket). Both are required.
export async function runWithRetry<T>(clock: Clock, random: Random, policy: RetryPolicy,
  fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let interval = policy.initialIntervalS; let lastErr: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const ac = new AbortController();
    const timeout = clock.sleep(policy.startToCloseS).then(() => "__timeout__" as const);
    let res: T | "__timeout__";
    try { res = await Promise.race([fn(ac.signal), timeout]); }
    catch (e) {
      lastErr = e;
      if (policy.nonRetryable(e) || attempt === policy.maxAttempts) throw e;
      await clock.sleep(interval * random.uniform(0.75, 1.25)); // jitter via the randomness seam (avoids herd)
      interval = Math.min(interval * policy.backoff, policy.maxIntervalS); continue;
    }
    if (res === "__timeout__") {
      ac.abort(new Error(`startToClose ${policy.startToCloseS}s exceeded`)); // cooperative stop of the underlying work
      lastErr = new Error(`timeout after ${policy.startToCloseS}s`);
      if (attempt === policy.maxAttempts) throw lastErr;
      await clock.sleep(interval * random.uniform(0.75, 1.25));
      interval = Math.min(interval * policy.backoff, policy.maxIntervalS); continue;
    }
    return res;
  }
  throw lastErr;
}
