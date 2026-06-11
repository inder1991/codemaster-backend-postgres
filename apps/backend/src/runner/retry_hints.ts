// CS4.4 (H3/RC6/XH2 — minimal cutover slice): rate-limit Retry-After/resetAt hints → run_after.
//
// The GitHub client computes rich reset hints (GitHubRateLimitExceeded carries resetAt +
// retryAfterSeconds — api_client.ts) and the Bedrock adapter maps throttling to LlmRateLimitError
// (with the provider's retry-after header when one was sent). Without this seam both fall through
// the generic markFailed exponential-backoff curve and a routine throttle window dead-letters the
// job in seconds while the limit is still in force — retrying INTO a GitHub secondary window
// deepens the penalty for the whole installation. extractRetryAtHint is the classify step both
// runners (background_runner.ts / review_job_runner.ts) run BEFORE the transient settleFailure
// path: a recognized throttle fault yields the instant the work may resume, and the runner routes
// it to the repo's deferRetry (re-enqueue at the hint WITHOUT consuming an attempt) instead.
//
// Matching is by error NAME (the CS4.3 posture): it keeps the GitHub/LLM adapter graphs off the
// runner's static imports, and survives any instanceof-breaking copy across module boundaries.
// Fields are duck-typed with full narrowing — a malformed hint degrades to the 60s default, never
// throws out of the settle seam.

import type { Clock } from "#platform/clock.js";

/** Error names recognized as throttle faults (the GitHub + Bedrock rate-limit classes). */
const THROTTLE_ERROR_NAMES = new Set(["GitHubRateLimitExceeded", "LlmRateLimitError"]);

/** Wait applied when a throttle fault carries NO usable hint (GitHub secondary Retry-After is
 *  commonly 60s+; Bedrock throttling is transient at the same order). */
export const DEFAULT_THROTTLE_DEFER_SECONDS = 60;

/** Hard cap on any hint-derived wait: a GitHub PRIMARY reset is at most ~1h away, so anything
 *  beyond is a poisoned/clock-skewed hint — never park a job for hours on bad data. */
export const MAX_THROTTLE_DEFER_SECONDS = 3600;

/**
 * Classify `e` as a throttle fault and extract WHEN to retry: `retryAfterSeconds` when present
 * (the explicit server directive — it overrides a farther-out resetAt), else `resetAt`, else the
 * 60s default; capped at 1h and floored at "now". Returns null for everything that is NOT a
 * recognized throttle fault — the caller falls through to its normal failure classification.
 */
export function extractRetryAtHint(e: unknown, clock: Clock): Date | null {
  if (!(e instanceof Error) || !THROTTLE_ERROR_NAMES.has(e.name)) {
    return null;
  }
  const nowMs = clock.now().getTime();
  const { retryAfterSeconds, resetAt } = e as { retryAfterSeconds?: unknown; resetAt?: unknown };

  let waitSeconds: number;
  if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    waitSeconds = retryAfterSeconds;
  } else if (resetAt instanceof Date && Number.isFinite(resetAt.getTime())) {
    waitSeconds = (resetAt.getTime() - nowMs) / 1000;
  } else {
    waitSeconds = DEFAULT_THROTTLE_DEFER_SECONDS;
  }
  // A NON-POSITIVE derived wait means "no usable hint", NOT "retry now": the GitHub client stamps
  // resetAt = clock.now() on a header-less secondary limit (api_client.ts — Retry-After is often
  // absent there), and deferRetry un-burns the attempt while both runner loops sleep only on
  // 'idle' — so flooring at zero would produce an UNBOUNDED zero-backoff claim→call→defer hot
  // loop against a still-throttled GitHub, deepening the very penalty this seam exists to avoid.
  if (waitSeconds <= 0) {
    waitSeconds = DEFAULT_THROTTLE_DEFER_SECONDS;
  }
  return new Date(nowMs + Math.min(waitSeconds, MAX_THROTTLE_DEFER_SECONDS) * 1000);
}
