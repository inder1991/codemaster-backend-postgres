// W1.9c (H1) — the per-port retry seam: RETRY_POLICIES (the transcribed Temporal ActivityOptions,
// activity_ports.ts) translated into runWithRetry's RetryPolicy and applied to the IDEMPOTENT
// in-process ports. Layering contract (CS4.4 — retry_hints.ts):
//
//   in-place retry (THIS seam, transient blips)  <  throttle-defer (job-level deferRetry, attempt-
//   free, parks at Retry-After/resetAt)  <  markFailed backoff (job-level bounded retry curve)
//
// A GitHubRateLimitExceeded / LlmRateLimitError must therefore ESCAPE this seam un-retried (the
// runner's settle classify routes it to deferRetry) — burning it here would hammer a throttled
// upstream AND consume the in-place budget the hint machinery exists to protect.

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { SeededRandom } from "#platform/randomness.js";
import { RETRY_POLICIES } from "#backend/review/pipeline/activity_ports.js";
import {
  IN_PROCESS_RETRY_POLICIES,
  applyInProcessRetry,
  parseTemporalDuration,
  toRetryPolicy,
  type PortRetrySeams,
} from "#backend/runner/retry_policies.js";

function named(name: string, msg = name): Error {
  return Object.assign(new Error(msg), { name });
}

function seams(signal?: AbortSignal): PortRetrySeams {
  return {
    clock: new FakeClock(),
    random: new SeededRandom({ seed: 42 }),
    signal: signal ?? new AbortController().signal,
  };
}

describe("parseTemporalDuration — the Temporal SDK duration strings RETRY_POLICIES carries", () => {
  it("parses the s / ms / seconds / minutes shapes into seconds", () => {
    expect(parseTemporalDuration("2s")).toBe(2);
    expect(parseTemporalDuration("90s")).toBe(90);
    expect(parseTemporalDuration("200ms")).toBe(0.2);
    expect(parseTemporalDuration("1 second")).toBe(1);
    expect(parseTemporalDuration("15 seconds")).toBe(15);
    expect(parseTemporalDuration("2 minutes")).toBe(120);
  });

  it("fails LOUD on a malformed duration (never a silent default)", () => {
    for (const bad of ["", "abc", "5 fortnights", "s5", "-2s"]) {
      expect(() => parseTemporalDuration(bad), bad).toThrow();
    }
  });
});

describe("toRetryPolicy — RETRY_POLICIES entry → runWithRetry RetryPolicy", () => {
  it("translates the full reviewChunk curve (90s / 5s→60s ×2.0 / 4 attempts)", () => {
    const p = toRetryPolicy("reviewChunk", RETRY_POLICIES.reviewChunk);
    expect(p.startToCloseS).toBe(90);
    expect(p.initialIntervalS).toBe(5);
    expect(p.maxIntervalS).toBe(60);
    expect(p.backoff).toBe(2);
    expect(p.maxAttempts).toBe(4);
  });

  it("applies the Temporal SDK defaults where the entry omits fields (clone: backoff 2.0, maxInterval 100×initial)", () => {
    const p = toRetryPolicy("clone", RETRY_POLICIES.clone);
    expect(p.startToCloseS).toBe(60);
    expect(p.initialIntervalS).toBe(2);
    expect(p.backoff).toBe(2);
    expect(p.maxIntervalS).toBe(200); // 100 × initialInterval — the SDK default
    expect(p.maxAttempts).toBe(3);
  });

  it("fails LOUD on an entry without an explicit attempt budget or start-to-close", () => {
    expect(() => toRetryPolicy("x", { startToCloseTimeout: "30s", retry: { initialInterval: "2s" } })).toThrow(/maximumAttempts/);
    expect(() => toRetryPolicy("x", { retry: { maximumAttempts: 3 } })).toThrow(/startToCloseTimeout/);
  });

  it("nonRetryable: the entry's declared error NAMES are terminal at this seam", () => {
    const p = toRetryPolicy("reviewChunk", RETRY_POLICIES.reviewChunk);
    expect(p.nonRetryable(named("BedrockBudgetExceededError"))).toBe(true);
    expect(p.nonRetryable(named("BedrockOutputUnsafeError"))).toBe(true);
    expect(p.nonRetryable(named("BedrockInvalidRequestError"))).toBe(true);
    expect(p.nonRetryable(named("LlmServerError"))).toBe(false); // transient — retried in place
    expect(p.nonRetryable(named("LlmTimeoutError"))).toBe(false);
    expect(p.nonRetryable("not-an-error")).toBe(false);
  });

  it("nonRetryable: THROTTLE faults ESCAPE un-retried (CS4.4 layering — they belong to deferRetry)", () => {
    const p = toRetryPolicy("embedQuery", RETRY_POLICIES.embedQuery);
    expect(p.nonRetryable(named("GitHubRateLimitExceeded"))).toBe(true);
    expect(p.nonRetryable(named("LlmRateLimitError"))).toBe(true);
  });

  it("nonRetryable: TerminalCancelError (the abort-gate fault) is never retried", () => {
    const p = toRetryPolicy("retrieveKnowledge", RETRY_POLICIES.retrieveKnowledge);
    expect(p.nonRetryable(named("TerminalCancelError", "aborted"))).toBe(true);
  });
});

describe("IN_PROCESS_RETRY_POLICIES — the W1.9c wrap set (H1's idempotent ports, BY REFERENCE)", () => {
  it("carries EXACTLY the five idempotent ports, each the untranslated RETRY_POLICIES entry", () => {
    expect(Object.keys(IN_PROCESS_RETRY_POLICIES).sort()).toEqual([
      "clone", "embedQuery", "retrieveKnowledge", "reviewChunk", "staticAnalysis",
    ]);
    expect(IN_PROCESS_RETRY_POLICIES.clone).toBe(RETRY_POLICIES.clone);
    expect(IN_PROCESS_RETRY_POLICIES.embedQuery).toBe(RETRY_POLICIES.embedQuery);
    expect(IN_PROCESS_RETRY_POLICIES.retrieveKnowledge).toBe(RETRY_POLICIES.retrieveKnowledge);
    expect(IN_PROCESS_RETRY_POLICIES.reviewChunk).toBe(RETRY_POLICIES.reviewChunk);
    expect(IN_PROCESS_RETRY_POLICIES.staticAnalysis).toBe(RETRY_POLICIES.staticAnalysis);
  });
});

describe("applyInProcessRetry — behavior of the wrapped/unwrapped port fns", () => {
  it("retries a wrapped port's transient fault in place and returns the eventual success", async () => {
    let n = 0;
    const port = applyInProcessRetry("embedQuery", async () => {
      n++;
      if (n < 3) throw named("LlmTimeoutError");
      return "embedded";
    }, seams());
    await expect(port({ q: 1 })).resolves.toBe("embedded");
    expect(n).toBe(3); // two transient blips absorbed IN PLACE — the job never re-ran the shell
  });

  it("exhausts the Temporal budget then rethrows (embedQuery: 3 attempts)", async () => {
    let n = 0;
    const port = applyInProcessRetry("embedQuery", async () => {
      n++; throw named("LlmServerError");
    }, seams());
    await expect(port({})).rejects.toThrow("LlmServerError");
    expect(n).toBe(3);
  });

  it("a THROTTLE fault escapes after ONE dispatch — the runner's deferRetry owns it (CS4.4)", async () => {
    let n = 0;
    const port = applyInProcessRetry("reviewChunk", async () => {
      n++; throw named("LlmRateLimitError");
    }, seams());
    await expect(port({})).rejects.toThrow("LlmRateLimitError");
    expect(n).toBe(1);
  });

  it("a declared non-retryable escapes after ONE dispatch (reviewChunk: BedrockBudgetExceededError)", async () => {
    let n = 0;
    const port = applyInProcessRetry("reviewChunk", async () => {
      n++; throw named("BedrockBudgetExceededError");
    }, seams());
    await expect(port({})).rejects.toThrow("BedrockBudgetExceededError");
    expect(n).toBe(1);
  });

  it("a NON-wrapped port dispatches exactly once (job-level discipline owns its failures) and receives the composed signal", async () => {
    const ac = new AbortController();
    const s = seams(ac.signal);
    let n = 0;
    let seen: AbortSignal | undefined;
    const port = applyInProcessRetry("persistReviewFindings", async (_input: unknown, attemptSignal: AbortSignal) => {
      n++; seen = attemptSignal; throw named("SomeTransientDbError");
    }, s);
    await expect(port({})).rejects.toThrow("SomeTransientDbError");
    expect(n).toBe(1);
    expect(seen).toBe(ac.signal); // pass-through ports still observe the composed shell signal
  });

  it("a wrapped port receives a PER-ATTEMPT signal that fires when the composed signal aborts", async () => {
    const ac = new AbortController();
    // A clock whose sleep NEVER resolves: the start-to-close timer must not fire under this test —
    // the in-flight attempt stays pending until the composed abort reaches it (FakeClock.sleep
    // resolves immediately, which would time the attempt out before the abort is observable).
    const hangingClock = {
      now: (): Date => new Date(0),
      monotonic: (): number => 0,
      sleep: (): Promise<void> => new Promise<void>(() => undefined),
    };
    const s: PortRetrySeams = { ...seams(ac.signal), clock: hangingClock, signal: ac.signal };
    let seen: AbortSignal | undefined;
    const port = applyInProcessRetry("clone", (_input: unknown, attemptSignal: AbortSignal) => {
      seen = attemptSignal;
      return new Promise<never>((_resolve, reject) => {
        attemptSignal.addEventListener("abort", () => reject(attemptSignal.reason), { once: true });
      });
    }, s);
    const pending = port({});
    await new Promise((r) => setTimeout(r, 10));
    expect(seen?.aborted).toBe(false);
    ac.abort(named("TerminalCancelError", "composed abort"));
    await expect(pending).rejects.toThrow("composed abort");
    expect(seen?.aborted).toBe(true); // the composed abort reached the in-flight attempt (the cloner contract)
  });

  it("an already-aborted composed signal never dispatches a wrapped port", async () => {
    const ac = new AbortController();
    ac.abort(named("TerminalCancelError", "aborted"));
    let n = 0;
    const port = applyInProcessRetry("retrieveKnowledge", async () => { n++; return "x"; }, seams(ac.signal));
    await expect(port({})).rejects.toThrow();
    expect(n).toBe(0);
  });
});

// ─── Wave-1 adversarial-review fix: the nonRetryable vocabulary must match the REAL TS classes ───
// RETRY_POLICIES transcribes the PYTHON ApplicationError type names ('BedrockOutputUnsafeError',
// 'BedrockInvalidRequestError'); the TS classes are named LlmOutputUnsafeError (and invalid
// requests surface as LlmInvocationError today). Matching only the transcribed names means a
// DETERMINISTIC output-unsafe fault burns the full 4-attempt curve instead of failing fast.
describe("toRetryPolicy — nonRetryable matches the real TS error classes (review fix)", () => {
  it("LlmOutputUnsafeError is non-retryable under the reviewChunk policy", async () => {
    const { IN_PROCESS_RETRY_POLICIES, toRetryPolicy } = await import(
      "#backend/runner/retry_policies.js"
    );
    const policy = toRetryPolicy("reviewChunk", IN_PROCESS_RETRY_POLICIES.reviewChunk!);
    // The classifier is NAME-matched; a name-faithful instance suffices (the real class requires
    // a full OutputSafetyDecisionV1 — irrelevant to the name dispatch under test).
    const unsafe = new Error("unsafe output");
    unsafe.name = "LlmOutputUnsafeError";
    expect(policy.nonRetryable(unsafe)).toBe(true);
  });
});
