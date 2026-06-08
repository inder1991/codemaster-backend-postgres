/**
 * `confluenceIngestWorkflow` — FAITHFUL 1:1 port of the frozen Python workflow body
 * `ConfluenceIngestWorkflow.run` + `_sync_one_space` + the schedule helper / constants
 * (vendor/codemaster-py/codemaster/workflows/confluence_sync_workflow.py).
 *
 * The production Confluence sync workflow. A single Temporal Schedule fires this every 6 hours
 * (`overlap=SKIP`); each tick iterates ALL active spaces internally (bounded Temporal-side scheduling
 * cost vs N per-space schedules). On each tick:
 *   1. list_active_confluence_spaces_activity — enumerate enabled spaces.
 *   2. For each space (_syncOneSpace):
 *        fetch_space_pages_activity → for each page:
 *          fetch_page_body_activity → sanitize_page_activity → chunk_and_embed_activity →
 *          upsert_chunks_activity
 *        then reconcile_deletions_activity (soft-delete chunks of pages absent this cycle).
 * Aggregate stats are returned as RefreshConfluenceOutputV1.
 *
 * ── FAIL-OPEN SEMANTICS (1:1 with the Python) ──
 *   • per-SPACE (confluence_sync_workflow.py:146): a space whose _syncOneSpace throws is caught, the
 *     space_key recorded in `failed_spaces`, and the loop CONTINUES — one broken space cannot abort the
 *     full cycle. ALL exceptions are caught (no auth carve-out).
 *   • per-PAGE (F-40, confluence_sync_workflow.py:192-273): each page_id is appended to `live_page_ids`
 *     BEFORE the per-page try/catch around fetch_body→sanitize→chunk→upsert. This ordering is the F-40
 *     invariant: a transient page failure must NOT get the page's existing chunks soft-deleted by the
 *     downstream reconcile (which soft-deletes any page absent from live_page_ids). On page failure we
 *     bump a local pages_failed counter (observability only; not surfaced in the workflow output, exactly
 *     as the Python keeps `pages_failed` inside the per-space `stats` dict and never returns it) and
 *     continue with the next page.
 *
 * ── DETERMINISTIC CYCLE TIMESTAMP ──
 * The Python pins `cycle_started_at = workflow.now()` (recorded in event history, deterministic on
 * replay) and threads it as `last_modified_at` into sanitize + upsert. The TS-Temporal SDK in this repo
 * (@temporalio/workflow 1.11) exposes no `workflow.now()` / `currentTimeMs` export; the sanctioned
 * sandbox-safe, replay-deterministic time seam — already used by review_pull_request.workflow.ts for the
 * same `workflow.now()` problem — is `workflowInfo().startTime.toISOString()` (the workflow-start instant
 * the SDK records in history). `.toISOString()` yields a tz-aware `Z`-suffixed RFC3339 string, satisfying
 * the contracts' `last_modified_at: datetime({ offset: true })` (tz-aware-only) constraint. A raw
 * wall-clock read would trip the clock/random gate (workflow source is NOT exempt). See the
 * DIVERGENCE note below: `startTime` is a single workflow-start instant (constant across all spaces),
 * whereas the Python `workflow.now()` is re-read per space; for last_modified_at this is the correct
 * deterministic analogue and the per-space timestamp drift in the Python was incidental.
 *
 * ── REGISTERED-NAME / COMBINED-POD DECISION (matching reconcile.workflow.ts) ──
 * The EXPORTED FUNCTION NAME is the registered Temporal workflow TYPE string — camelCase
 * `confluenceIngestWorkflow` (NOT the Python PascalCase class name; that PascalCase string is preserved
 * as the `CONFLUENCE_SYNC_WORKFLOW_TYPE` const the Stage-8 schedule action uses). The `proxyActivities`
 * METHOD KEYS are the REGISTERED snake_case Temporal activity names the worker exposes.
 *
 * ── SANDBOX SAFETY (ADR-0065 / ADR-0066) ──
 * Bundled into the Temporal V8-isolate workflow sandbox. Imports ONLY `@temporalio/workflow` (the
 * sandbox-safe surface) + TYPE-ONLY contract shapes (erased at emit under verbatimModuleSyntax — no
 * runtime edge to the crypto-importing contracts). No clock / random / uuid / crypto / DB / network /
 * node:* imports. The schedule CONSTANTS are exported as plain string / number values so the Stage-8 boot
 * file can build the Temporal Schedule WITHOUT this sandbox module importing the Temporal client package.
 */

import { proxyActivities, workflowInfo } from "@temporalio/workflow";

import type {
  ChunkAndEmbedInputV1,
  ChunkAndEmbedOutputV1,
  FetchPageBodyInputV1,
  FetchPageBodyOutputV1,
  FetchSpacePagesInputV1,
  FetchSpacePagesOutputV1,
  ListActiveSpacesInputV1,
  ListActiveSpacesOutputV1,
  ReconcileDeletionsInputV1,
  ReconcileDeletionsOutputV1,
  RefreshConfluenceInputV1,
  RefreshConfluenceOutputV1,
  SanitizePageInputV1,
  SanitizePageOutputV1,
  UpsertChunksInputV1,
  UpsertChunksOutputV1,
} from "#contracts/confluence_sync.v1.js";

// ── Schedule constants (Stage-8 boot file imports these; NO Temporal-client edge here) ──
//
// F-39 (confluence_sync_workflow.py:65-79): Confluence sync is BACKGROUND work (6h cadence, fan-out per
// space × per page × 4 activities) and runs on the dedicated "confluence-sync" task queue — NOT the
// review hot queue (CLAUDE.md Invariant 1: protect the core loop). The worker that registers
// confluenceIngestWorkflow MUST subscribe to "confluence-sync" at startup (Stage-8 wiring concern).
export const CONFLUENCE_SYNC_TASK_QUEUE = "confluence-sync";
export const CONFLUENCE_SYNC_SCHEDULE_ID = "refresh-confluence-corpus";
export const CONFLUENCE_SYNC_WORKFLOW_TYPE = "ConfluenceIngestWorkflow";
/** Schedule fires every 6 hours (Python: ScheduleIntervalSpec(every=timedelta(hours=6))). Seconds. */
export const CONFLUENCE_SYNC_INTERVAL_SECONDS = 6 * 60 * 60;

// ── Retry curves (1:1 transcription of the Python RetryPolicy objects) ──
//
// _PAGE_RETRY (confluence_sync_workflow.py:87-91): conservative for the per-page activities —
// initial 10s, max 2min, 3 attempts. Covers transient rate-limits without a stuck page blocking the
// whole space for minutes.
const _PAGE_RETRY = {
  initialInterval: "10 seconds",
  maximumInterval: "2 minutes",
  maximumAttempts: 3,
} as const;

// _LIST_RETRY (confluence_sync_workflow.py:96-100): slightly more generous for the listing activities
// (pagination can be slow on large spaces) — initial 15s, max 3min, 3 attempts.
const _LIST_RETRY = {
  initialInterval: "15 seconds",
  maximumInterval: "3 minutes",
  maximumAttempts: 3,
} as const;

// ── Activity proxies (METHOD KEY = REGISTERED snake_case Temporal activity name) ──
//
// Per-activity start_to_close timeouts transcribed verbatim from the Python execute_activity calls:
//   list_active_confluence_spaces_activity → 30s  (_LIST_RETRY)
//   fetch_space_pages_activity             → 5min (_LIST_RETRY)
//   fetch_page_body_activity               → 30s  (_PAGE_RETRY)
//   sanitize_page_activity                 → 30s  (_PAGE_RETRY)
//   chunk_and_embed_activity               → 3min (_PAGE_RETRY)
//   upsert_chunks_activity                 → 30s  (_PAGE_RETRY)
//   reconcile_deletions_activity           → 30s  (_PAGE_RETRY)

const { list_active_confluence_spaces_activity } = proxyActivities<{
  list_active_confluence_spaces_activity(
    input: ListActiveSpacesInputV1,
  ): Promise<ListActiveSpacesOutputV1>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: _LIST_RETRY,
});

const { fetch_space_pages_activity } = proxyActivities<{
  fetch_space_pages_activity(input: FetchSpacePagesInputV1): Promise<FetchSpacePagesOutputV1>;
}>({
  startToCloseTimeout: "5 minutes",
  retry: _LIST_RETRY,
});

const { fetch_page_body_activity } = proxyActivities<{
  fetch_page_body_activity(input: FetchPageBodyInputV1): Promise<FetchPageBodyOutputV1>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: _PAGE_RETRY,
});

const { sanitize_page_activity } = proxyActivities<{
  sanitize_page_activity(input: SanitizePageInputV1): Promise<SanitizePageOutputV1>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: _PAGE_RETRY,
});

const { chunk_and_embed_activity } = proxyActivities<{
  chunk_and_embed_activity(input: ChunkAndEmbedInputV1): Promise<ChunkAndEmbedOutputV1>;
}>({
  startToCloseTimeout: "3 minutes",
  retry: _PAGE_RETRY,
});

const { upsert_chunks_activity } = proxyActivities<{
  upsert_chunks_activity(input: UpsertChunksInputV1): Promise<UpsertChunksOutputV1>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: _PAGE_RETRY,
});

const { reconcile_deletions_activity } = proxyActivities<{
  reconcile_deletions_activity(
    input: ReconcileDeletionsInputV1,
  ): Promise<ReconcileDeletionsOutputV1>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: _PAGE_RETRY,
});

/** Per-space accumulator (1:1 with the Python `stats` dict, including the F-40 `pages_failed` counter
 *  which is observability-only and never surfaced in the workflow output). */
type SpaceStats = {
  pages_processed: number;
  pages_failed: number;
  chunks_upserted: number;
  chunks_rejected_no_approval: number;
  chunks_rejected_default_cap: number;
  chunks_quarantined: number;
  pages_soft_deleted: number;
};

/**
 * `confluenceIngestWorkflow` workflow body. 1:1 with ConfluenceIngestWorkflow.run.
 *
 * The `input` arg is unused in the body (Python: `# noqa: ARG002`) — RefreshConfluenceInputV1 carries
 * no tunables; the workflow enumerates all active spaces itself.
 */
export async function confluenceIngestWorkflow(
  input: RefreshConfluenceInputV1,
): Promise<RefreshConfluenceOutputV1> {
  // The input carries no tunables (Python: `# noqa: ARG002`); the workflow enumerates all active spaces
  // itself. Discarded explicitly so the registered-workflow signature stays faithful to the dispatched
  // RefreshConfluenceInputV1 without an unused-param lint violation.
  void input;

  // Step 1: list active spaces. (Python comment re result_type is a Temporal-Python converter concern;
  // the TS proxy carries the return type via its callable annotation, so no analogue is needed.)
  const spacesOut = await list_active_confluence_spaces_activity({ schema_version: 1 });

  let pagesProcessed = 0;
  let chunksUpserted = 0;
  let chunksRejectedNoApproval = 0;
  let chunksRejectedDefaultCap = 0;
  let chunksQuarantined = 0;
  let pagesSoftDeleted = 0;
  const failedSpaces: Array<string> = [];

  for (const spaceRef of spacesOut.spaces) {
    try {
      const stats = await syncOneSpace(spaceRef.space_key);
      pagesProcessed += stats.pages_processed;
      chunksUpserted += stats.chunks_upserted;
      chunksRejectedNoApproval += stats.chunks_rejected_no_approval;
      chunksRejectedDefaultCap += stats.chunks_rejected_default_cap;
      chunksQuarantined += stats.chunks_quarantined;
      pagesSoftDeleted += stats.pages_soft_deleted;
    } catch {
      // Per-SPACE failure is non-fatal (confluence_sync_workflow.py:146-153): record the space_key +
      // continue so other spaces still get processed this cycle. ALL exceptions caught (no auth carve-out).
      failedSpaces.push(spaceRef.space_key);
    }
  }

  return {
    schema_version: 1,
    pages_processed: pagesProcessed,
    chunks_upserted: chunksUpserted,
    chunks_rejected_no_approval: chunksRejectedNoApproval,
    chunks_rejected_default_cap: chunksRejectedDefaultCap,
    chunks_quarantined: chunksQuarantined,
    pages_soft_deleted: pagesSoftDeleted,
    failed_spaces: failedSpaces,
  };
}

/**
 * Sync one Confluence space end-to-end; return per-space stats. 1:1 with `_sync_one_space`.
 */
async function syncOneSpace(spaceKey: string): Promise<SpaceStats> {
  // Fetch all page references in the space.
  const pagesOut = await fetch_space_pages_activity({
    schema_version: 1,
    space_key: spaceKey,
  });

  // Deterministic cycle timestamp — the SDK workflow-start instant, recorded in event history so replays
  // return the same value (the sandbox-safe analogue of the Python `workflow.now()`; see the module
  // DIVERGENCE note). tz-aware `Z`-suffixed RFC3339, satisfying last_modified_at's offset:true constraint.
  const cycleStartedAt = workflowInfo().startTime.toISOString();

  const stats: SpaceStats = {
    pages_processed: 0,
    pages_failed: 0, // F-40: per-page failure counter (observability only; never returned).
    chunks_upserted: 0,
    chunks_rejected_no_approval: 0,
    chunks_rejected_default_cap: 0,
    chunks_quarantined: 0,
    pages_soft_deleted: 0,
  };
  const livePageIds: Array<string> = [];

  for (const pageRef of pagesOut.pages) {
    // F-40 (confluence_sync_workflow.py:192-205): the page_id is appended to livePageIds BEFORE the
    // per-page try so a transient page failure does NOT get its chunks soft-deleted by the downstream
    // reconcile. If a page keeps failing across many cycles, an operator follow-up signal is needed —
    // silently flushing chunks would hide that.
    livePageIds.push(pageRef.page_id);
    try {
      const bodyOut = await fetch_page_body_activity({
        schema_version: 1,
        page_id: pageRef.page_id,
        space_key: spaceKey,
      });

      const sanitizedOut = await sanitize_page_activity({
        schema_version: 1,
        page: bodyOut.page,
        last_modified_at: cycleStartedAt,
      });

      const chunkedOut = await chunk_and_embed_activity({
        schema_version: 1,
        sanitized: sanitizedOut.sanitized,
      });

      const upsertOut = await upsert_chunks_activity({
        schema_version: 1,
        space_key: spaceKey,
        page_id: bodyOut.page.page_id,
        page_title: bodyOut.page.title,
        // F-37: pass page_version from the fetched body.
        page_version: bodyOut.page.version,
        page_status: bodyOut.page.status,
        last_modified_at: cycleStartedAt,
        raw_labels: bodyOut.page.labels,
        injection_flags: sanitizedOut.sanitized.injection_flags,
        chunks: chunkedOut.chunks,
      });

      // Page survived all 4 activities.
      stats.pages_processed += 1;
      stats.chunks_upserted += upsertOut.upserted;
      stats.chunks_rejected_no_approval += upsertOut.rejected_no_approval;
      stats.chunks_rejected_default_cap += upsertOut.rejected_default_cap;
      if (upsertOut.quarantined) {
        stats.chunks_quarantined += 1;
      }
    } catch {
      // Per-PAGE fail-open (F-40): bump the failure counter + continue with the next page. The page_id
      // is already in livePageIds (appended before the try) so reconcile won't soft-delete its chunks.
      stats.pages_failed += 1;
    }
  }

  // Reconcile deletions: soft-delete chunks for pages absent this cycle.
  const reconcileOut = await reconcile_deletions_activity({
    schema_version: 1,
    space_key: spaceKey,
    live_page_ids: livePageIds,
  });
  stats.pages_soft_deleted += reconcileOut.soft_deleted;
  return stats;
}
