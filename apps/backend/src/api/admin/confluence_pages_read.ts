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
import { type ConfluencePageListerPort } from "#backend/integrations/confluence/confluence_page_lister.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const QUARANTINE_PREVIEW_CHARS = 280;
/** The per-request deadline for the LIVE Confluence read (D4). On expiry the AbortController cancels the
 *  in-flight transport and the read degrades to the stored query (live_list_available:false). */
const LIVE_LIST_DEADLINE_MS = 4000;

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
 * The parsed page-list cursor (D3). The list cursor is NAMESPACED so a live cursor is never replayed as a
 * stored offset (or vice-versa) across a degrade/recover transition:
 *   - `live:<opaque>`   → resume the LIVE Confluence pagination at the opaque cursor.
 *   - `stored:<offset>` → resume the STORED offset pagination.
 *   - a BARE numeric (legacy, pre-namespacing) → treated as `stored:<offset>` (back-compat).
 *   - empty / malformed / unknown prefix → the FIRST page (kind:"first"). NEVER 422/500 on a cursor.
 */
export type PagesCursor =
  | { kind: "first" }
  | { kind: "live"; opaque: string }
  | { kind: "stored"; offset: number };

/** Parse the opaque page-list cursor. Total (never throws) — an unparseable cursor degrades to the first
 *  page so a stale/garbled SPA cursor can never 422/500 the list (D3). */
export function parsePagesCursor(raw: string | null | undefined): PagesCursor {
  if (raw === null || raw === undefined || raw === "") return { kind: "first" };
  if (raw.startsWith("live:")) {
    const opaque = raw.slice("live:".length);
    return opaque === "" ? { kind: "first" } : { kind: "live", opaque };
  }
  if (raw.startsWith("stored:")) {
    return parseStoredOffset(raw.slice("stored:".length));
  }
  // Legacy bare-numeric cursor (pre-namespacing the offset was emitted raw) → stored offset.
  if (/^\d+$/.test(raw)) {
    return parseStoredOffset(raw);
  }
  // Unknown prefix / garbled → first page (never error).
  return { kind: "first" };
}

/** Parse a non-negative integer offset; a malformed/negative value degrades to the first page. */
function parseStoredOffset(s: string): PagesCursor {
  if (!/^\d+$/.test(s)) return { kind: "first" };
  const offset = Number.parseInt(s, 10);
  if (!Number.isFinite(offset) || offset < 0) return { kind: "first" };
  return { kind: "stored", offset };
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

/** The per-page approval state (D10 — the LATEST approval row, incl. revoked) the merge joins against. */
type ApprovalState = {
  approval_status: "approved" | "revoked" | "none";
  approver_email: string | null;
  approved_at_utc: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
};

const APPROVAL_NONE: ApprovalState = {
  approval_status: "none",
  approver_email: null,
  approved_at_utc: null,
  revoked_at: null,
  revoked_by: null,
};

/**
 * Paginated list of pages for a space (resolved from integration_id), with their storage (ingest_status)
 * + approval (approval_status) state. Option C (live-page approval view):
 *
 *  - LIVE branch (a lister is wired AND the live read succeeds within the ~4s deadline): the page set
 *    comes from LIVE Confluence (so a never-approved `default` page with 0 chunks is still visible +
 *    approvable). The live page_ids are merged with two batched stored reads — ingest_status + labels from
 *    core.confluence_chunks, and the LATEST approval row (incl. revoked, D10) from
 *    core.confluence_page_approvals. next_cursor = `live:<opaque>`, live_list_available = true.
 *
 *  - FALLBACK branch (no lister, or the live read threw/aborted): the legacy STORED query over
 *    core.confluence_chunks (only ingested pages are visible). next_cursor = `stored:<offset>`,
 *    live_list_available = false. A `live:` / unknown cursor arriving here resolves to the FIRST stored
 *    page (the namespaces never cross-replay).
 *
 * The cursor is namespaced + legacy-tolerant (D3) — see {@link parsePagesCursor}. The live read is NEVER
 * a hard dependency: any failure degrades to the stored fallback.
 */
export async function listPagesForIntegration(
  db: Kysely<unknown>,
  integrationId: string,
  opts: { cursor?: string | null; pageSize?: number; lister?: ConfluencePageListerPort } = {},
): Promise<PagesListPageV1> {
  const pageSize = clampPageSize(opts.pageSize);
  const cursor = parsePagesCursor(opts.cursor);
  const spaceKey = await getSpaceKeyForIntegration(db, integrationId);

  // LIVE branch — only when a lister is wired AND the cursor is not a stored-pagination cursor. A stored
  // cursor means the client is mid-way through a degraded (fallback) pagination; stay on the stored query
  // rather than restart from the first live page mid-scroll.
  if (opts.lister !== undefined && cursor.kind !== "stored") {
    const liveCursor = cursor.kind === "live" ? cursor.opaque : null;
    const live = await tryListLive(opts.lister, spaceKey, liveCursor);
    if (live !== null) {
      const rows = await mergeLivePages(db, spaceKey, live.items);
      return {
        schema_version: 1,
        rows,
        next_cursor: live.next_cursor === null ? null : `live:${live.next_cursor}`,
        live_list_available: true,
      };
    }
    // live read failed → fall through to the stored fallback (live_list_available:false).
  }

  return storedFallbackPage(db, spaceKey, cursor, pageSize);
}

/**
 * Run the LIVE list under a ~4s deadline (D4). An AbortController cancels the in-flight transport on
 * expiry; any throw (unconfigured creds / transport error / abort) returns null so the caller falls back
 * to the stored query. The timer is always cleared (no leaked timer keeping the event loop alive).
 */
async function tryListLive(
  lister: ConfluencePageListerPort,
  spaceKey: string,
  liveCursor: string | null,
): Promise<{ items: ReadonlyArray<{ page_id: string; space_key: string; title: string; version: number; last_modified_at: string }>; next_cursor: string | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_LIST_DEADLINE_MS);
  timer.unref?.();
  try {
    const page = await lister.listSpacePages({ spaceKey, cursor: liveCursor, signal: controller.signal });
    return { items: page.items, next_cursor: page.next_cursor };
  } catch {
    // Any failure (incl. the deadline AbortError) → degrade to the stored fallback. The specific cause is
    // not surfaced here; the SPA renders the degrade note from live_list_available:false.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merge the LIVE page summaries with the stored ingest + approval state. Two BATCHED reads keyed on the
 * live page_ids (not N+1): the most-recent non-deleted chunk per page (ingest_status + labels), and the
 * LATEST approval row per page (D10). Live summaries carry NO labels (client.ts:231), so labels come from
 * the stored chunk when ingested, else []. Order is preserved from the live list (Confluence's order).
 */
async function mergeLivePages(
  db: Kysely<unknown>,
  spaceKey: string,
  items: ReadonlyArray<{ page_id: string; space_key: string; title: string; version: number; last_modified_at: string }>,
): Promise<Array<PageWithApprovalV1>> {
  const pageIds = items.map((i) => i.page_id);
  const [chunkByPage, approvalByPage] = await Promise.all([
    readChunkStateForPages(db, spaceKey, pageIds),
    readLatestApprovalForPages(db, spaceKey, pageIds),
  ]);

  return items.map((i) => {
    const chunk = chunkByPage.get(i.page_id);
    const approval = approvalByPage.get(i.page_id) ?? APPROVAL_NONE;
    return {
      schema_version: 1,
      space_key: i.space_key,
      page_id: i.page_id,
      page_title: i.title,
      page_version: i.version,
      // No labels on a live summary; surface the stored chunk's labels when the page is ingested.
      labels: chunk?.labels ?? [],
      last_modified_at: i.last_modified_at,
      ingest_status: chunk !== undefined ? "ingested" : "not_ingested",
      approval_status: approval.approval_status,
      approver_email: approval.approver_email,
      approved_at_utc: approval.approved_at_utc,
      revoked_at: approval.revoked_at,
      revoked_by: approval.revoked_by,
    };
  });
}

/** Map page_id → { labels } for the most-recent non-deleted chunk (ingest_status = present in this map). */
async function readChunkStateForPages(
  db: Kysely<unknown>,
  spaceKey: string,
  pageIds: ReadonlyArray<string>,
): Promise<Map<string, { labels: Array<string> }>> {
  const out = new Map<string, { labels: Array<string> }>();
  if (pageIds.length === 0) return out;
  // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
  const result = await sql<{ page_id: string; labels: Array<string> | null }>`
    SELECT DISTINCT ON (cc.page_id)
      cc.page_id,
      cc.labels
    FROM core.confluence_chunks cc
    WHERE cc.space_key = ${spaceKey}
      AND cc.page_id = ANY(${pageIds as string[]})
      AND cc.deleted_at IS NULL
    ORDER BY cc.page_id, cc.version DESC, cc.last_modified_at DESC
  `.execute(db);
  for (const r of result.rows) {
    out.set(r.page_id, { labels: r.labels ?? [] });
  }
  return out;
}

/**
 * Map page_id → the LATEST approval row (D10), INCLUDING revoked rows. Deterministic pick per page:
 * `DISTINCT ON (page_id) … ORDER BY page_id, (revoked_at IS NULL) DESC, approved_at_utc DESC,
 * approval_id DESC` — prefer the active row; else the most-recently-approved; tie-break by approval_id.
 * approval_status is then derived from the picked row's revoked_at.
 */
async function readLatestApprovalForPages(
  db: Kysely<unknown>,
  spaceKey: string,
  pageIds: ReadonlyArray<string>,
): Promise<Map<string, ApprovalState>> {
  const out = new Map<string, ApprovalState>();
  if (pageIds.length === 0) return out;
  // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
  const result = await sql<{
    page_id: string;
    approver_email: string | null;
    approved_at_utc: Date | null;
    revoked_at: Date | null;
    revoked_by: string | null;
  }>`
    SELECT DISTINCT ON (cpa.page_id)
      cpa.page_id,
      cpa.approver_email,
      cpa.approved_at_utc,
      cpa.revoked_at,
      cpa.revoked_by
    FROM core.confluence_page_approvals cpa
    WHERE cpa.space_key = ${spaceKey}
      AND cpa.page_id = ANY(${pageIds as string[]})
    ORDER BY cpa.page_id, (cpa.revoked_at IS NULL) DESC, cpa.approved_at_utc DESC, cpa.approval_id DESC
  `.execute(db);
  for (const r of result.rows) {
    out.set(r.page_id, approvalStateFromRow(r));
  }
  return out;
}

/** Derive the ApprovalState (incl. approval_status from revoked_at) from a picked approval row. */
function approvalStateFromRow(r: {
  approver_email: string | null;
  approved_at_utc: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
}): ApprovalState {
  return {
    approval_status: r.revoked_at === null ? "approved" : "revoked",
    approver_email: r.approver_email ?? null,
    approved_at_utc: r.approved_at_utc ? iso(r.approved_at_utc) : null,
    revoked_at: r.revoked_at ? iso(r.revoked_at) : null,
    revoked_by: r.revoked_by ?? null,
  };
}

/**
 * The STORED fallback page — the legacy query over core.confluence_chunks (only INGESTED pages), now with
 * the D10 latest-approval ordering (incl. revoked) so a revoked page reports approval_status:'revoked'
 * here too. A live/first cursor resolves to offset 0 (the namespaces never cross-replay). All rows are
 * ingest_status:'ingested' by definition (they come FROM the chunks table). live_list_available:false.
 */
async function storedFallbackPage(
  db: Kysely<unknown>,
  spaceKey: string,
  cursor: PagesCursor,
  pageSize: number,
): Promise<PagesListPageV1> {
  const offset = cursor.kind === "stored" ? cursor.offset : 0;

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
        latest.approver_email,
        latest.approved_at_utc,
        latest.revoked_at,
        latest.revoked_by,
        CASE
          WHEN latest.approval_id IS NULL THEN 'none'
          WHEN latest.revoked_at IS NULL THEN 'approved'
          ELSE 'revoked'
        END AS approval_status
      FROM core.confluence_chunks cc
      LEFT JOIN LATERAL (
        -- D10: the LATEST approval row per page (incl. revoked), deterministic.
        SELECT cpa.approval_id, cpa.approver_email, cpa.approved_at_utc, cpa.revoked_at, cpa.revoked_by
          FROM core.confluence_page_approvals cpa
         WHERE cpa.space_key = cc.space_key
           AND cpa.page_id = cc.page_id
         ORDER BY (cpa.revoked_at IS NULL) DESC, cpa.approved_at_utc DESC, cpa.approval_id DESC
         LIMIT 1
      ) latest ON true
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
    ingest_status: "ingested",
    approval_status: r.approval_status,
    approver_email: r.approver_email ?? null,
    approved_at_utc: r.approved_at_utc ? iso(r.approved_at_utc) : null,
    revoked_at: r.revoked_at ? iso(r.revoked_at) : null,
    revoked_by: r.revoked_by ?? null,
  }));

  const nextCursor = rows.length === pageSize ? `stored:${offset + pageSize}` : null;

  return {
    schema_version: 1,
    rows,
    next_cursor: nextCursor,
    live_list_available: false,
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
