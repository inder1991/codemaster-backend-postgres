// Phase 4c W4c.2 review blocker #5 — the CONCRETE PageResyncDispatcherPort.
//
// Pre-fix the DELETE-approval route's dispatcher seam (confluence_pages_write.ts::
// PageResyncDispatcherPort) was OPTIONAL and server.ts passed none — 1:1 with the frozen Python,
// whose dispatcher was a recording stub — so approval revocation silently SKIPPED the resync and
// the revoked page's default-tagged chunks waited for the next 6h confluence_ingest tick instead of
// the spec §3.7 minutes-bound flush. (Retrieval was never wrong meanwhile: the LEFT JOIN
// approval-drift safeguard excludes the chunks immediately; the resync is the on-disk cleanup.)
//
// This implementation is an OUTBOX PRODUCER, not a direct Temporal/job dispatch: it appends the
// SAME `temporal_workflow_start` envelope shape every other non-review producer stamps
// (_push_emitters.ts / _repair_dispatcher.ts — TemporalWorkflowStartPayloadV1 with the single typed
// workflow input as args[0]), so the row rides the existing drain path on EITHER side of the
// Phase-4 cutover:
//   * flag OFF — the temporal_workflow_start sink starts the registered `triggerPageResyncWorkflow`
//     Temporal workflow (the camelCase EXPORTED function name, workflow_job_map.ts's canonical
//     identity — NOT the vestigial Python-parity PascalCase TRIGGER_PAGE_RESYNC_WORKFLOW_TYPE);
//   * flag ON — BackgroundJobsTemporalPort translates the type through WORKFLOW_TYPE_TO_JOB_TYPE
//     onto the registered `trigger_page_resync` background-job handler.
//
// ## Tenant identity: the platform sentinel installation
// Confluence corpus work is PLATFORM-scoped (no per-tenant installation exists for it), but
// `ck_outbox_installation_id_required` forbids NULL installation_id on the temporal_workflow_start
// sink and the column FKs core.installations. The seeded `__platform_sentinel__` row
// (PLATFORM_SCOPE_AUDIT_INSTALLATION_ID, migration 0002) is exactly the identity for this:
// platform-scope work that structurally requires an installation_id.
//
// ## Failure posture
// A throw here (DB down, contract drift) is CAUGHT by revokePageApproval: the revocation itself
// stands (it already committed) and the failure surfaces through the route's onWarn log — the
// resync is eventual-consistency cleanup, never a correctness gate on the revocation.

import { type Kysely } from "kysely";

import { TriggerPageResyncInputV1 } from "#contracts/trigger_page_resync.v1.js";

import {
  OUTBOX_PAYLOAD_SCHEMA_VERSION,
  PostgresOutboxRepo,
} from "#backend/domain/repos/outbox_repo.js";
import { PLATFORM_SCOPE_AUDIT_INSTALLATION_ID } from "#backend/infra/sentinels.js";
import { resolveReviewTaskQueue } from "#backend/worker/temporal_config.js";

import type { PageResyncDispatcherPort } from "./confluence_pages_write.js";

/** The registered TS workflow TYPE string (the exported function name in
 *  workflows/trigger_page_resync.workflow.ts) — the byte-exact WORKFLOW_TYPE_TO_JOB_TYPE key. */
export const TRIGGER_PAGE_RESYNC_DISPATCH_WORKFLOW_TYPE = "triggerPageResyncWorkflow";

/**
 * Outbox-backed {@link PageResyncDispatcherPort}: on approval revocation, append ONE
 * `temporal_workflow_start` row dispatching the single-page resync. The workflow_id is
 * deterministic per (space, page) — `trigger-page-resync/<space>/<page>` — so rapid
 * revoke/re-approve/revoke cycles coalesce while a dispatch is in flight
 * (id_conflict_policy=USE_EXISTING on the Temporal side; dedup_key SKIP-while-active on the
 * platform side), exactly the deterministic-workflow-id idiom the push emitters use.
 */
export class OutboxPageResyncDispatcher implements PageResyncDispatcherPort {
  readonly #db: Kysely<unknown>;

  /** `db` is the API process's shared-pool Kysely (server.ts's coreDb — the ADR-0062 invariant). */
  public constructor(o: { db: Kysely<unknown> }) {
    this.#db = o.db;
  }

  public async enqueueResync(args: {
    spaceKey: string;
    pageId: string;
    triggeredByUserId: string;
  }): Promise<void> {
    // Parse at the producer boundary so a drifted caller fails HERE (surfaced via the route's
    // onWarn) instead of dead-lettering the outbox row three layers downstream. args[0] is the
    // workflow's single typed input — the exact contract the trigger_page_resync handler and the
    // Temporal workflow body both re-parse.
    const input = TriggerPageResyncInputV1.parse({
      schema_version: 1,
      space_key: args.spaceKey,
      page_id: args.pageId,
      triggered_by_user_id: args.triggeredByUserId,
    });

    const payload = {
      workflow_type: TRIGGER_PAGE_RESYNC_DISPATCH_WORKFLOW_TYPE,
      workflow_id: `trigger-page-resync/${args.spaceKey}/${args.pageId}`,
      task_queue: resolveReviewTaskQueue(),
      args: [input],
      id_reuse_policy: "ALLOW_DUPLICATE",
      id_conflict_policy: "USE_EXISTING",
    };

    await new PostgresOutboxRepo().appendNonReviewDispatch({
      db: this.#db,
      workflowType: TRIGGER_PAGE_RESYNC_DISPATCH_WORKFLOW_TYPE,
      payload,
      schemaVersion: OUTBOX_PAYLOAD_SCHEMA_VERSION,
      // Platform-scope sentinel (module doc): Confluence work is installation-less, the sink's
      // CHECK forbids NULL, and the seeded __platform_sentinel__ row satisfies the FK.
      installationId: PLATFORM_SCOPE_AUDIT_INSTALLATION_ID,
    });
  }
}
