/**
 * `refreshSemanticDocs` WORKFLOW — a thin event-driven Temporal workflow body that refreshes one
 * repository's per-installation knowledge index for one default-branch push.
 *
 * FAITHFUL 1:1 PORT of the frozen Python `RefreshSemanticDocsWorkflow.run`
 * (vendor/codemaster-py/codemaster/workflows/refresh_semantic_docs_workflow.py, Sprint 26 / B-3).
 *
 * EVENT-DRIVEN, NOT scheduled: the workflow is STARTED by the outbox dispatcher from a
 * `temporal_workflow_start` row the webhook receiver enqueues when a `push` event lands on the
 * repository's default branch — the SAME trigger pattern as `syncCodeOwners` (the INTEGRATOR wires that
 * webhook-emit + the workflow registration). The body composes TWO activity steps:
 *   1. `clone_repository_activity` — produces a cloned-workspace path (the existing primitive shared with
 *      the review pipeline; the INTEGRATOR wires its TS registration — see the divergence note below).
 *   2. `refresh_semantic_docs_activity` — discovers + chunks + embeds + upserts into
 *      `core.knowledge_chunks` (the {@link RefreshSemanticDocsActivity} holder this story ships).
 *
 * One `executeActivity` per step keeps per-step observability + native Temporal retry. Same input → same
 * activity calls → replay-deterministic by construction (B-1's natural-key UNIQUE + the `embedDocChunks`
 * ON CONFLICT upsert + the content-addressable UUIDv5 chunk_id make same-`head_sha` re-runs a no-op).
 *
 * ── COMBINED-POD WORKER + REGISTERED-NAME DECISION ──
 * Consistent with the reconcile/repair + sync_code_owners ports: the EXPORTED FUNCTION NAME
 * (`refreshSemanticDocs`, camelCase) is the registered Temporal workflow TYPE string the integrator
 * dispatches by (NOT the Python PascalCase `RefreshSemanticDocsWorkflow`). The Python pins the activities
 * to a dedicated `refresh-default` task queue (`REFRESH_SEMANTIC_DOCS_TASK_QUEUE`, per R-20 / ADR-0046);
 * the INTEGRATOR decides the TS task-queue topology (combined-pod review worker vs a dedicated
 * worker-refresh deployment) and stamps the matching queue on the webhook-emitted row.
 *
 * ── RETRY CURVES (1:1 with refresh_semantic_docs_workflow.py:72-116) ──
 * Step 1 (clone): start_to_close 60s; heartbeat 30s; initial_interval 2s; maximum_attempts 3;
 *   non_retryable ["GitHubAppUnauthorized", "GitHubNotFoundError"].
 * Step 2 (refresh): start_to_close 300s; initial_interval 5s; maximum_attempts 3; non_retryable
 *   ["WrongVectorDimensionError"]. R-49: NO heartbeat_timeout — the refresh activity calls no
 *   `activity.heartbeat()`, so a heartbeat timeout would spuriously fail it. Embed-service degradation is
 *   NOT retryable at the workflow layer — the activity returns `retrieval_degraded=True` and we surface it.
 *
 * ── DIVERGENCE: clone activity shape (INVARIANT-11 single typed input) ──
 * The frozen Python refresh workflow dispatches `clone_repository_activity` as 3 string positionals
 * (`args=[str(installation_id), str(repository_id), head_sha]`) and gets back a workspace-path STRING.
 * CLAUDE.md invariant 11 (LOCKED) forbids multi-positional activity dispatch in the TS port — every
 * activity takes ONE typed input. So this body proxies the activity by the SAME registered name
 * (`clone_repository_activity`) but with a SINGLE typed {@link CloneRepositoryInputV1} arg, built below
 * from the workflow's typed input. The TS `clone_repository_activity` port (clone_repository.activity.ts)
 * is the bound impl — the INTEGRATOR wires its registration (token provider + repo resolver + cloner deps)
 * in build_activities; the registered NAME is the binding seam, the typed input is the wire contract.
 *
 * ── SANDBOX SAFETY (ADR-0065 / ADR-0066) ──
 * This module is bundled into the Temporal V8-isolate workflow sandbox. It imports ONLY
 * `@temporalio/workflow` + TYPE-ONLY contract shapes (erased at emit under verbatimModuleSyntax, so NO
 * runtime edge to the crypto-importing contracts is created). It does NO clock / random / uuid / network /
 * DB / fs work — all non-deterministic work lives behind the typed activity ports.
 */

import { proxyActivities } from "@temporalio/workflow";

import type { CloneRepositoryInputV1 } from "#contracts/clone_repository.v1.js";
import type {
  RefreshSemanticDocsInputV1,
  RefreshSemanticDocsResultV1,
} from "#contracts/refresh_semantic_docs.v1.js";

/**
 * Proxy for `clone_repository_activity` (Step 1). Retry curve 1:1 with the Python clone step. The METHOD
 * KEY is the REGISTERED Temporal activity name the INTEGRATOR binds (see the divergence note in the module
 * header). Returns the cloned-workspace path STRING.
 *
 * INVARIANT-11 (CLAUDE.md #11, LOCKED): the Python refresh workflow dispatches this step as THREE string
 * positionals (`args=[str(installation_id), str(repository_id), head_sha]`). That multi-positional shape is
 * forbidden in the TS port — every activity takes ONE typed input. So the proxy is a SINGLE typed
 * {@link CloneRepositoryInputV1} (the TS `clone_repository_activity` port's contract), and the body below
 * builds that one input from the workflow's typed `RefreshSemanticDocsInputV1`. This is the surfaced
 * faithful-port divergence (see the module header's clone-activity-shape note + the contract header).
 */
const { clone_repository_activity } = proxyActivities<{
  clone_repository_activity(input: CloneRepositoryInputV1): Promise<string>;
}>({
  startToCloseTimeout: "60 seconds",
  heartbeatTimeout: "30 seconds",
  retry: {
    initialInterval: "2 seconds",
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["GitHubAppUnauthorized", "GitHubNotFoundError"],
  },
});

/**
 * Proxy for `refresh_semantic_docs_activity` (Step 2). Retry curve 1:1 with the Python refresh step. The
 * METHOD KEY is the REGISTERED Temporal activity name (the key under which the worker's `activities` map
 * exposes the {@link RefreshSemanticDocsActivity} holder's bound `refreshSemanticDocs` — wired by the
 * INTEGRATOR in build_activities). The single typed arg carries the workflow input + the cloned-workspace
 * path + the (v1-empty) custom knowledge paths.
 *
 * R-49: NO heartbeatTimeout (the refresh activity never heartbeats). `WrongVectorDimensionError` is the
 * one non-retryable type; embed-service degradation surfaces as `retrieval_degraded=True` in the result.
 */
const { refresh_semantic_docs_activity } = proxyActivities<{
  refresh_semantic_docs_activity(args: {
    input: RefreshSemanticDocsInputV1;
    workspacePath: string;
    customKnowledgePaths: ReadonlyArray<string>;
  }): Promise<RefreshSemanticDocsResultV1>;
}>({
  startToCloseTimeout: "300 seconds",
  retry: {
    initialInterval: "5 seconds",
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["WrongVectorDimensionError"],
  },
});

/**
 * `refreshSemanticDocs` workflow body. Two-step pass-through (clone → refresh); returns the refresh
 * activity result verbatim. 1:1 with refresh_semantic_docs_workflow.py:59-116.
 *
 * Custom knowledge paths from `.codemaster.yaml` are an operational extension; v1 defaults to empty (B-5's
 * ramp/runbook wires customer override).
 */
export async function refreshSemanticDocs(
  input: RefreshSemanticDocsInputV1,
): Promise<RefreshSemanticDocsResultV1> {
  // Step 1: clone the repository → workspace path. Single typed input (invariant 11) built from the
  // workflow's typed input — replaces the Python 3-positional `args=[...]` dispatch.
  const workspacePath = await clone_repository_activity({
    schema_version: 1,
    installation_id: input.installation_id,
    repository_id: input.repository_id,
    head_sha: input.head_sha,
  });

  // Step 2: discover + chunk + embed + upsert.
  return refresh_semantic_docs_activity({
    input,
    workspacePath,
    customKnowledgePaths: [],
  });
}
