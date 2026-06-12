/**
 * Plain-Node compatibility PROOF for the review-pipeline modules (Task W1.1 / E5).
 *
 * The Postgres runner shell runs the EXISTING `orchestrate()` in-process. That rests on one premise: the
 * three pipeline modules — `orchestrator.ts`, `degradation.ts`, `posting.ts` — IMPORT and BEHAVE correctly
 * in a plain Node process. Post-Temporal-teardown these modules have ZERO `@temporalio` coupling (the
 * premise is now structural), but the proof still guards against a regression that re-introduces a
 * workflow-only dependency or breaks the in-process error carrier.
 *
 * If ANY assertion here fails, the "orchestrate unchanged" premise is BROKEN and the shell needs a designed
 * seam (escalation), NOT an improvised patch in this test.
 *
 * The proofs:
 *   (a) the three modules import + bind without throwing in plain vitest Node;
 *   (b) `stageOutcome('classify', …, async () => "ok")` RESOLVES, and the `recordStage` OTel emit never
 *       throws outside an exporter (the metric is a no-op until a MeterProvider is wired);
 *   (c) an {@link ActivityError} of the H-2 dropped-state type, fed to `extractDroppedStateFromPostFailure`,
 *       ROUND-TRIPS its details — the error carrier works without any activity/workflow boundary (E5).
 */

import { describe, expect, it } from "vitest";

// (a) — the three pipeline modules under proof.
import { stageOutcome, recordStage } from "#backend/review/pipeline/degradation.js";
import {
  postReviewResults,
  extractDroppedStateFromPostFailure,
  POST_REVIEW_FAILED_WITH_DROPPED_STATE,
} from "#backend/review/pipeline/posting.js";
import { orchestrate } from "#backend/review/pipeline/orchestrator.js";
import { ActivityError } from "#backend/review/activity_error.js";

describe("plain-node compat (W1.1 / E5) — (a) imports do not throw", () => {
  it("imports orchestrate / stageOutcome+recordStage / postReviewResults+extractDroppedStateFromPostFailure", () => {
    // The mere fact that the imports above resolved + bound is the proof; assert each is the expected shape
    // so a future tree-shake / rename can't silently turn an import into `undefined`.
    expect(typeof orchestrate).toBe("function");
    expect(typeof stageOutcome).toBe("function");
    expect(typeof recordStage).toBe("function");
    expect(typeof postReviewResults).toBe("function");
    expect(typeof extractDroppedStateFromPostFailure).toBe("function");
    // The H-2 carrier NAME the extractor narrows on (1:1 with the frozen Python constant).
    expect(POST_REVIEW_FAILED_WITH_DROPPED_STATE).toBe("PostReviewFailedWithDroppedState");
  });
});

describe("plain-node compat (W1.1) — (b) stageOutcome + the recordStage metric emit are safe in plain Node", () => {
  it("recordStage('classify','ok') does not throw (the OTel counter is a no-op until an exporter is wired)", () => {
    expect(() => recordStage({ stage: "classify", outcome: "ok" })).not.toThrow();
  });

  it("stageOutcome('classify', …, async () => 'ok') RESOLVES with the metric emit a no-op", async () => {
    const result = await stageOutcome(
      "classify",
      { logger: { warning() {} } },
      async () => "ok",
    );
    expect(result).toBe("ok");
  });

  it("stageOutcome swallows a body error (record_stage(error) no-ops, no throw)", async () => {
    let warned = false;
    const result = await stageOutcome(
      "classify",
      { logger: { warning() { warned = true; } } },
      async () => {
        throw new Error("boom");
      },
    );
    expect(result).toBeUndefined();
    expect(warned).toBe(true);
  });
});

describe("plain-node compat (W1.1 / E5) — (c) ActivityError dropped-state round-trip without an activity boundary", () => {
  it("round-trips the dropped-state details through extractDroppedStateFromPostFailure", () => {
    const details = {
      posted_review_pr_id: "pr-1",
      kept_finding_indices: [0, 2],
      dropped_classifications: [{ index: 1, eligibility_reason: "out_of_scope" }],
    };

    // A stub stands in for the `post_review_results` activity: it throws the H-2 ActivityError directly
    // (no activity wrapper). E5's premise: the error carrier still works in plain Node.
    const stubThrow = (): never => {
      throw new ActivityError({
        type: POST_REVIEW_FAILED_WITH_DROPPED_STATE,
        message: "github publish failed after kept/dropped partition",
        nonRetryable: true,
        details: [details],
      });
    };

    let caught: unknown;
    try {
      stubThrow();
    } catch (err) {
      caught = err;
    }

    const extracted = extractDroppedStateFromPostFailure(caught);
    expect(extracted).not.toBeNull();
    expect(extracted?.posted_review_pr_id).toBe("pr-1");
    expect(extracted?.kept_finding_indices).toEqual([0, 2]);
    expect(extracted?.dropped_classifications).toEqual([
      { index: 1, eligibility_reason: "out_of_scope" },
    ]);
  });

  it("returns null for a failure carrying a DIFFERENT type (only the H-2 type is acted on)", () => {
    const other = new ActivityError({
      type: "SomeOtherFailure",
      message: "unrelated",
      details: [{ posted_review_pr_id: "pr-9" }],
    });
    expect(extractDroppedStateFromPostFailure(other)).toBeNull();
  });
});
