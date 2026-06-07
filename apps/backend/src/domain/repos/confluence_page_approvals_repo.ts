/**
 * PostgresConfluencePageApprovalsRepo — 1:1 TypeScript port of the frozen Python data-layer repo
 * `vendor/codemaster-py/codemaster/domain/repos/confluence_page_approvals_repo.py` (Sub-spec 0 Task 4).
 *
 * Pure data-access helpers over `core.confluence_page_approvals`. Sub-spec C's admin API calls these
 * from POST/DELETE handlers; Sub-spec A's upsert_chunks activity calls `getActiveApproval()` at
 * default-tag write time.
 *
 * Methods (1:1 with the Python module):
 *   - upsertApproval    — idempotent upsert. Takes a per-page advisory xact-lock, revokes any current
 *                         active approval (revoked_by = actor — F-28), then inserts the new row. Returns
 *                         the new approval_id.
 *   - getActiveApproval — the single active row (revoked_at IS NULL) for (space_key, page_id), or null.
 *   - listForSpace      — active rows for a space (or all, with includeRevoked), newest-first.
 *   - revoke            — flip revoked_at + revoked_by on the active row; returns whether a row changed.
 *
 * Audit fixes preserved byte-faithfully from the Python source:
 *   P0-1 — `actorEmail` comes from the authenticated session in the handler, NEVER from the request
 *          body (the contract forbids extra keys so the request can't smuggle it in).
 *   P0-3 — `pg_advisory_xact_lock(hashtext(...))` per-page serializes concurrent POSTs cleanly.
 *   F-28 — the implicit-revoke step binds `revoked_by = actor` so the biconditional CHECK (migration
 *          0106/0107: `(revoked_at IS NULL) = (revoked_by IS NULL)`) holds on every write.
 *
 * Tenancy: `core.confluence_page_approvals` is PLATFORM-WIDE (no `installation_id`), so it is NOT in
 * `TENANT_SCOPED_TABLES` and the raw-SQL tenancy gate does not fire on it. The inline `// tenant:exempt`
 * markers mirror the frozen Python source for documentation parity.
 *
 * ADR-0062 (Postgres connection-pool lifecycle): this repo owns NO pool/engine cache. It is handed a
 * `Kysely<unknown>` over the process-wide single pool (via {@link tenantKysely}) by injection.
 */

import { type Kysely, sql, type Transaction } from "kysely";

import { uuid4 } from "#platform/randomness.js";

import {
  ConfluencePageApprovalV1,
  type CreatePageApprovalRequestV1,
} from "#contracts/page_approval.v1.js";

/** Raw `core.confluence_page_approvals` row shape (node-pg returns timestamptz columns as Date). */
type ApprovalRow = {
  approval_id: string;
  space_key: string;
  page_id: string;
  approver_email: string;
  approved_at_utc: Date;
  approval_artifact_url: string;
  scope_justification: string;
  default_scope: string;
  revoked_at: Date | null;
  revoked_by: string | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * Reconstruct a {@link ConfluencePageApprovalV1} from a raw row (1:1 with the Python
 * `ConfluencePageApprovalV1(**dict(row))`). node-pg hands timestamptz columns back as JS `Date`; the
 * Zod contract expects ISO strings, so the timestamp columns are stringified via `toISOString()` (the
 * Python path received `datetime` objects which Pydantic accepted directly — this is the TS analogue).
 */
function rowToApproval(row: ApprovalRow): ConfluencePageApprovalV1 {
  return ConfluencePageApprovalV1.parse({
    approval_id: row.approval_id,
    space_key: row.space_key,
    page_id: row.page_id,
    approver_email: row.approver_email,
    approved_at_utc: row.approved_at_utc.toISOString(),
    approval_artifact_url: row.approval_artifact_url,
    scope_justification: row.scope_justification,
    default_scope: row.default_scope,
    revoked_at: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    revoked_by: row.revoked_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  });
}

/** Async repo over `core.confluence_page_approvals`. */
export class PostgresConfluencePageApprovalsRepo {
  private readonly db: Kysely<unknown>;

  public constructor({ db }: { db: Kysely<unknown> }) {
    this.db = db;
  }

  /**
   * Idempotent upsert (1:1 with the Python `upsert_approval`). Revokes any current active approval, then
   * inserts the new one. Returns the new approval_id.
   *
   * Per-page concurrency: takes a `pg_advisory_xact_lock(hashtext("<space>/<page>"))` so two parallel
   * POSTs for the same page serialize cleanly instead of one hitting a UniqueViolation. The lock,
   * implicit-revoke, and insert run in ONE transaction (the xact-lock auto-releases at COMMIT).
   *
   * `actorEmail` comes from the authenticated session in the admin handler, NEVER from the request body
   * (audit P0-1). The implicit-revoke binds `revoked_by = actor` (F-28) so the biconditional CHECK holds.
   */
  public async upsertApproval(
    request: CreatePageApprovalRequestV1,
    { actorEmail }: { actorEmail: string },
  ): Promise<string> {
    const lockKey = `confluence_page_approvals:${request.space_key}/${request.page_id}`;
    const approvalId = uuid4();

    await this.db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;

      // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
      await sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`.execute(tx);

      // F-28 (P1): bind the actor's email into the implicit-revoke step too. Pre-F-28 this UPDATE set
      // revoked_at = now() but NOT revoked_by — silently revoking the prior operator's row with
      // revoked_by = NULL, breaking the P0-1 audit-trail promise. Pairs with the F-29 biconditional
      // CHECK migration 0107 which enforces the invariant structurally.
      // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
      await sql`
        UPDATE core.confluence_page_approvals
           SET revoked_at = now(), revoked_by = ${actorEmail}
         WHERE space_key = ${request.space_key} AND page_id = ${request.page_id} AND revoked_at IS NULL
      `.execute(tx);

      // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
      await sql`
        INSERT INTO core.confluence_page_approvals
          (approval_id, space_key, page_id, approver_email, approved_at_utc,
           approval_artifact_url, scope_justification, default_scope)
        VALUES (${approvalId}, ${request.space_key}, ${request.page_id}, ${actorEmail}, ${request.approved_at_utc},
                ${request.approval_artifact_url}, ${request.scope_justification}, ${request.default_scope})
      `.execute(tx);
    });

    return approvalId;
  }

  /**
   * The single active approval (revoked_at IS NULL) for (space_key, page_id), or null (1:1 with the
   * Python `get_active_approval`).
   */
  public async getActiveApproval(args: {
    spaceKey: string;
    pageId: string;
  }): Promise<ConfluencePageApprovalV1 | null> {
    // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
    const result = await sql<ApprovalRow>`
      SELECT * FROM core.confluence_page_approvals
       WHERE space_key = ${args.spaceKey} AND page_id = ${args.pageId} AND revoked_at IS NULL
    `.execute(this.db);
    const row = result.rows[0];
    return row === undefined ? null : rowToApproval(row);
  }

  /**
   * Active approvals for a space (or all, with `includeRevoked`), ordered newest-first by created_at
   * (1:1 with the Python `list_for_space`).
   */
  public async listForSpace(args: {
    spaceKey: string;
    includeRevoked?: boolean;
  }): Promise<ReadonlyArray<ConfluencePageApprovalV1>> {
    const includeRevoked = args.includeRevoked ?? false;
    // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
    const result = includeRevoked
      ? await sql<ApprovalRow>`
          SELECT * FROM core.confluence_page_approvals
           WHERE space_key = ${args.spaceKey} ORDER BY created_at DESC
        `.execute(this.db)
      : // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
        await sql<ApprovalRow>`
          SELECT * FROM core.confluence_page_approvals
           WHERE space_key = ${args.spaceKey} AND revoked_at IS NULL ORDER BY created_at DESC
        `.execute(this.db);
    return result.rows.map(rowToApproval);
  }

  /**
   * Revoke the active approval for (space_key, page_id): set revoked_at = now() + revoked_by (1:1 with
   * the Python `revoke`). Returns true iff a row changed (an already-revoked / absent page → false).
   */
  public async revoke(args: {
    spaceKey: string;
    pageId: string;
    revokedBy: string;
  }): Promise<boolean> {
    // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
    const result = await sql`
      UPDATE core.confluence_page_approvals
         SET revoked_at = now(), revoked_by = ${args.revokedBy}
       WHERE space_key = ${args.spaceKey} AND page_id = ${args.pageId} AND revoked_at IS NULL
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0n) > 0;
  }
}
