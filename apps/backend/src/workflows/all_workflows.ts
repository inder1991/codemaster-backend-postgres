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
 *   - `confluenceIngestWorkflow`       — Wave-4 Confluence corpus sync (6h interval schedule, combined-pod)
 *   - `markStaleChunksWorkflow`        — Wave-4 Confluence staleness sweep (24h interval schedule)
 *   - `triggerPageResyncWorkflow`      — Wave-4 single-page resync (admin-triggered on approval revocation)
 *   - `runIdRetentionWorkflow`         — Wave-2 retention cron: close stale PRs / retire runs / delete events (3am daily)
 *   - `partitionMaintenanceWorkflow`   — Wave-2 retention cron: pg_partman maintenance sweep (2am daily)
 *   - `workspaceRetentionWorkflow`     — Wave-2 retention cron: orphan/reap/purge workspace leases (5-min interval)
 *
 * COMBINED-POD (Wave-4, ADR-0075): the 3 Confluence workflows run on the SAME review worker (queue
 * "review-default"). The Python ported `CONFLUENCE_SYNC_TASK_QUEUE` consts read "confluence-sync", but
 * that dedicated queue is vestigial in the TS combined-pod port — the Stage-8 schedules OVERRIDE it to
 * "review-default" so a fired schedule lands a start THIS worker's bundle (this barrel) can run.
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
export { confluenceIngestWorkflow } from "./confluence_ingest.workflow.js";
export { markStaleChunksWorkflow } from "./mark_stale_chunks.workflow.js";
export { triggerPageResyncWorkflow } from "./trigger_page_resync.workflow.js";
export { runIdRetentionWorkflow } from "./run_id_retention.workflow.js";
export { partitionMaintenanceWorkflow } from "./partition_maintenance.workflow.js";
export { workspaceRetentionWorkflow } from "./workspace_retention.workflow.js";
