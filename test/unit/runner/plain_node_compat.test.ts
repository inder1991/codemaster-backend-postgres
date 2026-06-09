/**
 * Plain-Node compatibility PROOF for the Temporal-coupled review modules (Task W1.1 / E5).
 *
 * The de-Temporal runner shell (Phase 2) runs the EXISTING `orchestrate()` in-process, with NO Temporal
 * worker/sandbox around it. That whole shell rests on one premise: the three Temporal-coupled pipeline
 * modules — `orchestrator.ts`, `degradation.ts`, `posting.ts` — IMPORT and BEHAVE correctly in a plain Node
 * process, OUTSIDE a workflow context. This file is the executable proof of that premise (blocking gap #2).
 *
 * If ANY assertion here fails, the "orchestrate unchanged" premise is BROKEN and the shell needs a designed
 * seam in degradation/posting (escalation), NOT an improvised patch in this test.
 *
 * The four proofs (W1.1 spec):
 *   (a) the three modules + their `@temporalio/*` deps import without throwing in plain vitest Node;
 *   (b) `inWorkflowContext()` returns false here, and `stageOutcome('classify', …, async () => "ok")`
 *       RESOLVES — the `recordStage` metric emit is a no-op (no sandbox throw on `metricMeter` access);
 *   (c) an `ApplicationFailure.create({ type: POST_REVIEW_FAILED_WITH_DROPPED_STATE, details: […] })`
 *       thrown by a stub and fed to `extractDroppedStateFromPostFailure` ROUND-TRIPS the details — the
 *       H-2 error-carrier works without the activity boundary (E5);
 *   (d) `CancelledFailure` is constructible + `instanceof`-detectable here.
 */

import { describe, expect, it } from "vitest";

// (a) — the three Temporal-coupled pipeline modules under proof.
import { stageOutcome, recordStage } from "#backend/review/pipeline/degradation.js";
import {
  postReviewResults,
  extractDroppedStateFromPostFailure,
  POST_REVIEW_FAILED_WITH_DROPPED_STATE,
} from "#backend/review/pipeline/posting.js";
import { orchestrate } from "#backend/review/pipeline/orchestrator.js";

// The `@temporalio/*` symbols the modules transitively depend on — proven importable + behaving in plain Node.
import { inWorkflowContext } from "@temporalio/workflow";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";

describe("plain-node compat (W1.1 / E5) — (a) imports do not throw outside a workflow", () => {
  it("imports orchestrate / stageOutcome+recordStage / postReviewResults+extractDroppedStateFromPostFailure", () => {
    // The mere fact that the imports above resolved + bound is the proof; assert each is the expected shape
    // so a future tree-shake / rename can't silently turn an import into `undefined`.
    expect(typeof orchestrate).toBe("function");
    expect(typeof stageOutcome).toBe("function");
    expect(typeof recordStage).toBe("function");
    expect(typeof postReviewResults).toBe("function");
    expect(typeof extractDroppedStateFromPostFailure).toBe("function");
    // The H-2 carrier `type` string the extractor narrows on (1:1 with the frozen Python constant).
    expect(POST_REVIEW_FAILED_WITH_DROPPED_STATE).toBe("PostReviewFailedWithDroppedState");
  });

  it("imports the @temporalio/* deps the modules rely on", () => {
    expect(typeof inWorkflowContext).toBe("function");
    expect(typeof ApplicationFailure).toBe("function");
    expect(typeof ApplicationFailure.create).toBe("function");
    expect(typeof CancelledFailure).toBe("function");
  });
});

describe("plain-node compat (W1.1) — (b) no workflow context + stageOutcome metric emit is a no-op", () => {
  it("inWorkflowContext() is false in plain vitest Node", () => {
    expect(inWorkflowContext()).toBe(false);
  });

  it("recordStage('classify','ok') does not throw outside a workflow (metric emit no-ops)", () => {
    // recordStage guards `if (!inWorkflowContext()) return;` BEFORE touching the workflow-only `metricMeter`.
    // The proof: no `RestrictedWorkflowAccessError` / sandbox throw when accessing the meter seam here.
    expect(() => recordStage({ stage: "classify", outcome: "ok" })).not.toThrow();
  });

  it("stageOutcome('classify', …, async () => 'ok') RESOLVES with the metric emit a no-op", async () => {
    // The success path never invokes options.logger, but the type requires it; a no-op warning sink keeps
    // the call type-clean AND proves the wrapper drives the body + the (no-op) record_stage emit cleanly.
    const result = await stageOutcome(
      "classify",
      { logger: { warning() {} } },
      async () => "ok",
    );
    expect(result).toBe("ok");
  });

  it("stageOutcome swallows a body error outside a workflow (record_stage(error) no-ops, no sandbox throw)", async () => {
    // Belt-and-suspenders: the FAILURE path also reaches record_stage(error) → metricMeter — prove that no-ops
    // here too (default raiseAfterLog=false → swallow → returns undefined).
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

describe("plain-node compat (W1.1 / E5) — (c) ApplicationFailure dropped-state round-trip without the activity boundary", () => {
  it("round-trips the dropped-state details through extractDroppedStateFromPostFailure", () => {
    const details = {
      posted_review_pr_id: "pr-1",
      kept_finding_indices: [0, 2],
      dropped_classifications: [{ index: 1, eligibility_reason: "out_of_scope" }],
    };

    // A stub stands in for the `post_review_results` activity: it MINTS + THROWS the H-2 ApplicationFailure
    // directly (no Temporal activity wrapper). E5's premise: the error-carrier still works in plain Node.
    const stubThrow = (): never => {
      throw ApplicationFailure.create({
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
    const other = ApplicationFailure.create({
      type: "SomeOtherFailure",
      message: "unrelated",
      details: [{ posted_review_pr_id: "pr-9" }],
    });
    expect(extractDroppedStateFromPostFailure(other)).toBeNull();
  });
});

describe("plain-node compat (W1.1) — (d) CancelledFailure is constructible + instanceof-detectable", () => {
  it("constructs a CancelledFailure and detects it via instanceof in plain Node", () => {
    const cancelled = new CancelledFailure("cancelled-in-plain-node");
    expect(cancelled).toBeInstanceOf(CancelledFailure);
    expect(cancelled).toBeInstanceOf(Error);
    expect(cancelled.message).toBe("cancelled-in-plain-node");
  });
});
