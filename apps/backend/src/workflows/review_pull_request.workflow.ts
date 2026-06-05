/**
 * `reviewPullRequest` workflow — the Temporal-TS workflow body that drives the review-pipeline SPINE.
 *
 * 1:1 PORT of the frozen Python `ReviewPullRequestWorkflow.run`
 * (vendor/codemaster-py/codemaster/workflows/review_pull_request.py:477) for the SPINE + the Stage-2
 * mutex/workspace LIFECYCLE. The body now carries the load-bearing ordering the Stage-1 thin body
 * deliberately bypassed:
 *
 *   1. GATE — dispatch `start_review_for_webhook_activity` with the RAW payload. The gate does the
 *      tenancy re-check + per-PR mutex acquire. A non-`accepted` status (skipped_busy / skipped_disabled /
 *      closed / skipped_legacy_payload) SHORT-CIRCUITS the whole workflow — we return the gate result
 *      verbatim. On `accepted` we extract the held `mutex_id` (raise if null — the PR #111 B-A1 fix means
 *      the gate holds the mutex for the chain duration).
 *   2. PLACEHOLDER — dispatch `post_review_placeholder_activity` (best-effort, stageOutcome-wrapped) so
 *      engineers see a "reviewing this PR..." comment within ~5s of webhook receipt.
 *   3. WORKSPACE — dispatch `allocate_workspace_activity` to mint a REAL `WorkspaceHandle` (replacing the
 *      Stage-1 deterministic stub); thread it through `ctx.repo.workspaceHandle` so the clone activity
 *      targets the lease-managed directory.
 *   4. ORCHESTRATE — call `orchestrate(ctx)` with two Stage-2 lifecycle callbacks threaded onto the
 *      context: `claimCheck` (the `_abort_if_claim_lost` renewal-backed lease check fired before clone,
 *      classify, aggregate) and `onPlaceholderTeardown` (the `delete_review_placeholder` call fired after
 *      the real post lands).
 *   5. CLEANUP (finally, NON-CANCELLABLE) — release the PR mutex AND release the workspace on EVERY exit
 *      path (success, error, Temporal cancellation). The cleanup runs inside a `CancellationScope.
 *      nonCancellable` so a cancellation still executes the release activities before the CancelledFailure
 *      re-propagates (the Python try/finally analogue; the finally always runs even under cancellation).
 *
 * ── GATE COLLAPSE (gates.ts COLLAPSED_GATES) ──
 * This is a NEW Temporal workflow type with ZERO Python histories, so every `workflow.patched(marker)` is
 * unconditionally TRUE — the TRUE branch of every gate is straight-line code; we NEVER call
 * `workflow.patched()` / `deprecate_patch()`. In particular the `pr-mutex-lease-renewal` gate is collapse-
 * on: lease renewal is UNCONDITIONAL. The Python `_claim_still_held` time-throttle (the `force=False`
 * branch via `workflow.now()`) is DEAD in the frozen body — every call site is `_abort_if_claim_lost` →
 * `_claim_still_held(force=True)`, which short-circuits the throttle. So the renewal runs unconditionally
 * at each of the three boundaries; the wall-clock throttle is not ported (it would be unreachable code AND
 * would trip the clock/random gate, which bans `Date.now()` in the workflow sandbox).
 *
 * ── DELIBERATELY DEFERRED (Stage 3 — NOT this story) ──
 *   * The lifecycle-bookkeeping activities (`record_review_lifecycle_event_activity` ANALYSIS_STARTED,
 *     `record_run_failed_activity` / `record_run_cancelled_activity` on the failure/cancel paths) — the
 *     review_runs RUNNING→FAILED/CANCELLED transitions. Those write the DB lifecycle row; they are a
 *     Stage-3 surface (the encrypted audit/lifecycle subsystem). The mutex + workspace release — the
 *     core-loop-protecting cleanup — IS wired here; the lifecycle-row writes are not. On cancellation the
 *     Python ALSO records CANCELLED before re-raising; the TS port runs the non-cancellable cleanup and
 *     re-raises, deferring the lifecycle-row write to Stage 3 (FOLLOW-UP-stage3-run-lifecycle-transitions).
 *   * The Stage-3 post-review CAPTURE bookkeeping — `state.postedReview` stays at its makePostReviewCapture()
 *     defaults (reviewId=null, publicationOutcome=null), so review_id / publication_outcome are null here
 *     (the Python "no publication captured" branch, review_pull_request.py:4160,4170).
 *
 * ── SANDBOX SAFETY (ADR-0065 / ADR-0066 / check_workflow_bundle + check_clock_random) ──
 * This module is bundled into the Temporal V8-isolate workflow sandbox, which BANS `node:crypto` and raw
 * clock/RNG. It imports ONLY `@temporalio/workflow` + `@temporalio/common` (the sandbox-safe API surface),
 * the deterministic orchestrator/state/proxy helpers (all sandbox-clean), and TYPE-ONLY contract shapes
 * (erased at emit under `verbatimModuleSyntax`, so NO runtime edge to the crypto-importing contracts is
 * created). It does NO clock / random / uuid / network / DB work: it parses the payload (Zod, pure), proxies
 * activities, and proxies the cleanup inside a cancellation scope. All non-deterministic work lives behind
 * the typed activity ports. The build-time proof is `scripts/check_workflow_bundle.ts`.
 */

import {
  CancellationScope,
  proxyActivities,
  log as workflowLog,
} from "@temporalio/workflow";
import { ApplicationFailure } from "@temporalio/common";

import { orchestrate, type ReviewPipelineContext } from "#backend/review/pipeline/orchestrator.js";
import { ReviewWorkflowState } from "#backend/review/pipeline/state.js";
import { CHUNK_CONCURRENCY_DEFAULT } from "#backend/review/pipeline/parallelism.js";
import { stageOutcome, type StageLogger } from "#backend/review/pipeline/degradation.js";
import { makeActivityPorts } from "./activity_proxy.js";

import { ReviewPullRequestPayloadV1 } from "#contracts/review_pull_request.v1.js";

import type { ReviewPipelineResult } from "#backend/review/pipeline/pipeline_result.js";
import type { ReviewPullRequestResultV1 } from "#contracts/review_pull_request.v1.js";
import type { PrMetaV1 } from "#contracts/walkthrough.v1.js";
import type { WorkspaceHandle } from "#contracts/workspace_handle.v1.js";
import type { AllocateWorkspaceInput } from "#contracts/allocate_workspace_input.v1.js";
import type { ReleaseWorkspaceInput } from "#contracts/release_workspace_input.v1.js";
import type { PostReviewPlaceholderInput } from "#contracts/post_review_placeholder_input.v1.js";
import type { DeleteReviewPlaceholderInput } from "#contracts/delete_review_placeholder_input.v1.js";

// ─── lifecycle activity proxies (the Stage-2 mutex/workspace/placeholder surface) ────────────────────
//
// These are dispatched DIRECTLY by the workflow body (NOT through activity_proxy.ts, which proxies the 18
// orchestrator pipeline activities). Each carries the SAME ActivityOptions the frozen Python used at its
// execute_activity site, transcribed 1:1. Registered names are the camelCase worker-registry names (the TS
// composition root registers `startReviewForWebhook`, `allocateWorkspace`, `releaseWorkspace`,
// `renewPrReviewMutexLeaseActivity`, `releasePrReviewMutexActivity`, `postReviewPlaceholder`,
// `deleteReviewPlaceholder`).

/** GATE — start_review_for_webhook_activity (review_pull_request.py:500): 5-min timeout, 3 attempts,
 *  ValueError non-retryable. Returns the typed gate result envelope. */
const { startReviewForWebhook } = proxyActivities<{
  startReviewForWebhook(payloadDict: unknown): Promise<ReviewPullRequestResultV1>;
}>({
  startToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "2 seconds",
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["ValueError"],
  },
});

/** WORKSPACE allocate — allocate_workspace_activity (review_pull_request.py:1033): 30s timeout, 3 attempts. */
const { allocateWorkspace } = proxyActivities<{
  allocateWorkspace(input: AllocateWorkspaceInput): Promise<WorkspaceHandle>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "2 seconds", maximumAttempts: 3 },
});

/** WORKSPACE release — release_workspace_activity (review_pull_request.py:3251): 30s timeout, 2 attempts.
 *  Dispatched inside the non-cancellable cleanup scope. */
const { releaseWorkspace } = proxyActivities<{
  releaseWorkspace(input: ReleaseWorkspaceInput): Promise<void>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "2 seconds", maximumAttempts: 2 },
});

/** MUTEX renew — renew_pr_review_mutex_lease_activity (review_pull_request.py:547): 15s timeout, 3 attempts.
 *  Returns the DB's HONEST still-held boolean (false = definitive lost claim). The result type is given
 *  explicitly by this proxy's interface (string-name dispatch does NOT auto-infer the result type from the
 *  payload converter — see feedback_temporal_string_name_result_type). */
const { renewPrReviewMutexLeaseActivity } = proxyActivities<{
  renewPrReviewMutexLeaseActivity(mutexId: string): Promise<boolean>;
}>({
  startToCloseTimeout: "15 seconds",
  retry: { maximumAttempts: 3 },
});

/** MUTEX release — release_pr_review_mutex_activity (review_pull_request.py:3452): 30s timeout, 5 attempts
 *  (release is critical — leaking the mutex blocks every future review of this PR). Idempotent + commit-safe.
 *  Dispatched inside the non-cancellable cleanup scope. */
const { releasePrReviewMutexActivity } = proxyActivities<{
  releasePrReviewMutexActivity(mutexId: string): Promise<void>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "2 seconds", maximumAttempts: 5 },
});

/** PLACEHOLDER post — post_review_placeholder_activity (review_pull_request.py:631): 15s timeout, 2 attempts,
 *  RuntimeError non-retryable. Best-effort (the activity swallows; the body wraps it in stageOutcome). */
const { postReviewPlaceholder } = proxyActivities<{
  postReviewPlaceholder(input: PostReviewPlaceholderInput): Promise<void>;
}>({
  startToCloseTimeout: "15 seconds",
  retry: {
    initialInterval: "1 second",
    maximumAttempts: 2,
    nonRetryableErrorTypes: ["RuntimeError"],
  },
});

/** PLACEHOLDER delete — delete_review_placeholder_activity (review_pull_request.py:2835): 15s timeout,
 *  2 attempts, RuntimeError non-retryable. Best-effort (fired by the orchestrator's onPlaceholderTeardown
 *  hook after the real post lands). */
const { deleteReviewPlaceholder } = proxyActivities<{
  deleteReviewPlaceholder(input: DeleteReviewPlaceholderInput): Promise<void>;
}>({
  startToCloseTimeout: "15 seconds",
  retry: {
    initialInterval: "1 second",
    maximumAttempts: 2,
    nonRetryableErrorTypes: ["RuntimeError"],
  },
});

/**
 * The SPINE workflow. GATE → placeholder → allocate-workspace → orchestrate (with the lease claim-check +
 * placeholder-teardown lifecycle callbacks) → release mutex + workspace in a non-cancellable finally.
 *
 * @param rawPayload the wire review-request envelope (validated + defaulted by the Zod parse below; the
 *   gate re-validates it independently as its own boundary check).
 * @returns the typed `ReviewPullRequestResultV1` (status=accepted on the spine happy path; the gate's
 *   skip status verbatim when the gate did not accept).
 */
export async function reviewPullRequest(
  rawPayload: unknown,
): Promise<ReviewPullRequestResultV1> {
  // ─── Step 1: validate the input contract at the workflow boundary (Python model_validate fail-fast) ───
  const payload = ReviewPullRequestPayloadV1.parse(rawPayload);

  const logger: StageLogger = { warning: (msg: string): void => proxyLog(msg) };

  // ─── Step 2: GATE (start_review_for_webhook_activity) ─────────────────────────────────────────────
  // Dispatch with the RAW payload (the gate model_validates it independently). A non-accepted status
  // short-circuits the whole workflow — return the gate result verbatim (skipped_busy / skipped_disabled /
  // closed / skipped_legacy_payload). 1:1 with review_pull_request.py:500-512.
  const pre = await startReviewForWebhook(rawPayload);
  if (pre.status !== "accepted") {
    return pre;
  }

  // B-A1: the mutex is HELD by the gate (no longer auto-released). The finally below releases it on every
  // exit path. An accepted gate result MUST carry the mutex_id (the PR #111 B-A1 fix). 1:1 with py:516-520.
  if (pre.mutex_id === null) {
    throw ApplicationFailure.nonRetryable(
      "accepted gate result missing mutex_id; PR #111 B-A1 fix not in effect",
      "PrMutexMissingOnAccept",
    );
  }
  const mutexId: string = pre.mutex_id;

  // ─── Per-PR mutex lease renewal (Fix E / A1+A3) ───────────────────────────────────────────────────
  // `claimStillHeld()` returns false ONLY on a definitive lost claim (lease reclaimed by a newer review or
  // swept by the janitor); the renewal *error* is fail-open (a transient blip must not kill a live review).
  // pr-mutex-lease-renewal collapse-on: lease renewal is UNCONDITIONAL. The Python `force=False` wall-clock
  // throttle is dead in the frozen body (every call site forces), so the renewal runs unconditionally at
  // each of the three claim-check boundaries — no `Date.now()` (sandbox/clock-gate clean).
  const claimStillHeld = async (): Promise<boolean> => {
    try {
      return await renewPrReviewMutexLeaseActivity(mutexId);
    } catch {
      // fail-open: a transient renewal error must not kill a live review (review_pull_request.py:554).
      return true;
    }
  };

  // `_abort_if_claim_lost` — force-renew; if the lease is definitively lost, abort the workflow
  // non-retryably (the superseding review owns the result). 1:1 with review_pull_request.py:559-567.
  const abortIfClaimLost = async (): Promise<void> => {
    if (!(await claimStillHeld())) {
      throw ApplicationFailure.nonRetryable(
        "pr_review_mutex lease lost; superseded by a newer review",
        "PrMutexLostClaim",
      );
    }
  };

  // ─── Step 2.25: placeholder PR comment (best-effort) ──────────────────────────────────────────────
  // Post a "reviewing this PR..." comment so engineers see life on the PR before the pipeline completes.
  // stageOutcome with skipOutcome() (the Python `_log_stage` is the canonical success emitter; the helper
  // handles WARN + record_stage(error) on failure) — a placeholder failure does NOT fail the workflow.
  await stageOutcome(
    "post_review_placeholder",
    { logger, headSha: payload.head_sha, runId: payload.run_id },
    async (handle): Promise<void> => {
      handle.skipOutcome();
      await postReviewPlaceholder({
        schema_version: 1,
        pr_id: payload.pr_id,
        run_id: payload.run_id,
        review_id: payload.review_id,
        installation_id: payload.installation_id,
        owner: payload.gh_owner,
        repo_name: payload.gh_repo_name,
        pr_number: payload.pr_number,
      });
    },
  );

  // ─── Step 4a: allocate the REAL workspace (replaces the Stage-1 deterministic stub) ────────────────
  // The returned WorkspaceHandle carries the workspace identity + lease key; the clone activity targets it
  // and the finally releases by its workspace_id. A failure here propagates past orchestrate entirely, but
  // the mutex-release finally still runs (it brackets this allocate too). 1:1 with review_pull_request.py
  // :1033-1061. Allocate runs OUTSIDE the orchestrate try so a failed allocation never enters the workspace-
  // release path with a handle that was never minted (mutex release still happens via the finally below).
  const workspaceHandle: WorkspaceHandle = await allocateWorkspace({
    schema_version: 1,
    run_id: payload.run_id,
    review_id: payload.review_id,
    installation_id: payload.installation_id,
    // ReviewPullRequestPayloadV1 carries the internal UUID repository_id; the numeric GitHub-side repo_id
    // (diagnostic _meta only, AD-13) is not on the payload — pass null (1:1 with the Python `repo_id=None`).
    repo_id: null,
    workflow_id: payload.run_id,
  });

  // ─── build the ReviewPipelineContext with the Stage-2 lifecycle callbacks ─────────────────────────
  const state = new ReviewWorkflowState();
  const ctx: ReviewPipelineContext = {
    repo: {
      repoUrl: `https://github.com/${payload.gh_owner}/${payload.gh_repo_name}.git`,
      changedPaths: [],
      workspaceHandle,
    },
    pr: {
      prMeta: buildPrMeta(payload),
      headSha: payload.head_sha,
      runId: payload.run_id,
      reviewId: payload.review_id,
      policyRevision: payload.policy_revision,
      prNumber: payload.pr_number,
      changedLineRanges: {},
      parentFindings: [],
      parentReviewId: null,
    },
    activities: makeActivityPorts(),
    limits: { chunkConcurrency: CHUNK_CONCURRENCY_DEFAULT },
    state,
    logger,
    // CLAIM-CHECK seam: the renewal-backed lease check, fired by the orchestrator before clone, classify,
    // aggregate (the three Python `_abort_if_claim_lost` boundaries). A lost lease raises a non-retryable
    // ApplicationFailure that propagates out of orchestrate (the finally still releases the mutex/workspace).
    claimCheck: abortIfClaimLost,
    // PLACEHOLDER-TEARDOWN seam: the delete_review_placeholder dispatch, fired by the orchestrator after the
    // real post lands. Best-effort (stageOutcome-wrapped + skipOutcome); a teardown failure never fails the
    // pipeline. 1:1 with the Python `delete_review_placeholder` inside `_post_review`.
    onPlaceholderTeardown: async (): Promise<void> => {
      await stageOutcome(
        "delete_review_placeholder",
        { logger, headSha: payload.head_sha, runId: payload.run_id },
        async (handle): Promise<void> => {
          handle.skipOutcome();
          await deleteReviewPlaceholder({
            schema_version: 1,
            pr_id: payload.pr_id,
            run_id: payload.run_id,
            review_id: payload.review_id,
            installation_id: payload.installation_id,
            owner: payload.gh_owner,
            repo_name: payload.gh_repo_name,
            pr_number: payload.pr_number,
          });
        },
      );
    },
  };

  // ─── Step 5: orchestrate with a NON-CANCELLABLE cleanup finally ───────────────────────────────────
  // The mutex release AND the workspace release run on EVERY exit path (success, error, cancellation). They
  // are dispatched inside CancellationScope.nonCancellable so a Temporal cancellation (CancelledFailure)
  // still executes them BEFORE the cancellation re-propagates out of this try/finally — the Python try/
  // finally analogue (the finally runs even when asyncio.CancelledError is in flight). releaseMutex runs
  // even if releaseWorkspace fails (and vice-versa): leaking the mutex blocks future reviews, so both
  // dispatch independently inside the scope.
  let result: ReviewPipelineResult;
  try {
    result = await orchestrate(ctx);
  } finally {
    await CancellationScope.nonCancellable(async () => {
      // Release the mutex (B-A1 — critical: 5 attempts). Independent of the workspace release: a workspace-
      // release failure must NOT skip the mutex release. stageOutcome swallows so a release failure is
      // logged but never masks the original exit error (success/orig-error/cancellation propagates).
      await stageOutcome(
        "cleanup",
        { logger, headSha: payload.head_sha, runId: payload.run_id },
        async (handle): Promise<void> => {
          handle.skipOutcome();
          await releasePrReviewMutexActivity(mutexId);
        },
      );
      // Release the workspace by its lease key (workspace_id). The orchestrator's own cleanup() already
      // released the LEASE via the releaseWorkspace activity port on the success path; this body-level
      // release is the lifecycle backstop the Python workflow body owns (it releases by workspace_id
      // regardless of how orchestrate exited). Idempotent: a second release of an already-released lease is
      // a no-op. stageOutcome swallows so a failure never masks the exit path.
      await stageOutcome(
        "cleanup",
        { logger, headSha: payload.head_sha, runId: payload.run_id },
        async (handle): Promise<void> => {
          handle.skipOutcome();
          await releaseWorkspace({ schema_version: 1, workspace_id: workspaceHandle.workspace_id });
        },
      );
    });
  }

  // ─── Step 6: map ReviewPipelineResult → ReviewPullRequestResultV1 (review_pull_request.py:4157-4171) ──
  // review_id / publication_outcome are read from state.postedReview, which stays at its
  // makePostReviewCapture() defaults in this body (the Stage-3 post-review CAPTURE wiring is deferred) →
  // both null here, matching the Python "no publication captured" branch.
  const postedReviewId = state.postedReview.reviewId;
  return {
    schema_version: 1,
    status: "accepted",
    pr_number: pre.pr_number,
    review_id: postedReviewId === null ? null : String(postedReviewId),
    findings_count: result.findingsCount,
    // mutex_id=null — already released; don't expose to caller (py:4162).
    mutex_id: null,
    installation_id: payload.installation_id,
    pr_id: payload.pr_id,
    publication_outcome: state.postedReview.publicationOutcome,
  };
}

/**
 * Build the per-PR `PrMetaV1` the walkthrough / post / per-chunk-context stages read, from the typed
 * payload. 1:1 with the Python `pr_meta` construction off `typed_payload`.
 */
function buildPrMeta(payload: ReviewPullRequestPayloadV1): PrMetaV1 {
  return {
    pr_id: payload.pr_id,
    installation_id: payload.installation_id,
    repo: `${payload.gh_owner}/${payload.gh_repo_name}`,
    pr_title: payload.pr_title,
    pr_description: payload.pr_description,
    author_login: payload.author_login,
    draft: payload.draft,
    base_ref: payload.base_ref,
    head_ref: payload.head_ref,
    opened_at: payload.opened_at,
  };
}

/**
 * Emit a degradation WARN line on the Temporal workflow logger (the sandbox-safe + replay-safe sink). The
 * SDK's `log` (from `@temporalio/workflow`) folds every line into workflow history deterministically, so it
 * is replay-safe. This tiny indirection maps the orchestrator's StageLogger shape (`{ warning(msg) }`) onto
 * the SDK's `log.warn(msg)`.
 */
function proxyLog(msg: string): void {
  workflowLog.warn(msg);
}
