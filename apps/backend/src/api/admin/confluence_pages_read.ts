/**
 * Confluence pages read — three read operations:
 *   1. getSpaceKeyForIntegration — resolve integration_id → space_key (config_json ->> 'space_key')
 *      for the route handlers. Raises IntegrationNotFoundError on a miss.
 *   2. listPagesForIntegration — paginated list of pages per space, with their current approval status
 *      via DISTINCT ON (most-recent-version chunk) + LEFT JOIN confluence_page_approvals.
 *   3. listQuarantinedChunksForIntegration — paginated list of quarantined chunks per space.
 *
 * These are bespoke paginated read queries that have NO equivalent on PostgresConfluencePageApprovalsRepo
 * (getActiveApproval / listForSpace) or PostgresConfluenceChunksRepo (upsert / reconcile) — those repos
 * carry the write/lookup paths; the per-space dedup-page-list + quarantine-list reads live here.
 *
 * Tenancy: the confluence + integrations tables are PLATFORM-WIDE (no installation_id; migration 0063
 * dropped it), so they are NOT in TENANT_SCOPED_TABLES — the raw-SQL tenancy gate does not fire.
 */

import { type Kysely, sql } from "kysely";

import type {
  PageWithApprovalV1,
  PagesListPageV1,
  QuarantinedChunkV1,
  QuarantinedChunksPageV1,
} from "#contracts/admin.v1.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const QUARANTINE_PREVIEW_CHARS = 280;

/** Raised when integration_id doesn't resolve to an enabled confluence_space row (→ 404 at the route). */
export class IntegrationNotFoundError extends Error {
  public constructor(integrationId: string) {
    super(`integration not found: ${integrationId}`);
    this.name = "IntegrationNotFoundError";
  }
}

/** A timestamptz column is parsed to a JS Date by node-pg; render it as an ISO string for the contract. */
function iso(d: Date): string {
  return new Date(d).toISOString();
}

/** Clamp a page-size request into [1, MAX_PAGE_SIZE] with the default fallback. */
function clampPageSize(pageSize: number | undefined): number {
  return Math.max(1, Math.min(pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
}

/**
 * Resolve integration_id → space_key from core.integrations.config_json. Raises
 * IntegrationNotFoundError if the integration_id doesn't match an enabled confluence_space row.
 */
export async function getSpaceKeyForIntegration(
  db: Kysely<unknown>,
  integrationId: string,
): Promise<string> {
  // tenant:exempt reason=admin-cross-tenant-integration-lookup follow_up=PERMANENT-EXEMPTION-confluence-corpus
  const result = await sql<{ space_key: string }>`
    SELECT config_json ->> 'space_key' AS space_key
      FROM core.integrations
     WHERE integration_id = ${integrationId}
       AND kind = 'confluence_space'
       AND enabled = true
  `.execute(db);

  const row = result.rows[0];
  if (row === undefined) {
    throw new IntegrationNotFoundError(integrationId);
  }
  return row.space_key;
}

/**
 * Paginated list of pages for a space (resolved from integration_id), with their approval status (1:1
 * with the Python list_pages). Pages are ordered by last_modified_at DESC, newest first. The cursor is an
 * opaque offset.
 */
export async function listPagesForIntegration(
  db: Kysely<unknown>,
  integrationId: string,
  opts: { cursor?: string | null; pageSize?: number } = {},
): Promise<PagesListPageV1> {
  const pageSize = clampPageSize(opts.pageSize);
  const offset = opts.cursor ? parseInt(opts.cursor, 10) : 0;

  const spaceKey = await getSpaceKeyForIntegration(db, integrationId);

  // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
  const result = await sql<{
    space_key: string;
    page_id: string;
    page_title: string;
    page_version: number;
    labels: Array<string> | null;
    last_modified_at: Date;
    approver_email: string | null;
    approved_at_utc: Date | null;
    revoked_at: Date | null;
    revoked_by: string | null;
    approval_status: "approved" | "revoked" | "none";
  }>`
    WITH ranked AS (
      SELECT DISTINCT ON (cc.page_id)
        cc.space_key,
        cc.page_id,
        cc.page_title,
        cc.version AS page_version,
        cc.labels,
        cc.last_modified_at,
        cpa.approver_email,
        cpa.approved_at_utc,
        cpa.revoked_at,
        cpa.revoked_by,
        CASE
          WHEN cpa.approval_id IS NULL THEN 'none'
          WHEN cpa.revoked_at IS NULL THEN 'approved'
          ELSE 'revoked'
        END AS approval_status
      FROM core.confluence_chunks cc
      LEFT JOIN core.confluence_page_approvals cpa
        ON cpa.space_key = cc.space_key
       AND cpa.page_id = cc.page_id
       AND cpa.revoked_at IS NULL
      WHERE cc.space_key = ${spaceKey}
        AND cc.deleted_at IS NULL
      ORDER BY cc.page_id, cc.version DESC, cc.last_modified_at DESC
    )
    SELECT *
      FROM ranked
     ORDER BY last_modified_at DESC
     LIMIT ${pageSize} OFFSET ${offset}
  `.execute(db);

  const rows: Array<PageWithApprovalV1> = result.rows.map((r) => ({
    schema_version: 1,
    space_key: r.space_key,
    page_id: r.page_id,
    page_title: r.page_title,
    page_version: r.page_version,
    labels: r.labels ?? [],
    last_modified_at: iso(r.last_modified_at),
    approval_status: r.approval_status,
    approver_email: r.approver_email ?? null,
    approved_at_utc: r.approved_at_utc ? iso(r.approved_at_utc) : null,
    revoked_at: r.revoked_at ? iso(r.revoked_at) : null,
    revoked_by: r.revoked_by ?? null,
  }));

  const nextCursor = rows.length === pageSize ? String(offset + pageSize) : null;

  return {
    schema_version: 1,
    rows,
    next_cursor: nextCursor,
  };
}

/**
 * Paginated list of quarantined chunks for a space (resolved from integration_id). Chunks are ordered
 * by last_modified_at DESC, chunk_id DESC. The text preview is truncated to QUARANTINE_PREVIEW_CHARS
 * (280). The cursor is an opaque offset.
 */
export async function listQuarantinedChunksForIntegration(
  db: Kysely<unknown>,
  integrationId: string,
  opts: { cursor?: string | null; pageSize?: number } = {},
): Promise<QuarantinedChunksPageV1> {
  const pageSize = clampPageSize(opts.pageSize);
  const offset = opts.cursor ? parseInt(opts.cursor, 10) : 0;

  const spaceKey = await getSpaceKeyForIntegration(db, integrationId);

  // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
  const result = await sql<{
    chunk_id: string;
    space_key: string;
    page_id: string;
    page_title: string;
    page_version: number;
    last_modified_at: Date;
    quarantine_reasons: Array<string> | null;
    chunk_text_preview: string;
  }>`
    SELECT
      chunk_id,
      space_key,
      page_id,
      page_title,
      version AS page_version,
      last_modified_at,
      quarantine_reasons,
      SUBSTRING(chunk_text, 1, ${QUARANTINE_PREVIEW_CHARS}) AS chunk_text_preview
    FROM core.confluence_chunks
    WHERE space_key = ${spaceKey}
      AND quarantined = true
      AND deleted_at IS NULL
    ORDER BY last_modified_at DESC, chunk_id DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `.execute(db);

  const rows: Array<QuarantinedChunkV1> = result.rows.map((r) => ({
    schema_version: 1,
    chunk_id: r.chunk_id,
    space_key: r.space_key,
    page_id: r.page_id,
    page_title: r.page_title,
    page_version: r.page_version,
    last_modified_at: iso(r.last_modified_at),
    quarantine_reasons: r.quarantine_reasons ?? [],
    chunk_text_preview: r.chunk_text_preview,
  }));

  const nextCursor = rows.length === pageSize ? String(offset + pageSize) : null;

  return {
    schema_version: 1,
    rows,
    next_cursor: nextCursor,
  };
}
