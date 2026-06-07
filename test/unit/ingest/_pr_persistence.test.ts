/**
 * Unit coverage for the PURE part of the PR-metadata persistence port (S3): the state-machine
 * `deriveStateFromAction` (1:1 with the frozen Python `_pr_persistence.derive_state_from_action`,
 * vendor/codemaster-py/codemaster/ingest/_pr_persistence.py:89-121). The DB writers + the orchestration
 * (upsertGhUser → upsertPullRequest → emitPrStateTransition, the early-exit guards, and the fail-open
 * SAVEPOINT) are exercised against a disposable Postgres in the integration suite.
 */
import { describe, expect, it } from "vitest";

import { deriveStateFromAction } from "#backend/ingest/_pr_persistence.js";

describe("deriveStateFromAction (port of _pr_persistence.derive_state_from_action)", () => {
  it("opened → (null, open)", () => {
    expect(deriveStateFromAction({ eventAction: "opened", merged: false, priorState: null })).toEqual({
      fromState: null,
      toState: "open",
    });
  });

  it("synchronize → (prior ?? open, open)", () => {
    expect(deriveStateFromAction({ eventAction: "synchronize", merged: false, priorState: "open" })).toEqual({
      fromState: "open",
      toState: "open",
    });
    expect(deriveStateFromAction({ eventAction: "synchronize", merged: false, priorState: null })).toEqual({
      fromState: "open",
      toState: "open",
    });
  });

  it("ready_for_review / converted_to_draft / edited → (prior ?? open, open)", () => {
    for (const eventAction of ["ready_for_review", "converted_to_draft", "edited"]) {
      expect(deriveStateFromAction({ eventAction, merged: false, priorState: null })).toEqual({
        fromState: "open",
        toState: "open",
      });
    }
  });

  it("closed (not merged) → (prior ?? open, closed)", () => {
    expect(deriveStateFromAction({ eventAction: "closed", merged: false, priorState: "open" })).toEqual({
      fromState: "open",
      toState: "closed",
    });
  });

  it("closed (merged) → (prior ?? open, merged)", () => {
    expect(deriveStateFromAction({ eventAction: "closed", merged: true, priorState: "open" })).toEqual({
      fromState: "open",
      toState: "merged",
    });
  });

  it("reopened from closed/merged → (prior, open)", () => {
    expect(deriveStateFromAction({ eventAction: "reopened", merged: false, priorState: "closed" })).toEqual({
      fromState: "closed",
      toState: "open",
    });
    expect(deriveStateFromAction({ eventAction: "reopened", merged: false, priorState: "merged" })).toEqual({
      fromState: "merged",
      toState: "open",
    });
  });

  it("reopened from a non-terminal state THROWS (invariant violation → caller skips the write path)", () => {
    expect(() =>
      deriveStateFromAction({ eventAction: "reopened", merged: false, priorState: "open" }),
    ).toThrow();
    expect(() =>
      deriveStateFromAction({ eventAction: "reopened", merged: false, priorState: null }),
    ).toThrow();
  });

  it("a non-derivable action THROWS (caller treats it as audit-only / skip)", () => {
    expect(() =>
      deriveStateFromAction({ eventAction: "labeled", merged: false, priorState: "open" }),
    ).toThrow();
  });
});
