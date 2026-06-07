/**
 * Auto-registration reconcile/repair WORKFLOWS — three thin Temporal workflow bodies that drive the
 * webhook-triggered installation/repository auto-registration journey.
 *
 * FAITHFUL 1:1 PORTS of the frozen Python workflow bodies:
 *   - `reconcileInstallation`           ← ReconcileInstallationWorkflow.run
 *       (vendor/codemaster-py/codemaster/workflows/reconcile_installation.py:31-50)
 *   - `reconcileRepositories`           ← ReconcileRepositoriesWorkflow.run
 *       (vendor/codemaster-py/codemaster/workflows/reconcile_repositories.py:24-48)
 *   - `repairInstallationRepositories`  ← RepairInstallationRepositoriesWorkflow.run
 *       (vendor/codemaster-py/codemaster/workflows/repair_installation_repositories.py:33-66)
 *
 * Each body is a PURE PASS-THROUGH: it proxies its single activity by the REGISTERED Temporal activity
 * name (`reconcile_installation_activity` / `reconcile_repositories_activity` /
 * `hydrate_installation_repositories_activity`), applies the EXACT per-activity retry curve transcribed
 * from the Python `RetryPolicy(...)`, and returns the activity result verbatim. Same input → same activity
 * call → replay-deterministic by construction (the activities' INSERT … ON CONFLICT upserts are idempotent).
 *
 * The `proxyActivities<{ <registered_name>(...) }>` METHOD KEY is the REGISTERED Temporal activity name (the
 * key under which the worker's `activities` map exposes the activity — see worker/build_activities.ts). A
 * key that does not match a registered name dispatches `ActivityNotRegistered`. We therefore key the proxies
 * by the snake_case `*_activity` strings the worker registers these three under.
 *
 * ── COMBINED-POD WORKER DECISION (project-owner directive) ──
 * The TS port REUSES the combined-pod review worker (NO new "ingest" worker). These three workflows are
 * re-exported from `all_workflows.ts` (the review worker's single `workflowsPath` bundle) so the same worker
 * that serves `reviewPullRequest` also serves these. Consequently:
 *   - the EXPORTED FUNCTION NAMES are the registered Temporal workflow TYPE strings — camelCase
 *     `reconcileInstallation` / `reconcileRepositories` / `repairInstallationRepositories` (NOT the Python
 *     PascalCase `*Workflow` class names) — because `RealTemporalClient.startWorkflow` dispatches by the
 *     registered TS function name (the same reason the review path renamed `ReviewPullRequestWorkflow` →
 *     `reviewPullRequest`).
 *   - the producers (the webhook emitters + the repair dispatcher) stamp `task_queue = REVIEW_TASK_QUEUE`
 *     ("review-default") so the dispatched workflow lands on THIS worker's queue.
 * This diverges from the frozen Python (which colocates these on a dedicated "ingest" queue) — a deliberate
 * topology choice recorded in the integrator handoff; behaviour (retry curves, activity bodies, idempotency)
 * is byte-faithful.
 *
 * ── NON-RETRYABLE ERROR TYPE (ZodError, the TS analogue of Python ValueError) ──
 * The Python workflows mark `ValueError` non-retryable: a payload that fails `model_validate` is a permanent
 * data defect, not a transient fault — retrying re-fails identically and wastes the retry budget. In the TS
 * port the activity re-validates its bare-dict input via a Zod contract, which throws `ZodError` on a bad
 * payload. So `ZodError` is the faithful non-retryable analogue. EVERYTHING ELSE stays retryable — in
 * particular the reconcile-repositories activity's plain `Error` (parent installation not yet recorded;
 * out-of-order webhook) and the hydrate activity's `GitHubApiUnavailableError` (5xx after retries) MUST
 * redrive, so they are NOT in the non-retryable set.
 *
 * ── SANDBOX SAFETY (ADR-0065 / ADR-0066) ──
 * This module is bundled into the Temporal V8-isolate workflow sandbox. It imports ONLY `@temporalio/workflow`
 * (the sandbox-safe surface) + TYPE-ONLY contract shapes (erased at emit under verbatimModuleSyntax, so NO
 * runtime edge to the crypto-importing contracts is created). It does NO clock / random / uuid / network / DB
 * work — all non-deterministic work lives behind the typed activity ports. The activity inputs are the bare
 * JSON payload dicts (the workflow does NOT validate; the activity re-validates at its boundary).
 */

import { proxyActivities } from "@temporalio/workflow";

import type {
  ReconcileInstallationResultV1,
  ReconcileRepositoriesResultV1,
} from "#contracts/reconcile_results.v1.js";
import type { RepairResultV1 } from "#contracts/repair_installation_repositories.v1.js";

/**
 * Proxy for `reconcile_installation_activity`. Retry curve 1:1 with reconcile_installation.py:44-49:
 * start_to_close 30s, initial_interval 1s, maximum_attempts 5, non_retryable ["ValueError"]→["ZodError"].
 */
const { reconcile_installation_activity } = proxyActivities<{
  reconcile_installation_activity(payloadDict: unknown): Promise<ReconcileInstallationResultV1>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "1 second",
    maximumAttempts: 5,
    nonRetryableErrorTypes: ["ZodError"],
  },
});

/**
 * `reconcileInstallation` workflow body. Single-activity pass-through; returns the activity result verbatim.
 */
export async function reconcileInstallation(
  payload: unknown,
): Promise<ReconcileInstallationResultV1> {
  return reconcile_installation_activity(payload);
}

/**
 * Proxy for `reconcile_repositories_activity`. Retry curve 1:1 with reconcile_repositories.py:42-47:
 * start_to_close 2min, initial_interval 5s, maximum_attempts 10, non_retryable ["ValueError"]→["ZodError"].
 * The longer 10-attempt envelope absorbs out-of-order webhook delivery (installation_repositories arriving
 * BEFORE installation.created): the activity throws a plain Error (NOT ZodError) until the parent
 * installations row exists, so it stays retryable and redrives.
 */
const { reconcile_repositories_activity } = proxyActivities<{
  reconcile_repositories_activity(payloadDict: unknown): Promise<ReconcileRepositoriesResultV1>;
}>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "5 seconds",
    maximumAttempts: 10,
    nonRetryableErrorTypes: ["ZodError"],
  },
});

/**
 * `reconcileRepositories` workflow body. Single-activity pass-through.
 */
export async function reconcileRepositories(
  payload: unknown,
): Promise<ReconcileRepositoriesResultV1> {
  return reconcile_repositories_activity(payload);
}

/**
 * Proxy for `hydrate_installation_repositories_activity` (the repair workflow's body IS the hydrate
 * activity). Retry curve 1:1 with repair_installation_repositories.py:48-66: start_to_close 5min,
 * initial_interval 10s, backoff_coefficient 2.0, maximum_interval 300s, maximum_attempts 12, non_retryable
 * ["ValueError"]→["ZodError"]. Bursty GitHub outages (secondary rate limits, 502s, token failures) need a
 * generous window — repair is low-frequency, non-user-facing, idempotent; bias toward eventual success. The
 * activity catches 404/403/401 terminal failures and returns a `blocked` RepairResultV1 (does NOT re-throw);
 * only a 5xx-after-retries (GitHubApiUnavailableError) re-throws to drive this retry curve.
 */
const { hydrate_installation_repositories_activity } = proxyActivities<{
  hydrate_installation_repositories_activity(payloadDict: unknown): Promise<RepairResultV1>;
}>({
  startToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "10 seconds",
    backoffCoefficient: 2.0,
    maximumInterval: "300 seconds",
    maximumAttempts: 12,
    nonRetryableErrorTypes: ["ZodError"],
  },
});

/**
 * `repairInstallationRepositories` workflow body. Single-activity pass-through; returns RepairResultV1.
 */
export async function repairInstallationRepositories(payload: unknown): Promise<RepairResultV1> {
  return hydrate_installation_repositories_activity(payload);
}
