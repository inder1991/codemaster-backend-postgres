/**
 * Integration tests for listPagesForIntegration's LIVE branch + STORED fallback (Option C, Phase 3)
 * against the DISPOSABLE Postgres (CODEMASTER_PG_CORE_DSN). SKIPS without the DSN.
 *
 * Covers (plan §5 Phase 3):
 *   - merge across ALL lifecycle pairs:
 *       not_ingested + none  (the SEP-196626 deadlock page — live-only, 0 chunks)
 *       not_ingested + approved (approved, resync not yet stored)
 *       ingested + none
 *       ingested + approved
 *       ingested + revoked
 *   - fast fallback when the live read throws/aborts (no hang) → live_list_available:false + stored rows.
 *   - cursor namespacing: live branch → next_cursor=live:<opaque>; stored fallback → stored:<offset>;
 *     a legacy bare-numeric cursor resolves to the stored offset.
 *   - revoke → reapprove → revoke → approval_status reflects the LATEST row (D10).
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPageApproval,
  revokePageApproval,
} from "#backend/api/admin/confluence_pages_write.js";
import { listPagesForIntegration } from "#backend/api/admin/confluence_pages_read.js";
import { type ConfluencePageListerPort } from "#backend/integrations/confluence/confluence_page_lister.js";
import { shimUserEmailResolver } from "#backend/api/admin/platform_credentials_probe.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const INTEGRATION_ID = "bbbbbbbb-1111-2222-3333-444444444444";
const SPACE_KEY = "ZZLIVEPAGES";
const USER = "dddddddd-1111-2222-3333-444444444444";

// The live page set the stub lister returns (includes pages with + without stored chunks).
const PAGE_LIVE_ONLY = "live-only-3001"; // 0 chunks → not_ingested
const PAGE_LIVE_APPROVED = "live-approved-3002"; // 0 chunks but approved → not_ingested + approved
const PAGE_INGESTED = "ingested-3003"; // has chunks, no approval → ingested + none
const PAGE_INGESTED_APPROVED = "ingested-approved-3004"; // chunks + approval → ingested + approved
const PAGE_INGESTED_REVOKED = "ingested-revoked-3005"; // chunks + revoked approval → ingested + revoked

let pool: Pool;
let db: Kysely<unknown>;

/** A stub lister returning a fixed live page set (or throwing, to exercise the fast fallback). */
function stubLister(
  behavior:
    | { items: ReadonlyArray<{ page_id: string; title: string; version: number; last_modified_at: string }>; next_cursor: string | null }
    | { throws: Error }
    | { hangThenAbort: true },
): ConfluencePageListerPort {
  return {
    async listSpacePages({ spaceKey, signal }) {
      if ("throws" in behavior) throw behavior.throws;
      if ("hangThenAbort" in behavior) {
        // Model a slow upstream that only resolves when the deadline AbortController fires — proving the
        // read does not hang and degrades to the stored fallback.
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      }
      return {
        items: behavior.items.map((i) => ({ space_key: spaceKey, ...i })),
        next_cursor: behavior.next_cursor,
      };
    },
    // These read-path tests don't exercise the approval existence check; indeterminate is benign.
    async getPageForApproval() {
      return null;
    },
  };
}

async function insertChunk(pageId: string, title: string, labels: string[]): Promise<void> {
  // tenant:exempt reason=test-fixture-seed follow_up=PERMANENT-EXEMPTION-confluence-corpus
  await sql`
    INSERT INTO core.confluence_chunks (
      space_key, page_id, page_title, version, chunk_index,
      chunk_text, content_sha256, labels, quarantined, quarantine_reasons,
      page_status, last_modified_at
    ) VALUES (
      ${SPACE_KEY}, ${pageId}, ${title}, 1, 0,
      'body', ${`sha-${pageId}`}, ${sql.raw(`'{${labels.map((l) => `"${l}"`).join(",")}}'::text[]`)},
      false, '{}'::text[], 'active', '2026-06-05T00:00:00Z'
    )
  `.execute(db);
}

async function approve(pageId: string): Promise<string> {
  return createPageApproval(
    db,
    {
      schema_version: 1,
      space_key: SPACE_KEY,
      page_id: pageId,
      approved_at_utc: "2026-06-08T11:00:00+00:00",
      approval_artifact_url: `https://wiki.example.com/approval/${pageId}`,
      scope_justification: "approved for the live-view exercise",
      default_scope: "universal",
    },
    { actorUserId: USER, emailResolver: shimUserEmailResolver },
  );
}

async function revoke(pageId: string): Promise<boolean> {
  return revokePageApproval(db, {
    spaceKey: SPACE_KEY,
    pageId,
    actorUserId: USER,
    emailResolver: shimUserEmailResolver,
  });
}

async function cleanup(): Promise<void> {
  // tenant:exempt reason=test-fixture-cleanup follow_up=PERMANENT-EXEMPTION-confluence-corpus
  await sql`DELETE FROM core.confluence_page_approvals WHERE space_key = ${SPACE_KEY}`.execute(db);
  // tenant:exempt reason=test-fixture-cleanup follow_up=PERMANENT-EXEMPTION-confluence-corpus
  await sql`DELETE FROM core.confluence_chunks WHERE space_key = ${SPACE_KEY}`.execute(db);
  // tenant:exempt reason=test-fixture-cleanup follow_up=PERMANENT-EXEMPTION-confluence-corpus
  await sql`DELETE FROM core.integrations WHERE integration_id = ${INTEGRATION_ID}`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();

  await sql`
    INSERT INTO core.integrations (integration_id, kind, config_json, enabled, trust_tier)
    VALUES (${INTEGRATION_ID}, 'confluence_space',
            CAST(${JSON.stringify({ space_key: SPACE_KEY, space_name: "ZZ Live" })} AS jsonb),
            true, 'trusted')
  `.execute(db);

  // Stored chunks for the three "ingested" pages (the two live-only pages have NO chunks). Labels must be
  // canonical (core._validate_canonical_labels): `default` or `<prefix>:<slug>`. We deliberately use
  // NON-`default` labels here so the chunks satisfy confluence_chunks_default_approval_biconditional
  // without a pre-existing approval (a `default` chunk would REQUIRE an active approval row — exactly the
  // invariant Option C keeps; ingest_status/approval_status are independent of the chunk's labels anyway).
  await insertChunk(PAGE_INGESTED, "Ingested", ["topic:runbook"]);
  await insertChunk(PAGE_INGESTED_APPROVED, "Ingested Approved", ["topic:security"]);
  await insertChunk(PAGE_INGESTED_REVOKED, "Ingested Revoked", ["framework:django"]);
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

const LIVE_ITEMS = [
  { page_id: PAGE_LIVE_ONLY, title: "Live Only (default, unapproved)", version: 4, last_modified_at: "2026-06-10T00:00:00Z" },
  { page_id: PAGE_LIVE_APPROVED, title: "Live Approved (pre-ingest)", version: 2, last_modified_at: "2026-06-09T00:00:00Z" },
  { page_id: PAGE_INGESTED, title: "Ingested (live title)", version: 1, last_modified_at: "2026-06-05T00:00:00Z" },
  { page_id: PAGE_INGESTED_APPROVED, title: "Ingested Approved (live)", version: 1, last_modified_at: "2026-06-05T00:00:00Z" },
  { page_id: PAGE_INGESTED_REVOKED, title: "Ingested Revoked (live)", version: 1, last_modified_at: "2026-06-05T00:00:00Z" },
];

describeDb("listPagesForIntegration — LIVE branch merge (disposable PG)", () => {
  beforeEach(async () => {
    // tenant:exempt reason=test-fixture-cleanup follow_up=PERMANENT-EXEMPTION-confluence-corpus
    await sql`DELETE FROM core.confluence_page_approvals WHERE space_key = ${SPACE_KEY}`.execute(db);
  });

  it("merges all five lifecycle pairs from the live page set", async () => {
    await approve(PAGE_LIVE_APPROVED); // not_ingested + approved
    await approve(PAGE_INGESTED_APPROVED); // ingested + approved
    await approve(PAGE_INGESTED_REVOKED);
    await revoke(PAGE_INGESTED_REVOKED); // ingested + revoked

    const lister = stubLister({ items: LIVE_ITEMS, next_cursor: "next-opaque" });
    const page = await listPagesForIntegration(db, INTEGRATION_ID, { lister });

    expect(page.live_list_available).toBe(true);
    expect(page.next_cursor).toBe("live:next-opaque");

    const by = new Map(page.rows.map((r) => [r.page_id, r]));
    // Order preserved from the live list.
    expect(page.rows.map((r) => r.page_id)).toEqual(LIVE_ITEMS.map((i) => i.page_id));

    expect(by.get(PAGE_LIVE_ONLY)).toMatchObject({ ingest_status: "not_ingested", approval_status: "none" });
    expect(by.get(PAGE_LIVE_APPROVED)).toMatchObject({ ingest_status: "not_ingested", approval_status: "approved" });
    expect(by.get(PAGE_INGESTED)).toMatchObject({ ingest_status: "ingested", approval_status: "none" });
    expect(by.get(PAGE_INGESTED_APPROVED)).toMatchObject({ ingest_status: "ingested", approval_status: "approved" });
    expect(by.get(PAGE_INGESTED_REVOKED)).toMatchObject({ ingest_status: "ingested", approval_status: "revoked" });

    // Live page uses the LIVE title/version; an ingested page surfaces the stored labels.
    expect(by.get(PAGE_LIVE_ONLY)?.page_title).toBe("Live Only (default, unapproved)");
    expect(by.get(PAGE_LIVE_ONLY)?.page_version).toBe(4);
    expect(by.get(PAGE_INGESTED)?.labels).toEqual(["topic:runbook"]);
    expect(by.get(PAGE_LIVE_ONLY)?.labels).toEqual([]); // no labels on a live-only page
  });

  it("null live next_cursor → null cursor (end of live pagination)", async () => {
    const lister = stubLister({ items: LIVE_ITEMS, next_cursor: null });
    const page = await listPagesForIntegration(db, INTEGRATION_ID, { lister });
    expect(page.next_cursor).toBeNull();
    expect(page.live_list_available).toBe(true);
  });

  it("a live:<opaque> cursor is forwarded to the lister verbatim", async () => {
    let seenCursor: string | null | undefined;
    const lister: ConfluencePageListerPort = {
      async listSpacePages({ spaceKey, cursor }) {
        seenCursor = cursor;
        return { items: LIVE_ITEMS.map((i) => ({ space_key: spaceKey, ...i })), next_cursor: null };
      },
      async getPageForApproval() {
        return null;
      },
    };
    await listPagesForIntegration(db, INTEGRATION_ID, { lister, cursor: "live:resume-here" });
    expect(seenCursor).toBe("resume-here");
  });

  it("revoke → reapprove → revoke → approval_status reflects the LATEST row (D10)", async () => {
    const lister = stubLister({ items: LIVE_ITEMS, next_cursor: null });

    await approve(PAGE_LIVE_APPROVED);
    await revoke(PAGE_LIVE_APPROVED);
    let page = await listPagesForIntegration(db, INTEGRATION_ID, { lister });
    expect(page.rows.find((r) => r.page_id === PAGE_LIVE_APPROVED)?.approval_status).toBe("revoked");

    await approve(PAGE_LIVE_APPROVED); // re-approve → a NEW active row
    page = await listPagesForIntegration(db, INTEGRATION_ID, { lister });
    expect(page.rows.find((r) => r.page_id === PAGE_LIVE_APPROVED)?.approval_status).toBe("approved");

    await revoke(PAGE_LIVE_APPROVED); // revoke again
    page = await listPagesForIntegration(db, INTEGRATION_ID, { lister });
    expect(page.rows.find((r) => r.page_id === PAGE_LIVE_APPROVED)?.approval_status).toBe("revoked");
  });
});

describeDb("listPagesForIntegration — fast fallback (disposable PG)", () => {
  beforeEach(async () => {
    // tenant:exempt reason=test-fixture-cleanup follow_up=PERMANENT-EXEMPTION-confluence-corpus
    await sql`DELETE FROM core.confluence_page_approvals WHERE space_key = ${SPACE_KEY}`.execute(db);
  });

  it("a thrown live read → stored fallback (live_list_available:false, stored: cursor)", async () => {
    const lister = stubLister({ throws: new Error("ConfluenceRetryableError: unreachable") });
    const page = await listPagesForIntegration(db, INTEGRATION_ID, { lister, pageSize: 2 });
    expect(page.live_list_available).toBe(false);
    // Only the three INGESTED pages are visible via the stored query.
    expect(page.rows.every((r) => r.ingest_status === "ingested")).toBe(true);
    // pageSize=2 with 3 stored pages → a stored: next cursor.
    expect(page.next_cursor).toBe("stored:2");
  });

  it("an aborted (slow) live read does not hang — degrades to the stored fallback", async () => {
    // The lister only rejects when the ~4s deadline AbortController fires. With fake timers we trip the
    // deadline immediately so the test does not actually wait 4s.
    const lister = stubLister({ hangThenAbort: true });
    const start = Date.now();
    const page = await Promise.race([
      listPagesForIntegration(db, INTEGRATION_ID, { lister }),
      new Promise<never>((_r, reject) => setTimeout(() => reject(new Error("HUNG > 6s")), 6000)),
    ]);
    expect(Date.now() - start).toBeLessThan(6000);
    expect(page.live_list_available).toBe(false);
  }, 10000);

  it("with NO lister wired → stored fallback (legacy behavior)", async () => {
    const page = await listPagesForIntegration(db, INTEGRATION_ID, {});
    expect(page.live_list_available).toBe(false);
    expect(page.rows.every((r) => r.ingest_status === "ingested")).toBe(true);
  });

  it("a legacy bare-numeric cursor resolves to the stored offset", async () => {
    // 3 stored pages; offset 2 (bare numeric) → the last stored page only.
    const page = await listPagesForIntegration(db, INTEGRATION_ID, { cursor: "2", pageSize: 2 });
    expect(page.live_list_available).toBe(false);
    expect(page.rows).toHaveLength(1);
    expect(page.next_cursor).toBeNull();
  });

  it("a stored: cursor stays on the stored fallback EVEN when a lister is wired (no mid-scroll restart)", async () => {
    const lister = stubLister({ items: LIVE_ITEMS, next_cursor: "x" });
    const page = await listPagesForIntegration(db, INTEGRATION_ID, { lister, cursor: "stored:0", pageSize: 2 });
    expect(page.live_list_available).toBe(false);
    expect(page.next_cursor).toBe("stored:2");
  });

  it("a live: cursor arriving at the stored fallback resolves to the FIRST stored page", async () => {
    // No lister → the live: cursor cannot be honored; it must resolve to offset 0, not error.
    const page = await listPagesForIntegration(db, INTEGRATION_ID, { cursor: "live:stale-opaque", pageSize: 200 });
    expect(page.live_list_available).toBe(false);
    expect(page.rows.length).toBe(3);
  });
});
