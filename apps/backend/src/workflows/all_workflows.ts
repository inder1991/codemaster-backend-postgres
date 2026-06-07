/**
 * Combined workflow bundle entrypoint for the review worker's single `workflowsPath`.
 *
 * A Temporal worker bundles exactly ONE `workflowsPath` file; the REACHABLE exports of that file (and its
 * import graph) are the registered workflow TYPES. To host the auto-registration reconcile/repair workflows
 * on the SAME combined-pod worker that serves `reviewPullRequest` (project-owner directive: reuse the review
 * worker, no new "ingest" worker), this barrel re-exports all four workflow functions; `worker/main.ts`
 * points `workflowsPath` at THIS module instead of `review_pull_request.workflow` directly.
 *
 * The four registered workflow types (= the exported function names; `RealTemporalClient.startWorkflow`
 * dispatches by registered TS function name):
 *   - `reviewPullRequest`              — the review-pipeline spine
 *   - `reconcileInstallation`          — installation-event reconcile (core.installations + core.users)
 *   - `reconcileRepositories`          — installation_repositories-event reconcile (core.repositories)
 *   - `repairInstallationRepositories` — canonical GitHub-API hydrate of core.repositories
 *
 * SANDBOX SAFETY: this module is bundled into the V8-isolate workflow sandbox. It only re-exports the two
 * workflow modules, which themselves import ONLY `@temporalio/workflow` + type-only contract shapes — no
 * runtime edge to clock/random/crypto/DB is created here.
 */

export { reviewPullRequest } from "./review_pull_request.workflow.js";
export {
  reconcileInstallation,
  reconcileRepositories,
  repairInstallationRepositories,
} from "./reconcile.workflow.js";
