/**
 * Cost-journal reconcile window — de-Temporal Phase 0 checklist #3.
 *
 * An orphaned reservation is a `reserve` row whose call never settled (the process died / the
 * attempt was hard-aborted between the cost-cap reservation and the post-call accounting). The
 * reconciler may only declare a reserve orphaned once NO legitimate settle can still arrive — and
 * the latest a settle can legitimately land is bounded by the runner's retry ENVELOPE for the paid
 * call, not by a single attempt: `runOneJob`'s hard ceiling frees the worker slot on timeout but
 * the abandoned handler promise keeps running (v4 #3), so its late `recordCallCost` can land any
 * time before the whole `runWithRetry` envelope closes.
 *
 * The window is therefore DERIVED from `RETRY_POLICIES.reviewChunk` (the paid call's policy — the
 * spec's "≈6 min for reviewChunk") via {@link worstCaseWallTimeSeconds}, not hard-coded: a future
 * policy edit moves the window automatically, and the strict `"Ns"` duration parser fails LOUD if
 * the policy format ever changes shape (a silently-zeroed window would release still-live reserves
 * — a cap-headroom corruption, the one failure mode this module must never have).
 *
 * Envelope math (mirrors `run_with_retry.ts` exactly):
 *   worst case = maxAttempts × startToClose  +  Σ_{i=1..maxAttempts−1} min(initial × backoff^(i−1),
 *                maxInterval) × {@link RETRY_ENVELOPE_JITTER_MAX}
 * For reviewChunk (90s × 4; 5s initial, 60s cap, 2.0 backoff): 360 + 1.25×(5+10+20) = 403.75s.
 * The shipped {@link RECONCILE_WINDOW_SECONDS} applies a ×2 safety factor (writer-vs-reconciler
 * clock skew, the client's lock-timeout-retry tail, scheduling latency of the late settle itself):
 * ceil(2 × 403.75) = 808s ≈ 13.5 min.
 *
 * (The spec's alternative gate — the Phase-2 in-flight-ledger lease expiry — is itself specced as
 * "lease TTL > worst-case + heartbeat", i.e. derived from the SAME policy constant; deriving here
 * directly is the non-circular choice.)
 */

import { type RetryActivityOptions, RETRY_POLICIES } from "#backend/review/pipeline/activity_ports.js";

/**
 * The upper bound of `run_with_retry.ts`'s sleep jitter — `random.uniform(0.75, 1.25)`. A worst
 * case must take the slowest draw on every sleep.
 */
export const RETRY_ENVELOPE_JITTER_MAX = 1.25;

/**
 * Parse a RETRY_POLICIES duration. STRICT: only the `"Ns"` seconds shape the transcribed policies
 * use is accepted — anything else (minutes, garbage, a missing unit) throws, because silently
 * mis-parsing a duration would silently shrink the reconcile window (see the module header).
 */
function parseSecondsStrict(duration: string): number {
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored; the optional `(?:\.\d+)?` tail consumes a literal `.` + ≥1 digit so no overlap with the preceding `\d+`, no nested/ambiguous quantifiers, no catastrophic backtracking (heuristic false positive)
  const m = /^(\d+(?:\.\d+)?)s$/.exec(duration);
  if (m === null) {
    throw new Error(
      `cost_journal_reconciler: cannot parse RETRY_POLICIES duration ${JSON.stringify(duration)} ` +
        `— only the "Ns" seconds shape is supported (a format change must be handled here EXPLICITLY)`,
    );
  }
  return Number(m[1]);
}

/**
 * The worst-case WALL time of one `runWithRetry` envelope for `policy`: every attempt burns its
 * full `startToCloseTimeout`, every inter-attempt sleep draws the maximum jitter, and the backoff
 * curve is capped at `maximumInterval` (uncapped when absent). `backoffCoefficient` defaults to 2.0
 * (the Temporal default the transcribed policies inherit when they omit it).
 */
export function worstCaseWallTimeSeconds(policy: RetryActivityOptions): number {
  if (policy.startToCloseTimeout === undefined) {
    throw new Error(
      "cost_journal_reconciler: policy carries no startToCloseTimeout — no envelope to derive from",
    );
  }
  const startToCloseS = parseSecondsStrict(policy.startToCloseTimeout);
  const attempts = policy.retry?.maximumAttempts ?? 1;
  if (attempts < 1) {
    throw new Error(`cost_journal_reconciler: maximumAttempts must be >= 1 (got ${attempts})`);
  }
  if (attempts === 1) {
    return startToCloseS;
  }
  const initial = policy.retry?.initialInterval;
  if (initial === undefined) {
    throw new Error(
      "cost_journal_reconciler: a multi-attempt policy carries no retry.initialInterval",
    );
  }
  const initialS = parseSecondsStrict(initial);
  const maxIntervalS =
    policy.retry?.maximumInterval !== undefined
      ? parseSecondsStrict(policy.retry.maximumInterval)
      : Number.POSITIVE_INFINITY;
  const backoff = policy.retry?.backoffCoefficient ?? 2.0;

  let sleepS = 0;
  let interval = initialS;
  for (let gap = 1; gap < attempts; gap++) {
    sleepS += Math.min(interval, maxIntervalS);
    interval = interval * backoff;
  }
  return attempts * startToCloseS + sleepS * RETRY_ENVELOPE_JITTER_MAX;
}

/**
 * The shipped reconcile window: a reserve with no settle older than this is an orphan the
 * reconciler may heal. ×2 safety factor over the reviewChunk worst-case envelope (module header).
 */
export const RECONCILE_WINDOW_SECONDS: number = Math.ceil(
  2 * worstCaseWallTimeSeconds(RETRY_POLICIES.reviewChunk),
);
