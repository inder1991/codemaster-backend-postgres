// W1.9c (H1) — the per-port IN-PLACE retry seam for the in-process review shell.
//
// Under Temporal every activity carried its own retry curve (RETRY_POLICIES — the EXACT transcribed
// Python ActivityOptions, review/pipeline/activity_ports.ts); the de-Temporal port wired the ports
// through a bare abort gate, so ANY transient blip (a Bedrock 429/5xx on chunk 18/20, a pgvector
// timeout, a flaky embed call) threw straight to the job-level markFailed and re-ran the WHOLE
// shell — re-clone, re-classify, re-chunk, re-embed, re-LLM every chunk (H1: `runWithRetry` had
// zero production callers). This module restores the per-activity curve for the RETRYABLE,
// IDEMPOTENT ports only:
//
//   * clone             — the GitHub fetch; idempotent (cloneRepoIntoWorkspace wipes a stale target
//                         before re-cloning) and signal-honoring (the cloner kills the subprocess on
//                         abort — the per-attempt signal is threaded INTO it, so a timed-out attempt
//                         can never leave a live git process racing the retry).
//   * embedQuery        — read-only embed call.
//   * retrieveKnowledge — read-only ANN/BM25 retrieval (+ ledgered rerank).
//   * reviewChunk       — paid LLM call, idempotent via the strict ADR-0068 invocation ledger.
//   * staticAnalysis    — workspace-local linters + the ledgered curator path (H1's "curator path").
//
// NEVER wrapped: the non-idempotent post-side writes (postReview has its own claim/takeover
// idempotency machinery — E7/W3.2; postCheckRun / updatePrDescriptionSummary / generateFixPrompt
// are GitHub mutations), the fail-open maxAttempts=1 stages (loadRepoConfig / computePolicyRules),
// and the local DB/pure stages whose job-level re-run is cheap.
//
// ## Layering vs the CS4.4 throttle-defer seam (retry_hints.ts) — EXPLICIT
//
//   in-place retry (THIS seam)  <  throttle-defer (runner deferRetry)  <  markFailed backoff curve
//
// A throttle fault (THROTTLE_ERROR_NAMES: GitHubRateLimitExceeded / LlmRateLimitError) is
// NON-RETRYABLE HERE BY DESIGN: it must ESCAPE to the runner's settle classify, which routes it to
// deferRetry — re-enqueue at the Retry-After/resetAt hint WITHOUT consuming a job attempt. Burning
// it inside runWithRetry would hammer a still-throttled upstream (deepening a GitHub secondary
// window) and hide the reset hint from the seam built to honor it. TerminalCancelError (the abort
// gate's fault) is equally terminal here — never re-dispatch after the composed abort.
//
// ## AbortSignal contract
//
// `applyInProcessRetry` threads the COMPOSED shell signal as runWithRetry's outer signal: no NEW
// attempt after abort, the abort forwarded into every per-attempt signal (which ALSO fires on the
// per-attempt start-to-close timeout), and the backoff sleep wakes on abort. Non-wrapped ports
// receive the composed signal itself — their behavior is byte-identical to the pre-W1.9c wiring.

import type { ReviewActivityPorts } from "#backend/review/pipeline/activity_ports.js";
import { RETRY_POLICIES, type RetryActivityOptions } from "#backend/review/pipeline/activity_ports.js";

import type { Clock } from "#platform/clock.js";
import type { Random } from "#platform/randomness.js";

import { THROTTLE_ERROR_NAMES } from "./retry_hints.js";
import { runWithRetry, type RetryPolicy } from "./run_with_retry.js";

/**
 * Parse a Temporal SDK duration string ("2s", "200ms", "15 seconds", "2 minutes") into SECONDS.
 * Fail-loud on anything else — a silently-defaulted curve is exactly the drift this seam exists
 * to prevent (the RETRY_POLICIES comments transcribe the frozen Python byte-for-byte).
 */
export function parseTemporalDuration(d: string): number {
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored; `(?:\.\d+)?` is a single optional group whose `\.` separator removes any overlap with the preceding `\d+`, and the unit alternation carries no quantifier — no catastrophic backtracking (heuristic false positive)
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|second|seconds|m|min|minute|minutes|h|hour|hours)$/.exec(d.trim());
  if (m === null) {
    throw new Error(`unparseable Temporal duration '${d}' — expected e.g. "2s", "200ms", "15 seconds", "2 minutes"`);
  }
  const value = Number(m[1]);
  switch (m[2]) {
    case "ms": return value / 1000;
    case "s": case "second": case "seconds": return value;
    case "m": case "min": case "minute": case "minutes": return value * 60;
    default: return value * 3600; // h / hour / hours — the only remaining alternatives
  }
}

/** The Temporal SDK retry defaults applied where a RETRY_POLICIES entry omits the field
 *  (initialInterval 1s, backoffCoefficient 2.0, maximumInterval 100×initialInterval). */
const SDK_DEFAULT_INITIAL_INTERVAL_S = 1;
const SDK_DEFAULT_BACKOFF_COEFFICIENT = 2.0;
const SDK_DEFAULT_MAX_INTERVAL_FACTOR = 100;

/**
 * Translate one {@link RetryActivityOptions} entry (the Temporal proxy shape) into runWithRetry's
 * {@link RetryPolicy}. `startToCloseTimeout` and `retry.maximumAttempts` are REQUIRED — the wrap
 * set carries only explicitly-budgeted curves; a missing budget is a wiring bug, not a default.
 *
 * The `nonRetryable` classifier matches by error NAME (the CS4.3 posture — survives
 * instanceof-breaking copies across module boundaries) and layers, in order:
 *   1. the entry's declared `nonRetryableErrorTypes` (deterministic activity faults),
 *   2. {@link THROTTLE_ERROR_NAMES} — escape to the runner's deferRetry (CS4.4; module doc),
 *   3. `TerminalCancelError` — the abort-gate fault; never re-dispatch after the composed abort.
 */
export function toRetryPolicy(name: string, options: RetryActivityOptions): RetryPolicy {
  if (options.startToCloseTimeout === undefined) {
    throw new Error(`retry policy '${name}' has no startToCloseTimeout — the in-place wrap requires an explicit per-attempt ceiling`);
  }
  const maxAttempts = options.retry?.maximumAttempts;
  if (maxAttempts === undefined) {
    throw new Error(`retry policy '${name}' has no retry.maximumAttempts — the in-place wrap requires an explicit budget`);
  }
  const initialIntervalS = options.retry?.initialInterval !== undefined
    ? parseTemporalDuration(options.retry.initialInterval)
    : SDK_DEFAULT_INITIAL_INTERVAL_S;
  const maxIntervalS = options.retry?.maximumInterval !== undefined
    ? parseTemporalDuration(options.retry.maximumInterval)
    : initialIntervalS * SDK_DEFAULT_MAX_INTERVAL_FACTOR;
  const declared = new Set(options.retry?.nonRetryableErrorTypes ?? []);
  // Wave-1 adversarial-review fix: RETRY_POLICIES transcribes the PYTHON ApplicationError type
  // names; the REAL TS classes differ. Carry both vocabularies so deterministic faults fail fast
  // instead of burning the curve (pinned with the real classes in retry_policies.test.ts).
  if (declared.has("BedrockOutputUnsafeError")) {
    declared.add("LlmOutputUnsafeError");
  }
  if (declared.has("BedrockBudgetExceededError")) {
    declared.add("BedrockBudgetExceededError"); // TS class keeps this name (enforcer.ts) — listed for symmetry
  }
  return {
    startToCloseS: parseTemporalDuration(options.startToCloseTimeout),
    initialIntervalS,
    maxIntervalS,
    backoff: options.retry?.backoffCoefficient ?? SDK_DEFAULT_BACKOFF_COEFFICIENT,
    maxAttempts,
    nonRetryable: (e: unknown): boolean =>
      e instanceof Error &&
      (declared.has(e.name) || THROTTLE_ERROR_NAMES.has(e.name) || e.name === "TerminalCancelError"),
  };
}

/**
 * The W1.9c wrap set: port name → its UNTRANSLATED {@link RETRY_POLICIES} entry (by reference, so
 * the transcribed Temporal curves stay the single source of truth). Exactly H1's retryable
 * idempotent ports — see the module doc for why each is safe and what is deliberately excluded.
 */
export const IN_PROCESS_RETRY_POLICIES: Readonly<Partial<Record<keyof ReviewActivityPorts, RetryActivityOptions>>> = {
  clone: RETRY_POLICIES.clone,
  embedQuery: RETRY_POLICIES.embedQuery,
  retrieveKnowledge: RETRY_POLICIES.retrieveKnowledge,
  reviewChunk: RETRY_POLICIES.reviewChunk,
  staticAnalysis: RETRY_POLICIES.staticAnalysis,
};

// Map view for runtime lookups (a Map can never resolve through Object.prototype).
const POLICY_BY_PORT: ReadonlyMap<string, RetryActivityOptions> = new Map(
  Object.entries(IN_PROCESS_RETRY_POLICIES) as Array<[string, RetryActivityOptions]>,
);

/** The seams the retry wrap runs on: the injected Clock/Random Protocol pair + the COMPOSED shell
 *  abort signal (runner ∪ mutex-renew-loss — the same signal the abort gate reads). */
export type PortRetrySeams = {
  readonly clock: Clock;
  readonly random: Random;
  readonly signal: AbortSignal;
};

/**
 * Wrap a REAL port fn in its {@link IN_PROCESS_RETRY_POLICIES} curve — or return it as-is (bound
 * to the composed signal) when the port is not in the wrap set. `real` receives the ATTEMPT signal
 * as its 2nd arg: for wrapped ports that is runWithRetry's per-attempt controller (fires on the
 * start-to-close timeout AND on the forwarded composed abort — the cloner threads it into the git
 * subprocess); for pass-through ports it is the composed signal itself (pre-W1.9c behavior).
 *
 * Deliberately applied ONLY to the real wiring, never to test `overrides` — an override replaces
 * the port INCLUDING its retry curve (in_process_ports.ts::pick), so failure-path tests keep their
 * single-dispatch semantics.
 */
export function applyInProcessRetry<I, O>(
  name: keyof ReviewActivityPorts,
  real: (input: I, attemptSignal: AbortSignal) => Promise<O>,
  seams: PortRetrySeams,
): (input: I) => Promise<O> {
  const options = POLICY_BY_PORT.get(name);
  if (options === undefined) {
    return async (input: I): Promise<O> => real(input, seams.signal);
  }
  const policy = toRetryPolicy(name, options);
  return async (input: I): Promise<O> =>
    runWithRetry(
      seams.clock,
      seams.random,
      policy,
      (attemptSignal) => real(input, attemptSignal),
      seams.signal,
    );
}
