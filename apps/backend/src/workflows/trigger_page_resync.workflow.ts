/**
 * `triggerPageResyncWorkflow` — port of the frozen Python workflow body `TriggerPageResyncWorkflow.run`
 * (vendor/codemaster-py/codemaster/workflows/trigger_page_resync_workflow.py).
 *
 * Single-page re-sync triggered from the admin UI on approval revocation. The DELETE-approval endpoint
 * enqueues this workflow so default-tagged chunks of a just-revoked page are flushed within minutes
 * instead of waiting for the next 6h confluenceIngestWorkflow tick (spec §3.7 approval-drift bound).
 *
 * Chains the SAME 4 per-page activities the full sync runs across all pages — fetch_page_body →
 * sanitize_page → chunk_and_embed → upsert_chunks — but for ONE (space_key, page_id) only. Each step gets
 * its own _PAGE_RETRY curve + timeout (1:1 with confluenceIngestWorkflow's per-page activities) so a stuck
 * page doesn't block the next revocation.
 *
 * ── resync_complete CONTRACT + DIVERGENCE FROM THE FROZEN PYTHON BODY ──
 * TriggerPageResyncOutputV1.resync_complete=false signals a transient downstream error (Confluence
 * rate-limited, embed service down) so the caller retries / escalates (per the contract docstring +
 * spec). The TASK SPEC directs: "Return resync_complete=true on success; the Python catches transient
 * failure → resync_complete=false (mirror that)." The CURRENT frozen Python body
 * (trigger_page_resync_workflow.py) does NOT wrap the 4 activities in a try/except — it always returns
 * resync_complete=True and lets a transient failure propagate as a workflow error. This port follows the
 * TASK SPEC + the contract's stated semantics: it wraps the chain in a try/catch and returns
 * resync_complete=false on a transient failure (after the _PAGE_RETRY budget is exhausted). See the
 * DIVERGENCE note in the final report.
 *
 * ── DETERMINISTIC CYCLE TIMESTAMP ──
 * The Python binds `cycle_started_at = workflow.now()` once (same role as confluenceIngestWorkflow) and
 * threads it as last_modified_at into sanitize + upsert. As in confluence_ingest.workflow.ts, the
 * sandbox-safe, replay-deterministic seam is `workflowInfo().startTime.toISOString()` (tz-aware
 * `Z`-suffixed RFC3339, satisfying last_modified_at's offset:true constraint) — a raw wall-clock read
 * would trip the clock/random gate.
 *
 * ── REGISTERED-NAME DECISION (combined-pod worker) ──
 * EXPORTED FUNCTION NAME = registered Temporal workflow TYPE string `triggerPageResyncWorkflow` (camelCase);
 * the Python PascalCase class name is preserved as `TRIGGER_PAGE_RESYNC_WORKFLOW_TYPE`. The
 * `proxyActivities` METHOD KEYS are the REGISTERED snake_case Temporal activity names.
 *
 * ── SANDBOX SAFETY (ADR-0065 / ADR-0066) ──
 * Bundled into the V8-isolate workflow sandbox. Imports ONLY `@temporalio/workflow` + TYPE-ONLY contract
 * shapes (erased at emit). No clock / random / uuid / crypto / DB / network / node:* work.
 */

import { proxyActivities, workflowInfo } from "@temporalio/workflow";

import type {
  ChunkAndEmbedInputV1,
  ChunkAndEmbedOutputV1,
  FetchPageBodyInputV1,
  FetchPageBodyOutputV1,
  SanitizePageInputV1,
  SanitizePageOutputV1,
  UpsertChunksInputV1,
  UpsertChunksOutputV1,
} from "#contracts/confluence_sync.v1.js";
import type {
  TriggerPageResyncInputV1,
  TriggerPageResyncOutputV1,
} from "#contracts/trigger_page_resync.v1.js";

export const TRIGGER_PAGE_RESYNC_TASK_QUEUE = "confluence-sync";
export const TRIGGER_PAGE_RESYNC_WORKFLOW_TYPE = "TriggerPageResyncWorkflow";

// Same retry shape as confluenceIngestWorkflow's _PAGE_RETRY (trigger_page_resync_workflow.py:51-55) —
// a stuck page shouldn't block the workflow for more than a few minutes.
const _PAGE_RETRY = {
  initialInterval: "10 seconds",
  maximumInterval: "2 minutes",
  maximumAttempts: 3,
} as const;

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

/**
 * `triggerPageResyncWorkflow` workflow body. 1:1 with TriggerPageResyncWorkflow.run (with the
 * resync_complete fail-soft per the task spec + contract — see the DIVERGENCE note in the module header).
 */
export async function triggerPageResyncWorkflow(
  input: TriggerPageResyncInputV1,
): Promise<TriggerPageResyncOutputV1> {
  // Bind cycle time once; same role as confluenceIngestWorkflow's cycleStartedAt — the deterministic
  // last_modified_at for the resync write so the downstream stale derivation has a consistent reference.
  const cycleStartedAt = workflowInfo().startTime.toISOString();

  try {
    // 1. Fetch the page body from Confluence.
    const bodyOut = await fetch_page_body_activity({
      schema_version: 1,
      page_id: input.page_id,
      space_key: input.space_key,
    });

    // 2. Sanitize HTML + detect injection patterns.
    const sanitizedOut = await sanitize_page_activity({
      schema_version: 1,
      page: bodyOut.page,
      last_modified_at: cycleStartedAt,
    });

    // 3. Chunk + embed via Bedrock (idempotency-cached).
    const chunkedOut = await chunk_and_embed_activity({
      schema_version: 1,
      sanitized: sanitizedOut.sanitized,
    });

    // 4. Upsert chunks. The page-approval LEFT JOIN inside the upsert activity sees the now-revoked
    // approval and either rejects the default-tagged chunks (no active approval) or persists them if the
    // operator re-approved between this resync's start + here.
    await upsert_chunks_activity({
      schema_version: 1,
      space_key: input.space_key,
      page_id: bodyOut.page.page_id,
      page_title: bodyOut.page.title,
      // DIVERGENCE (faithful + more-correct): the frozen Python resync OMITS page_version, relying on the
      // Pydantic default=1. The Zod-inferred UpsertChunksInputV1 input type requires page_version (the
      // `.default(1)` is an OUTPUT default, not an input-optional), so it must be supplied. We thread the
      // REAL fetched version (`bodyOut.page.version`) — exactly what the ingest path does via the F-37 fix
      // — which is strictly more correct than defaulting to 1. See the final-report DIVERGENCE note.
      page_version: bodyOut.page.version,
      page_status: bodyOut.page.status,
      last_modified_at: cycleStartedAt,
      raw_labels: bodyOut.page.labels,
      injection_flags: sanitizedOut.sanitized.injection_flags,
      chunks: chunkedOut.chunks,
    });

    return {
      schema_version: 1,
      space_key: input.space_key,
      page_id: input.page_id,
      resync_complete: true,
    };
  } catch {
    // Transient downstream failure after the _PAGE_RETRY budget is exhausted: fail-soft per the contract
    // (resync_complete=false signals the caller to retry / escalate). See the module DIVERGENCE note.
    return {
      schema_version: 1,
      space_key: input.space_key,
      page_id: input.page_id,
      resync_complete: false,
    };
  }
}
