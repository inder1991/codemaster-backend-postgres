/**
 * Confluence pages write — 1:1 with codemaster/api/admin/page_approvals.py (create_approval +
 * revoke_approval helpers).
 *
 * Two write operations:
 *   1. createPageApproval — idempotent upsert via PostgresConfluencePageApprovalsRepo. Returns the
 *      freshly-minted approval_id.
 *   2. revokePageApproval — soft-delete via the repo; on success optionally dispatch the page-resync
 *      workflow. Returns true iff a row was revoked (false → the route maps to 404, mirroring the Python
 *      ApprovalNotFoundError → 404).
 *
 * Both derive the actor's email from the injected UserEmailResolverPort (audit P0-1); the request body is
 * forbidden to carry approver_email / revoked_by (the contract is .strict() / extra="forbid"), so the
 * session-derived email is the only source.
 */

import { type Kysely } from "kysely";

import type { CreatePageApprovalRequestV1 } from "#contracts/page_approval.v1.js";

import { PostgresConfluencePageApprovalsRepo } from "#backend/domain/repos/confluence_page_approvals_repo.js";
import type { UserEmailResolverPort } from "#backend/api/admin/platform_credentials_probe.js";

/**
 * Optional Temporal dispatch seam for TriggerPageResyncWorkflow (1:1 with the Python
 * PageResyncDispatcherPort). Production threads a concrete dispatcher; absent → the resync is skipped (the
 * LEFT JOIN approval-drift safeguard already excludes the chunks from retrieval immediately).
 */
export type PageResyncDispatcherPort = {
  enqueueResync(args: {
    spaceKey: string;
    pageId: string;
    triggeredByUserId: string;
  }): Promise<void>;
};

/** Optional structured-warning sink (mirrors the Python `_LOG.warning("trigger_page_resync_enqueue_failed")`). */
export type ResyncWarn = (e: {
  spaceKey: string;
  pageId: string;
  actorUserId: string;
  error: string;
}) => void;

/**
 * Create or update a page approval (1:1 with the Python create_approval). Idempotent: the repo's upsert
 * revokes any current active approval (revoked_by = the NEW actor, F-28) and inserts the new one under a
 * per-page advisory lock (P0-3).
 *
 * The actor's email is derived from the authenticated session via the injected resolver (audit P0-1).
 * Returns the new approval_id. The route is responsible for the URL/body space_key + page_id cross-checks
 * (F-72) before calling this.
 */
export async function createPageApproval(
  db: Kysely<unknown>,
  request: CreatePageApprovalRequestV1,
  opts: {
    actorUserId: string;
    emailResolver: UserEmailResolverPort;
  },
): Promise<string> {
  const actorEmail = await opts.emailResolver.resolveEmail(opts.actorUserId);
  const repo = new PostgresConfluencePageApprovalsRepo({ db });
  return await repo.upsertApproval(request, { actorEmail });
}

/**
 * Revoke the active approval for (space_key, page_id) (1:1 with the Python revoke_approval).
 *
 * Returns true iff a row was revoked; false if no active approval existed (the route maps to 404,
 * mirroring the Python ApprovalNotFoundError → 404).
 *
 * On success, optionally dispatch TriggerPageResyncWorkflow via the injected dispatcher so the page's
 * default-tagged chunks are flushed within minutes (eventual-consistency cleanup). A dispatch failure is
 * surfaced via the optional onWarn sink but does NOT roll back the revocation — Sub-spec B's LEFT JOIN
 * excludes the chunks from retrieval immediately, so the resync is cleanup, not a correctness requirement.
 *
 * revoked_by is derived from the authenticated session via the resolver (audit P0-1).
 */
export async function revokePageApproval(
  db: Kysely<unknown>,
  args: {
    spaceKey: string;
    pageId: string;
    actorUserId: string;
    emailResolver: UserEmailResolverPort;
    resyncDispatcher?: PageResyncDispatcherPort;
    onWarn?: ResyncWarn;
  },
): Promise<boolean> {
  const revokedBy = await args.emailResolver.resolveEmail(args.actorUserId);
  const repo = new PostgresConfluencePageApprovalsRepo({ db });
  const ok = await repo.revoke({
    spaceKey: args.spaceKey,
    pageId: args.pageId,
    revokedBy,
  });

  if (ok && args.resyncDispatcher) {
    try {
      await args.resyncDispatcher.enqueueResync({
        spaceKey: args.spaceKey,
        pageId: args.pageId,
        triggeredByUserId: args.actorUserId,
      });
    } catch (err) {
      // Log but do not throw — revocation succeeded at the DB layer and the resync is
      // eventual-consistency cleanup, not a correctness requirement.
      args.onWarn?.({
        spaceKey: args.spaceKey,
        pageId: args.pageId,
        actorUserId: args.actorUserId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return ok;
}
