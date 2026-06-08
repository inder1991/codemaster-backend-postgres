/**
 * `reviewRunReaperWorkflow` — FAITHFUL 1:1 port of the frozen Python `ReviewRunReaperWorkflow.run`
 * (vendor/codemaster-py/codemaster/workflows/review_run_reaper.py:29-46). Fix D / M2
 * (mutex-liveness hardening, ADR-0064).
 *
 * A Temporal Schedule fires this every 10 minutes (`overlap=SKIP`, registered at boot via the ADR-0074
 * `ensureCronSchedule` seam). It is a LIVENESS BACKSTOP: it cancels `core.review_runs` rows whose worker
 * died before the workflow could invoke `record_run_failed_activity` / `record_run_cancelled_activity`.
 * Without it a dead-worker run stays at `RUNNING` indefinitely — blocking the mutex janitor from
 * reclaiming the associated `pr_review_mutex` row and leaving the UI stuck at "In Progress".
 *
 * The body is a PURE PASS-THROUGH: it proxies the single registered `review_run_reaper_activity` by name,
 * applies the EXACT retry curve transcribed from the Python `RetryPolicy(...)` (start_to_close 10 min,
 * initial_interval 15 s, maximum_attempts 3), and returns the activity result verbatim.
 *
 * ── EXPORTED NAME (combined-pod review-worker decision, ADR-0074 §3) ──
 * The exported FUNCTION NAME is the registered Temporal workflow TYPE string — camelCase
 * `reviewRunReaperWorkflow` — because `RealTemporalClient.startWorkflow` dispatches by the registered TS
 * function name (the same reason the review path renamed `ReviewPullRequestWorkflow` → `reviewPullRequest`
 * and the reconcile path uses camelCase). The Wave-1 schedule (`ensureCronSchedule`) targets
 * `taskQueue: "review-default"` so the started workflow lands on the combined-pod review worker whose
 * `workflowsPath` bundle re-exports this module. This diverges from the frozen Python's dedicated
 * `review-default` task queue constant only in topology (re-export, not a separate ingest pool); the
 * retry curve + activity body are byte-faithful.
 *
 * ── PROXY METHOD KEY = REGISTERED ACTIVITY NAME ──
 * The `proxyActivities<{ review_run_reaper_activity(): … }>` METHOD KEY is the REGISTERED Temporal activity
 * name (the key under which the worker's `activities` map exposes the activity — see
 * worker/build_activities.ts). A key that does not match a registered name dispatches
 * `ActivityNotRegistered`. We therefore key the proxy by the snake_case `review_run_reaper_activity` string
 * the worker registers the activity under. The activity takes NO workflow-supplied input (it resolves its
 * DSN / threshold / clock from the environment at the activity boundary), 1:1 with the Python
 * `workflow.execute_activity(review_run_reaper_activity, …)` zero-arg dispatch.
 *
 * ── SANDBOX SAFETY (ADR-0065 / ADR-0066) ──
 * This module is bundled into the Temporal V8-isolate workflow sandbox. It imports ONLY
 * `@temporalio/workflow` (the sandbox-safe surface) + a TYPE-ONLY contract shape (erased at emit under
 * verbatimModuleSyntax, so NO runtime edge to the crypto-importing contracts module is created). It does
 * NO clock / random / uuid / network / DB work — all non-deterministic work lives behind the typed
 * activity port.
 */

import { proxyActivities } from "@temporalio/workflow";

import type { ReviewRunReaperResultV1 } from "#contracts/review_run_reaper_result.v1.js";

/**
 * Proxy for `review_run_reaper_activity`. Retry curve 1:1 with review_run_reaper.py:39-45:
 * start_to_close 10 min, initial_interval 15 s, maximum_attempts 3. (No non-retryable set — every fault
 * the activity can raise — transient DB error, pool exhaustion — SHOULD redrive within the 3-attempt
 * envelope; a clean return commits the sweep.)
 */
const { review_run_reaper_activity } = proxyActivities<{
  review_run_reaper_activity(): Promise<ReviewRunReaperResultV1>;
}>({
  startToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "15 seconds",
    maximumAttempts: 3,
  },
});

/**
 * `reviewRunReaperWorkflow` body. Single-activity pass-through; returns the ReviewRunReaperResultV1
 * verbatim. Replay-deterministic by construction (the activity's CTE UPDATE … RETURNING is idempotent —
 * a re-run reaps only what is still stale RUNNING).
 */
export async function reviewRunReaperWorkflow(): Promise<ReviewRunReaperResultV1> {
  return review_run_reaper_activity();
}
