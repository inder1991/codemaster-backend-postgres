/**
 * Combined workflow bundle entrypoint for the review worker's single `workflowsPath`.
 *
 * A Temporal worker bundles exactly ONE `workflowsPath` file; the REACHABLE exports of that file (and its
 * import graph) are the registered workflow TYPES. To host the auto-registration reconcile/repair workflows
 * on the SAME combined-pod worker that serves `reviewPullRequest` (project-owner directive: reuse the review
 * worker, no new "ingest" worker), this barrel re-exports all four workflow functions; `worker/main.ts`
 * points `workflowsPath` at THIS module instead of `review_pull_request.workflow` directly.
 *
 * The registered workflow types (= the exported function names; `RealTemporalClient.startWorkflow` and the
 * ADR-0074 schedule actions dispatch by registered TS function name):
 *   - `reviewPullRequest`              — the review-pipeline spine
 *   - `reconcileInstallation`          — installation-event reconcile (core.installations + core.users)
 *   - `reconcileRepositories`          — installation_repositories-event reconcile (core.repositories)
 *   - `repairInstallationRepositories` — canonical GitHub-API hydrate of core.repositories
 *   - `mutexJanitorWorkflow`           — Wave-1 liveness backstop: reclaim leaked pr_review_mutex rows (5-min cron)
 *   - `reviewRunReaperWorkflow`        — Wave-1 liveness backstop: cancel stale RUNNING review_runs (10-min cron)
 *
 * SANDBOX SAFETY: this module is bundled into the V8-isolate workflow sandbox. It only re-exports the
 * workflow modules, which themselves import ONLY `@temporalio/workflow` + type-only contract shapes — no
 * runtime edge to clock/random/crypto/DB is created here.
 */

export { reviewPullRequest } from "./review_pull_request.workflow.js";
export {
  reconcileInstallation,
  reconcileRepositories,
  repairInstallationRepositories,
} from "./reconcile.workflow.js";
export { mutexJanitorWorkflow } from "./mutex_janitor.workflow.js";
export { reviewRunReaperWorkflow } from "./review_run_reaper.workflow.js";
