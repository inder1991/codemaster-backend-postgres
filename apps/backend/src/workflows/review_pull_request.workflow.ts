/**
 * `reviewPullRequest` workflow — the THIN Temporal-TS workflow body that REPLACES `reviewSkeleton` as the
 * review-pipeline SPINE workflow (Stage 1 of the Python→TS review-orchestrator port).
 *
 * 1:1 PORT of the frozen Python `ReviewPullRequestWorkflow.run`
 * (vendor/codemaster-py/codemaster/workflows/review_pull_request.py:476) for the SPINE happy path, reduced
 * to the THIN core: validate the typed payload → build the deterministic `ReviewPipelineContext` → wire the
 * typed activity ports → call `orchestrate()` → map the `ReviewPipelineResult` onto the typed
 * `ReviewPullRequestResultV1` return envelope. The orchestrator (orchestrator.ts) carries the entire
 * pipeline; this body is just the input/output adapter + the port-wiring seam.
 *
 * ── DELIBERATELY BYPASSED (Stages 2/3 — NOT this story) ──
 *   * the mutex/webhook GATE activity (skipped_busy / skipped_disabled) — Stage 2 lifecycle.
 *   * the PR-review mutex acquire/release lifecycle bookkeeping (mutex_id) — Stage 2.
 *   * the BF-5 / BF-13 enrichment step that populates changed_paths / changed_line_ranges — Stage 3. In the
 *     frozen Python, when enrichment is unavailable the orchestrator inputs default to () / {} (
 *     review_pull_request.py:916-917); the thin body uses the SAME defaults ([] / {}). The stub activities
 *     in the composition proof return canned routing/chunks regardless, so the spine still composes.
 *   * the allocate_workspace lifecycle (Stage 2) that mints the WorkspaceHandle. The thin body constructs a
 *     deterministic, sandbox-safe handle from the payload UUIDs (see `buildWorkspaceHandle`) — NO uuid mint,
 *     NO clock; the clone activity targets it, and cleanup releases by its workspace_id.
 *   * the post-review / arbitration / lifecycle CAPTURE bookkeeping (Stage 3) — `state.postedReview` stays
 *     at its `_PostReviewCapture()` defaults (reviewId=null, publicationOutcome=null), so the mapped
 *     review_id / publication_outcome are null in this body — EXACTLY the Python "no publication captured →
 *     review_id=None / publication_outcome=None" branch (review_pull_request.py:4160,4170).
 *
 * ── GATE COLLAPSE (gates.ts COLLAPSED_GATES) ──
 * This is a NEW Temporal workflow type with ZERO Python histories, so every `workflow.patched(marker)` is
 * unconditionally TRUE — the TRUE branch of every gate is straight-line code and we NEVER call
 * `workflow.patched()` / `deprecate_patch()`. The orchestrator already embodies the collapse-on stages;
 * the body adds nothing gated.
 *
 * ── SANDBOX SAFETY (ADR-0065 / ADR-0066 / check_workflow_bundle + check_clock_random) ──
 * This module is bundled into the Temporal V8-isolate workflow sandbox, which BANS `node:crypto`. It
 * therefore imports ONLY:
 *   - `@temporalio/workflow` (the sandbox-safe API surface),
 *   - the deterministic orchestrator + state + activity-proxy helpers (all sandbox-clean), and
 *   - TYPE-ONLY contract shapes (`import type` — ERASED at emit under `verbatimModuleSyntax`, so NO runtime
 *     edge to the crypto-importing contracts like `diff_chunking.v1` / `retrieved_evidence.v1` is created).
 * It does NO clock / random / uuid / network / DB work: it parses the payload (Zod, pure), builds plain
 * data records, and proxies activities. All non-deterministic work lives behind the typed activity ports.
 * The build-time proof is `scripts/check_workflow_bundle.ts` (bundles THIS workflow crypto-free).
 */

import { log as workflowLog } from "@temporalio/workflow";

import { orchestrate, type ReviewPipelineContext } from "#backend/review/pipeline/orchestrator.js";
import { ReviewWorkflowState } from "#backend/review/pipeline/state.js";
import { CHUNK_CONCURRENCY_DEFAULT } from "#backend/review/pipeline/parallelism.js";
import { makeActivityPorts } from "./activity_proxy.js";

import { ReviewPullRequestPayloadV1 } from "#contracts/review_pull_request.v1.js";

import type { ReviewPipelineResult } from "#backend/review/pipeline/pipeline_result.js";
import type { ReviewPullRequestResultV1 } from "#contracts/review_pull_request.v1.js";
import type { PrMetaV1 } from "#contracts/walkthrough.v1.js";
import type { WorkspaceHandle } from "#contracts/workspace_handle.v1.js";

/**
 * The thin SPINE workflow. Takes the typed v2 payload, drives `orchestrate()`, and returns the typed
 * result envelope.
 *
 * The input is the wire payload (the Python `run(self, payload: dict[str, Any])` shape). Step 1 of the
 * frozen Python body fail-fast VALIDATES it via `ReviewPullRequestPayloadV1.model_validate(payload)` at the
 * workflow boundary (review_pull_request.py:486) so downstream code never defensive-defaults placeholder
 * UUIDs; the TS port mirrors that with `ReviewPullRequestPayloadV1.parse(rawPayload)` (Zod is pure +
 * crypto-free → sandbox-safe). A malformed payload throws here, failing the workflow at the boundary
 * exactly as the Python does. Parsing also MATERIALIZES the contract defaults (schema_version, draft,
 * the nullable optionals), so the body reads a fully-populated envelope.
 *
 * @param rawPayload the wire review-request envelope (validated + defaulted by the Zod parse below).
 * @returns the typed `ReviewPullRequestResultV1` (status=accepted on the spine happy path).
 */
export async function reviewPullRequest(
  rawPayload: unknown,
): Promise<ReviewPullRequestResultV1> {
  // ─── Step 1: validate the input contract at the workflow boundary (Python model_validate fail-fast) ───
  const payload = ReviewPullRequestPayloadV1.parse(rawPayload);

  // ─── build the deterministic ReviewPipelineContext (the Python orchestrate_review_pipeline kwargs) ───
  const state = new ReviewWorkflowState();
  const ctx: ReviewPipelineContext = {
    repo: {
      // repo_url = f"https://github.com/{gh_owner}/{gh_repo_name}.git" (review_pull_request.py:3375-3377).
      repoUrl: `https://github.com/${payload.gh_owner}/${payload.gh_repo_name}.git`,
      // changed_paths defaults to () when BF-5/BF-13 enrichment is bypassed (Stage 3;
      // review_pull_request.py:916). The stub activities in the composition proof return canned routing.
      changedPaths: [],
      workspaceHandle: buildWorkspaceHandle(payload),
    },
    pr: {
      prMeta: buildPrMeta(payload),
      headSha: payload.head_sha,
      runId: payload.run_id,
      reviewId: payload.review_id,
      policyRevision: payload.policy_revision,
      prNumber: payload.pr_number,
      // changed_line_ranges defaults to {} when enrichment is bypassed (Stage 3; py:917).
      changedLineRanges: {},
      // parent_findings=() / parent_review_id=None on every spine push (py:3381-3382). Incremental
      // carry-forward threading is a Stage-3 lifecycle concern.
      parentFindings: [],
      parentReviewId: null,
    },
    // The typed activity ports — proxyActivities() per-activity with the Stage-0 RETRY_POLICIES, bridging
    // the compact port method names onto the worker's registered activity names (activity_proxy.ts).
    activities: makeActivityPorts(),
    limits: { chunkConcurrency: CHUNK_CONCURRENCY_DEFAULT },
    state,
    // workflow.log is the sandbox-safe + replay-safe WARN sink the stageOutcome degradation lines emit on
    // (the Python _log_stage analogue). Cast through the StageLogger shape the orchestrator expects.
    logger: { warning: (msg: string): void => proxyLog(msg) },
  };

  const result: ReviewPipelineResult = await orchestrate(ctx);

  // ─── map ReviewPipelineResult → ReviewPullRequestResultV1 (review_pull_request.py:4157-4171) ───
  // review_id: str(posted_review_capture.review_id) if not None else None. In the THIN body the Stage-3
  // post-review CAPTURE wiring is absent, so state.postedReview stays at its _PostReviewCapture() defaults
  // (reviewId=null) → review_id is null here, matching the Python "no publication captured" branch.
  const postedReviewId = state.postedReview.reviewId;
  return {
    schema_version: 1,
    status: "accepted",
    pr_number: payload.pr_number,
    review_id: postedReviewId === null ? null : String(postedReviewId),
    findings_count: result.findingsCount,
    // mutex_id=None — already released; don't expose to caller (py:4162). The thin body holds no mutex.
    mutex_id: null,
    // Surface tenancy keys so observers correlate the result back to the DM tables (py:4163-4166).
    installation_id: payload.installation_id,
    pr_id: payload.pr_id,
    // publication_outcome: None when no publication was captured (py:4167-4170) — the thin-body default.
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
 * Construct the `WorkspaceHandle` the workspace-aware clone activity targets — WITHOUT the Stage-2
 * allocate_workspace lifecycle (deliberately bypassed; see the module header). The handle is built
 * DETERMINISTICALLY from the payload UUIDs:
 *   - workspace_id = run_id   — the run-scoped workspace identity. Deterministic + replay-safe (the
 *     workflow execution's own run id), and the lease key cleanup releases by. NO uuid mint (the sandbox
 *     bans node:crypto); reusing the payload UUID is sandbox-clean.
 *   - installation_id / run_id — straight from the payload.
 *   - derived_path = "" — the clone activity computes the real on-disk path (ClonedRepoV1.workspace_path);
 *     the handle's path is advisory and the cloner does not require it pre-populated.
 *   - state = "ALLOCATED" — the lifecycle state the clone activity expects an allocated handle to carry.
 *
 * When the Stage-2 workspace lifecycle lands, allocate_workspace mints the real handle (a fresh
 * workspace_id) and this helper is removed; until then this is the faithful "no separate allocation step"
 * shape, and the release-by-workspace_id contract still round-trips (cleanup releases run_id).
 */
function buildWorkspaceHandle(payload: ReviewPullRequestPayloadV1): WorkspaceHandle {
  return {
    workspace_id: payload.run_id,
    installation_id: payload.installation_id,
    run_id: payload.run_id,
    derived_path: "",
    state: "ALLOCATED",
  };
}

/**
 * Emit a degradation WARN line on the Temporal workflow logger (the sandbox-safe + replay-safe sink). The
 * SDK's `log` (from `@temporalio/workflow`) is the deterministic logging surface — every line it emits is
 * folded into workflow history deterministically, so it is replay-safe. This tiny indirection maps the
 * orchestrator's StageLogger shape (`{ warning(msg) }`) onto the SDK's `log.warn(msg)`.
 */
function proxyLog(msg: string): void {
  workflowLog.warn(msg);
}
