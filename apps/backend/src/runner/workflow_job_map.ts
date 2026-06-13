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
//   - "triggerPageResyncWorkflow"
//       api/admin/page_resync_dispatcher.ts (TRIGGER_PAGE_RESYNC_DISPATCH_WORKFLOW_TYPE — the
//       W4c.2 #5 concrete OutboxPageResyncDispatcher server.ts wires into the DELETE-approval
//       route, replacing the previously-unwired optional seam (recording stub). The constant equals
//       the registered TS workflow TYPE string — the EXPORTED
//       function name (workflows/trigger_page_resync.workflow.ts) RealTemporalClient.startWorkflow
//       dispatches by (NOT the vestigial PascalCase TRIGGER_PAGE_RESYNC_WORKFLOW_TYPE — that const
//       preserves the Python class name for parity only).
//
// ## VALUES are registered job_types
// Every value MUST have a matching registration (handlers/event_handlers.ts — and, as later Phase 3d
// waves widen this map to the remaining workflow_types, whichever handler module carries them).
//
// Started with the 3 reconcile/repair entries (W3d.1); W3d.2 appended the 2 knowledge producers;
// Phase 3e.3 appended trigger_page_resync — the LAST non-review event-driven workflow.

/** Temporal workflow_type → platform job_type. Readonly — the cutover reads, never mutates. */
export const WORKFLOW_TYPE_TO_JOB_TYPE: Readonly<Record<string, string>> = {
  reconcileInstallation: "reconcile_installation",
  reconcileRepositories: "reconcile_repositories",
  repairInstallationRepositories: "repair_installation_repositories",
  syncCodeOwners: "sync_code_owners",
  refreshSemanticDocs: "refresh_semantic_docs",
  triggerPageResyncWorkflow: "trigger_page_resync",
};

// ─── W1.9d (RC5): per-workflow-type retry budgets carried across the cutover ────────────────────
//
// The Temporal proxies these job_types replace carried TUNED per-workflow retry curves; without an
// explicit budget the cutover enqueue collapses every type onto BackgroundJobsRepo's max_attempts
// default (3, ~3s of 1s-base exponential backoff) — so an out-of-order `installation_repositories`
// webhook (H4: the reconcile activity THROWS until `installation.created` seeds the parent row,
// relying on redrive) dead-letters before GitHub's fan-out skew resolves, and a brief GitHub outage
// permanently kills a repair the 12-attempt Temporal window would have ridden out.
//
// BackgroundJobsTemporalPort threads these into enqueue (max_attempts on the job row) — budgets are
// fixed WHERE JOBS ARE ENQUEUED, never by mutating claim(). The runner's markFailed backoff base
// stays 1000ms: 10 attempts ≈ an 8.5-minute redrive window (vs Temporal's 5s-base ≈ minutes — same
// order), 12 attempts ≈ 34 minutes (vs the hydrate proxy's 10s→300s ≈ 35 minutes — near-parity by
// coincidence of the curves; a per-type backoff base would need a schema column and is deliberately
// out of W1.9d's scope).
//
// ## Parity sources (the Temporal proxy each budget transcribes — do NOT retune from memory)
//   - reconcile_installation             5   reconcile.workflow.ts:71-77   (1s initial, 5 attempts)
//   - reconcile_repositories            10   reconcile.workflow.ts:98-103  (5s initial, 10 — the H4
//                                            out-of-order absorption window)
//   - repair_installation_repositories  12   reconcile.workflow.ts:127-134 (10s→300s ×2.0, 12 — the
//                                            bursty-GitHub-outage hydrate window)
//   - sync_code_owners                   5   sync_code_owners.workflow.ts:61-64 (2s initial, 5)
//   - refresh_semantic_docs              3   refresh_semantic_docs.workflow.ts:77-81 (clone step) +
//                                            :103-106 (refresh step) — both steps 3
//   - trigger_page_resync                3   trigger_page_resync.workflow.ts:65-67 (10s→2m, 3)
//
// Lockstep: test/unit/runner/workflow_job_map.test.ts pins the values AND that every mapped
// job_type carries a budget — migrating a new workflow_type forces an explicit budget decision.

/** Platform job_type → max_attempts (the Temporal-parity attempt budget). Readonly. */
export const JOB_TYPE_MAX_ATTEMPTS: Readonly<Record<string, number>> = {
  reconcile_installation: 5,
  reconcile_repositories: 10,
  repair_installation_repositories: 12,
  sync_code_owners: 5,
  refresh_semantic_docs: 3,
  trigger_page_resync: 3,
};
