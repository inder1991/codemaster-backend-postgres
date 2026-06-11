import { describe, expect, it } from "vitest";

import {
  RECONCILE_WINDOW_SECONDS,
  RETRY_ENVELOPE_JITTER_MAX,
  worstCaseWallTimeSeconds,
} from "#backend/cost/cost_journal_reconciler.js";
import { RETRY_POLICIES } from "#backend/review/pipeline/activity_ports.js";

// Phase 0 checklist #3 — the reconcile window is DERIVED from the RETRY_POLICIES worst-case
// wall-time (the spec's "≈6 min for reviewChunk"), not hard-coded, so a future policy edit moves
// the window automatically. The derivation must follow the runner's actual execution envelope
// (run_with_retry.ts): maxAttempts × startToClose racing-timeout + the jittered backoff sleeps
// between attempts (jitter factor up to 1.25 — `random.uniform(0.75, 1.25)`).
//
// For reviewChunk (startToClose 90s; retry initial 5s, max 60s, backoff 2.0, attempts 4):
//   4 × 90  +  1.25 × (5 + 10 + 20)  =  360 + 43.75  =  403.75 s   (≈ 6.7 min)
// and the shipped window applies a ×2 safety factor (orphaned-attempt late settles can land
// anywhere inside the envelope — v4 #3 —, writer-vs-reconciler clock skew, the client's
// lock-timeout-retry tail):  ceil(2 × 403.75) = 808 s.

describe("worstCaseWallTimeSeconds — the RETRY_POLICIES envelope math", () => {
  it("computes the reviewChunk worst case: 4×90s attempts + 1.25-jittered 5/10/20s backoff = 403.75s", () => {
    expect(worstCaseWallTimeSeconds(RETRY_POLICIES.reviewChunk)).toBe(403.75);
  });

  it("caps the backoff curve at maximumInterval (a long curve cannot exceed the cap per sleep)", () => {
    // initial 30s, backoff 2.0 → nominal sleeps 30/60/120 but capped at 40 → 30 + 40 + 40 = 110;
    // attempts 4 × 10s = 40; jitter 1.25 on the sleeps only → 40 + 137.5 = 177.5.
    expect(
      worstCaseWallTimeSeconds({
        startToCloseTimeout: "10s",
        retry: {
          initialInterval: "30s",
          maximumInterval: "40s",
          backoffCoefficient: 2.0,
          maximumAttempts: 4,
        },
      }),
    ).toBe(177.5);
  });

  it("a single-attempt policy has no sleeps — just the one startToClose budget", () => {
    expect(
      worstCaseWallTimeSeconds({
        startToCloseTimeout: "10s",
        retry: { initialInterval: "2s", maximumAttempts: 1 },
      }),
    ).toBe(10);
  });

  it("FAILS LOUD on a duration that is not seconds-shaped (a future policy-format edit must not silently zero the window)", () => {
    expect(() =>
      worstCaseWallTimeSeconds({
        startToCloseTimeout: "5m",
        retry: { initialInterval: "2s", maximumAttempts: 2 },
      }),
    ).toThrow(/5m/);
  });

  it("FAILS LOUD when the policy carries no startToCloseTimeout (no envelope to derive from)", () => {
    expect(() =>
      worstCaseWallTimeSeconds({ retry: { initialInterval: "2s", maximumAttempts: 2 } }),
    ).toThrow(/startToCloseTimeout/);
  });
});

describe("RECONCILE_WINDOW_SECONDS — the shipped window", () => {
  it("is ceil(2 × the reviewChunk worst case) = 808s (≈13.5 min)", () => {
    expect(RECONCILE_WINDOW_SECONDS).toBe(808);
    expect(RECONCILE_WINDOW_SECONDS).toBe(
      Math.ceil(2 * worstCaseWallTimeSeconds(RETRY_POLICIES.reviewChunk)),
    );
  });

  it("the jitter factor mirrors run_with_retry's uniform(0.75, 1.25) upper bound", () => {
    expect(RETRY_ENVELOPE_JITTER_MAX).toBe(1.25);
  });
});
