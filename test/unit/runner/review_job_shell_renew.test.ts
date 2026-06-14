// F7 / P1-C — the mutex-renew loop must distinguish a DEFINITIVE lease loss (renew returns false) from a
// TRANSIENT error (renew throws, e.g. a DB blip), and tolerate only N consecutive transient failures before
// abandoning the lease fail-CLOSED — not the old blanket `.catch(() => true)` fail-open that kept paying
// Bedrock + posting under a lease it could no longer vouch for during a DB outage.

import { describe, expect, it } from "vitest";

import {
  classifyRenewOutcome,
  MAX_CONSECUTIVE_MUTEX_RENEW_FAILURES,
} from "#backend/runner/review_job_shell.js";

const MAX = MAX_CONSECUTIVE_MUTEX_RENEW_FAILURES;

describe("classifyRenewOutcome (F7 / P1-C)", () => {
  it("a successful renew (ok=true) resets the streak and does NOT abandon", () => {
    expect(classifyRenewOutcome({ errored: false, renewedOk: true, priorConsecutiveErrors: 2, maxConsecutiveErrors: MAX })).toEqual({
      consecutiveErrors: 0,
      abandon: false,
    });
  });

  it("a DEFINITIVE loss (ok=false) abandons immediately, regardless of the streak", () => {
    expect(classifyRenewOutcome({ errored: false, renewedOk: false, priorConsecutiveErrors: 0, maxConsecutiveErrors: MAX })).toEqual({
      consecutiveErrors: 0,
      abandon: true,
    });
  });

  it("a transient error below the threshold is TOLERATED (no abandon), incrementing the streak", () => {
    expect(classifyRenewOutcome({ errored: true, renewedOk: false, priorConsecutiveErrors: 0, maxConsecutiveErrors: MAX })).toEqual({
      consecutiveErrors: 1,
      abandon: false,
    });
  });

  it("the Nth consecutive transient error abandons fail-closed", () => {
    expect(classifyRenewOutcome({ errored: true, renewedOk: false, priorConsecutiveErrors: MAX - 1, maxConsecutiveErrors: MAX })).toEqual({
      consecutiveErrors: MAX,
      abandon: true,
    });
  });

  it("a transient error then a success resets the streak (a blip does not accumulate forever)", () => {
    const afterBlip = classifyRenewOutcome({ errored: true, renewedOk: false, priorConsecutiveErrors: 0, maxConsecutiveErrors: MAX });
    expect(afterBlip.abandon).toBe(false);
    const afterRecover = classifyRenewOutcome({ errored: false, renewedOk: true, priorConsecutiveErrors: afterBlip.consecutiveErrors, maxConsecutiveErrors: MAX });
    expect(afterRecover).toEqual({ consecutiveErrors: 0, abandon: false });
  });
});
