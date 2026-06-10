// Phase 3d W3d.1: the Temporal workflow_type → background-jobs job_type translation registry.
//
// The outbox producers stamp `temporal_workflow_start` rows with the Temporal workflow TYPE string
// (the camelCase EXPORTED workflow function name — the same string RealTemporalClient.startWorkflow
// dispatches by). The NEXT wave's outbox cutover rewires that sink to enqueue
// core.background_jobs rows instead of starting Temporal workflows: it reads THIS map to translate
// the row's stamped workflow_type into the platform job_type whose handler now carries the work.
// Until that cutover lands the map is consumed only by its lockstep test
// (test/integration/runner/event_handlers_reconcile.integration.test.ts), which pins every value to
// a registered handler — an unmapped workflow_type or an unregistered job_type would strand/dead-
// letter every dispatched row as `no handler for <job_type>`.
//
// ## Source of truth for the KEYS (byte-exact producer strings — do NOT retype from memory)
//   - "reconcileInstallation" / "reconcileRepositories"
//       ingest/github_webhook_persistence.ts (RECONCILE_INSTALLATION_WORKFLOW_TYPE /
//       RECONCILE_REPOSITORIES_WORKFLOW_TYPE)
//   - "repairInstallationRepositories"
//       ingest/_repair_dispatcher.ts (REPAIR_INSTALLATION_REPOSITORIES_WORKFLOW_TYPE)
//   - "syncCodeOwners" / "refreshSemanticDocs"
//       ingest/_push_emitters.ts (SYNC_CODE_OWNERS_WORKFLOW_TYPE /
//       REFRESH_SEMANTIC_DOCS_WORKFLOW_TYPE)
//
// ## VALUES are registered job_types
// Every value MUST have a matching registration (handlers/event_handlers.ts — and, as later Phase 3d
// waves widen this map to the remaining workflow_types, whichever handler module carries them).
//
// Started with the 3 reconcile/repair entries (W3d.1); W3d.2 appended the 2 knowledge producers;
// later Phase 3d waves append as their workflow migrations land.

/** Temporal workflow_type → platform job_type. Readonly — the cutover reads, never mutates. */
export const WORKFLOW_TYPE_TO_JOB_TYPE: Readonly<Record<string, string>> = {
  reconcileInstallation: "reconcile_installation",
  reconcileRepositories: "reconcile_repositories",
  repairInstallationRepositories: "repair_installation_repositories",
  syncCodeOwners: "sync_code_owners",
  refreshSemanticDocs: "refresh_semantic_docs",
};
