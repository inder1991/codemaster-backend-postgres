/**
 * Integration test for the Confluence-pages admin cluster against the DISPOSABLE Postgres
 * (CODEMASTER_PG_CORE_DSN — NEVER the cluster). The route block runs ONLY when the DSN is set; SKIPS else.
 *
 * Covers (1:1 with codemaster/api/admin/page_approvals.py + quarantined_chunks.py):
 *   GET    /api/admin/integrations/confluence-spaces/{integration_id}/pages
 *   POST   /api/admin/integrations/confluence-spaces/{integration_id}/pages/{page_id}/approval
 *   DELETE /api/admin/integrations/confluence-spaces/{integration_id}/pages/{page_id}/approval
 *   GET    /api/admin/integrations/confluence-spaces/{integration_id}/quarantined-chunks
 *
 * The page-approval POST/DELETE and the quarantined-chunks GET are AUDIT-EXEMPT (the Python routers emit
 * no audit action — mirrored here). // audit-test-exempt
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { PageWithApprovalV1, PagesListPageV1 } from "#contracts/admin.v1.js";
import { QuarantinedChunkV1, QuarantinedChunksPageV1 } from "#contracts/admin.v1.js";
import { TemporalWorkflowStartPayloadV1 } from "#contracts/outbox_payloads.v1.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { OutboxPageResyncDispatcher } from "#backend/api/admin/page_resync_dispatcher.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";
import {
  getSpaceKeyForIntegration,
  listPagesForIntegration,
  listQuarantinedChunksForIntegration,
} from "#backend/api/admin/confluence_pages_read.js";
import {
  createPageApproval,
  revokePageApproval,
} from "#backend/api/admin/confluence_pages_write.js";
import { type ConfluencePageListerPort } from "#backend/integrations/confluence/confluence_page_lister.js";
import { PLATFORM_SCOPE_AUDIT_INSTALLATION_ID } from "#backend/infra/sentinels.js";
import { WORKFLOW_TYPE_TO_JOB_TYPE } from "#backend/runner/workflow_job_map.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

describe("confluence-pages contracts + helpers exist", () => {
  it("PageWithApprovalV1 exists", () => {
    expect(PageWithApprovalV1).toBeDefined();
  });
  it("PagesListPageV1 exists", () => {
    expect(PagesListPageV1).toBeDefined();
  });
  it("QuarantinedChunkV1 exists", () => {
    expect(QuarantinedChunkV1).toBeDefined();
  });
  it("QuarantinedChunksPageV1 exists", () => {
    expect(QuarantinedChunksPageV1).toBeDefined();
  });
  it("getSpaceKeyForIntegration / list helpers exist", () => {
    expect(getSpaceKeyForIntegration).toBeDefined();
    expect(listPagesForIntegration).toBeDefined();
    expect(listQuarantinedChunksForIntegration).toBeDefined();
  });
  it("createPageApproval / revokePageApproval exist", () => {
    expect(createPageApproval).toBeDefined();
    expect(revokePageApproval).toBeDefined();
  });
});

const NOW = new Date("2026-06-08T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INTEGRATION_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const SPACE_KEY = "ZZTESTPAGES";
const PAGE_A = "page-a-1001"; // active, approvable
const PAGE_Q = "page-q-2002"; // a quarantined chunk lives here
const USER = "cccccccc-1111-2222-3333-444444444444";

let pool: Pool;
let db: Kysely<unknown>;

/** Clear only the mutable approval rows so each test starts from a deterministic "no approvals" baseline
 *  (the suite runs under vitest sequence.shuffle, so order-coupling on approval state must not exist).
 *  Also clears this suite's deterministic trigger_page_resync outbox rows (W4c.2 #5) — the workflow_id
 *  is `trigger-page-resync/<space>/<page>`, so the prefix scopes the wipe to this suite's space. */
async function resetApprovals(): Promise<void> {
  // tenant:exempt reason=test-fixture-cleanup follow_up=PERMANENT-EXEMPTION-confluence-corpus
  await sql`DELETE FROM core.confluence_page_approvals WHERE space_key = ${SPACE_KEY}`.execute(db);
  // tenant:exempt reason=test-fixture-cleanup follow_up=PERMANENT-EXEMPTION-confluence-corpus
  await sql`DELETE FROM core.outbox
             WHERE payload->>'workflow_id' LIKE ${`trigger-page-resync/${SPACE_KEY}/%`}`.execute(db);
}

async function cleanup(): Promise<void> {
  await resetApprovals();
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

  // The W4c.2 #5 outbox producer stamps the PLATFORM_SCOPE_AUDIT sentinel installation on its rows
  // (ck_outbox_installation_id_required forbids NULL on the temporal_workflow_start sink; the
  // column FKs core.installations). Migration 0002 seeds the row in every real DB, but sibling
  // suites' cleanups can wipe it on the shared disposable DB — re-seed idempotently (same shape as
  // the 0002 INSERT; github_installation_id -1 is the seed's reserved non-GitHub value).
  // tenant:exempt reason=test-fixture-seed follow_up=PERMANENT-EXEMPTION-confluence-corpus
  await sql`
    INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
    VALUES (${PLATFORM_SCOPE_AUDIT_INSTALLATION_ID}, -1, '__platform_sentinel__', 'Organization')
    ON CONFLICT (installation_id) DO NOTHING
  `.execute(db);

  // The confluence_space integration whose config_json carries the space_key the routes resolve.
  await sql`
    INSERT INTO core.integrations (integration_id, kind, config_json, enabled, trust_tier)
    VALUES (${INTEGRATION_ID}, 'confluence_space',
            CAST(${JSON.stringify({ space_key: SPACE_KEY, space_name: "ZZ Test" })} AS jsonb),
            true, 'trusted')
  `.execute(db);

  // An active (non-quarantined, non-default) page chunk → listed in /pages with approval_status='none'.
  await sql`
    INSERT INTO core.confluence_chunks (
      space_key, page_id, page_title, version, chunk_index,
      chunk_text, content_sha256, labels, quarantined, quarantine_reasons,
      page_status, last_modified_at
    ) VALUES (
      ${SPACE_KEY}, ${PAGE_A}, 'Page A', 1, 0,
      'body of page A', 'sha-a', '{}'::text[], false, '{}'::text[],
      'active', '2026-06-05T00:00:00Z'
    )
  `.execute(db);

  // A quarantined chunk → listed in /quarantined-chunks. The biconditional CHECK requires ≥1 reason when
  // quarantined=true. It also surfaces in /pages (deleted_at IS NULL) as a distinct page.
  await sql`
    INSERT INTO core.confluence_chunks (
      space_key, page_id, page_title, version, chunk_index,
      chunk_text, content_sha256, labels, quarantined, quarantine_reasons,
      page_status, last_modified_at
    ) VALUES (
      ${SPACE_KEY}, ${PAGE_Q}, 'Page Q', 1, 0,
      'quarantined body of page Q that is long enough to exercise the 280-char preview truncation path',
      'sha-q', '{}'::text[], true, '{secret_detected}'::text[],
      'active', '2026-06-06T00:00:00Z'
    )
  `.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function mintCookie(role: Role): string {
  return issueCookie({
    user_id: USER,
    email: "op@example.com",
    role,
    auth_source: "local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: null,
  });
}

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

function approvalBody() {
  return {
    space_key: SPACE_KEY,
    page_id: PAGE_A,
    approved_at_utc: "2026-06-08T11:00:00+00:00",
    approval_artifact_url: "https://wiki.example.com/approval/page-a",
    scope_justification: "approved for the platform-wide default corpus exercise",
    default_scope: "universal",
  };
}

const PAGES_BASE = `/api/admin/integrations/confluence-spaces/${INTEGRATION_ID}/pages`;
const QUARANTINE_BASE = `/api/admin/integrations/confluence-spaces/${INTEGRATION_ID}/quarantined-chunks`;

describeDb("confluence pages admin endpoints (disposable PG)", () => {
  // Each test starts from a clean approval slate so the shuffled order can't leak state between tests.
  beforeEach(async () => {
    await resetApprovals();
  });

  it("GET /pages — 200 with both pages, approval_status='none' initially; 403 for reader", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: PAGES_BASE,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      });
      expect(res.statusCode).toBe(200);
      const body = PagesListPageV1.parse(res.json());
      const pageIds = body.rows.map((r) => r.page_id).sort();
      expect(pageIds).toContain(PAGE_A);
      expect(pageIds).toContain(PAGE_Q);
      expect(body.rows.find((r) => r.page_id === PAGE_A)?.approval_status).toBe("none");

      const forbidden = await app.inject({
        method: "GET",
        url: PAGES_BASE,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") },
      });
      expect(forbidden.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("GET /pages — 404 for an unknown integration_id", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/integrations/confluence-spaces/ffffffff-0000-0000-0000-000000000000/pages",
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("GET /pages — 422 for a malformed integration_id (Python uuid.UUID path-param parity)", async () => {
    // 1:1 with the Python list_pages_route(integration_id: uuid.UUID): FastAPI rejects a malformed UUID
    // with 422 BEFORE the repo call. Pre-fix the TS passed the bad string straight to the repo → 404.
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/integrations/confluence-spaces/not-a-uuid/pages",
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      });
      expect(res.statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });

  it("GET /quarantined-chunks — 422 for a malformed integration_id (Python uuid.UUID path-param parity)", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/integrations/confluence-spaces/not-a-uuid/quarantined-chunks",
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      });
      expect(res.statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });

  it("POST /approval — 201 creates approval; then GET /pages shows approval_status='approved'", async () => {
    const app = await makeApp();
    try {
      const post = await app.inject({
        method: "POST",
        url: `${PAGES_BASE}/${PAGE_A}/approval`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
        payload: approvalBody(),
      });
      expect(post.statusCode).toBe(201);
      const created = post.json<{ approval_id: string; approver_email: string }>();
      expect(created.approval_id).toMatch(/^[0-9a-f-]{36}$/);
      // approver_email is session-derived via the shim resolver (audit P0-1), NOT taken from the body.
      expect(created.approver_email).toBe(`shim-user-${USER}@codemaster.local`);

      const pages = await app.inject({
        method: "GET",
        url: PAGES_BASE,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      });
      const body = PagesListPageV1.parse(pages.json());
      expect(body.rows.find((r) => r.page_id === PAGE_A)?.approval_status).toBe("approved");
    } finally {
      await app.close();
    }
  });

  it("POST /approval — 400 when body.space_key mismatches the URL integration's space_key", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: `${PAGES_BASE}/${PAGE_A}/approval`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
        payload: { ...approvalBody(), space_key: "OTHERSPACE" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("POST /approval — 400 when body.page_id mismatches the URL path page_id", async () => {
    // 1:1 with the Python create_approval cross-check (page_approvals.py ~L224): the URL page_id is
    // authoritative, so a body.page_id naming a DIFFERENT page is rejected with code=url_body_mismatch.
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: `${PAGES_BASE}/${PAGE_A}/approval`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
        payload: { ...approvalBody(), page_id: PAGE_Q },
      });
      expect(res.statusCode).toBe(400);
      const detail = res.json<{ detail: { code: string } }>().detail;
      expect(detail.code).toBe("url_body_mismatch");
    } finally {
      await app.close();
    }
  });

  it("DELETE /approval — 204 revokes the active approval; second DELETE → 404", async () => {
    const app = await makeApp();
    try {
      // Ensure an active approval exists (idempotent upsert).
      await app.inject({
        method: "POST",
        url: `${PAGES_BASE}/${PAGE_A}/approval`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
        payload: approvalBody(),
      });

      const del = await app.inject({
        method: "DELETE",
        url: `${PAGES_BASE}/${PAGE_A}/approval`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      });
      expect(del.statusCode).toBe(204);

      const delAgain = await app.inject({
        method: "DELETE",
        url: `${PAGES_BASE}/${PAGE_A}/approval`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      });
      expect(delAgain.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("approve + revoke both enqueue the trigger_page_resync outbox row via the concrete dispatcher (W4c.2 #5 + Option C Phase 5)", async () => {
    // The PRODUCER WIRING test: with the concrete OutboxPageResyncDispatcher threaded (the same wiring
    // server.ts performs), BOTH approval (Option C Phase 5 — approve-then-ingest) AND revocation append a
    // `temporal_workflow_start` outbox row carrying workflow_type='triggerPageResyncWorkflow' + the
    // TriggerPageResyncInputV1 args[0] — so each → outbox → (cutover) → background job → the
    // trigger_page_resync handler. (Pre-Phase-5 only revocation enqueued; the approval now does too.) Both
    // use the SAME deterministic workflow_id, so the rows coalesce on the Temporal/job side (USE_EXISTING).
    const app = buildApp({});
    await registerAdminRoutes(app, {
      db,
      signingKey: SIGNING_KEY,
      clock: new FakeClock({ now: NOW }),
      pageResyncDispatcher: new OutboxPageResyncDispatcher({ db }),
    });
    await app.ready();
    try {
      const post = await app.inject({
        method: "POST",
        url: `${PAGES_BASE}/${PAGE_A}/approval`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
        payload: approvalBody(),
      });
      expect(post.statusCode).toBe(201);

      // Option C Phase 5: the APPROVAL itself enqueues a resync (approve-then-ingest) — one row now.
      // tenant:exempt reason=test-assertion-scoped-by-workflow-id follow_up=PERMANENT-EXEMPTION-confluence-corpus
      const afterApprove = await sql<{ n: string }>`SELECT count(*) AS n FROM core.outbox
        WHERE payload->>'workflow_id' = ${`trigger-page-resync/${SPACE_KEY}/${PAGE_A}`}`.execute(db);
      expect(Number(afterApprove.rows[0]!.n)).toBe(1);

      const del = await app.inject({
        method: "DELETE",
        url: `${PAGES_BASE}/${PAGE_A}/approval`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      });
      expect(del.statusCode).toBe(204);

      // The revoke appends a SECOND row (same deterministic workflow_id → coalesced downstream).
      // tenant:exempt reason=test-assertion-scoped-by-workflow-id follow_up=PERMANENT-EXEMPTION-confluence-corpus
      const rows = await sql<{
        sink: string;
        state: string;
        installation_id: string | null;
        run_id: string | null;
        payload: Record<string, unknown>;
      }>`SELECT sink, state, installation_id, run_id, payload FROM core.outbox
          WHERE payload->>'workflow_id' = ${`trigger-page-resync/${SPACE_KEY}/${PAGE_A}`}`.execute(db);
      expect(rows.rows).toHaveLength(2);
      // Every row carries the same sink + platform-sentinel installation (Confluence is platform-scoped;
      // ck_outbox_installation_id_required forbids NULL on this sink) + the correct envelope.
      for (const row of rows.rows) {
        expect(row.sink).toBe("temporal_workflow_start");
        expect(row.state).toBe("pending");
        expect(row.installation_id).toBe(PLATFORM_SCOPE_AUDIT_INSTALLATION_ID);
        expect(row.run_id).toBeNull(); // bootstrap-sink dispatch — no review-run causality

        // The envelope parses with the SINK's contract (dispatchable by both the Temporal sink and the
        // cutover BackgroundJobsTemporalPort) and routes through WORKFLOW_TYPE_TO_JOB_TYPE onto the
        // registered trigger_page_resync handler.
        const envelope = TemporalWorkflowStartPayloadV1.parse(row.payload);
        expect(envelope.workflow_type).toBe("triggerPageResyncWorkflow");
        expect(WORKFLOW_TYPE_TO_JOB_TYPE[envelope.workflow_type]).toBe("trigger_page_resync");
        expect(envelope.args).toHaveLength(1);
        // args[0] IS the TriggerPageResyncInputV1 the handler parses; triggered_by_user_id is the
        // session-derived admin (audit P0-1 — never body-supplied).
        expect(envelope.args[0]).toMatchObject({
          schema_version: 1,
          space_key: SPACE_KEY,
          page_id: PAGE_A,
          triggered_by_user_id: USER,
        });
      }
    } finally {
      await app.close();
    }
  });

  it("GET /quarantined-chunks — 200 lists the quarantined chunk with a truncated preview; 403 for reader", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: QUARANTINE_BASE,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("super_admin") },
      });
      expect(res.statusCode).toBe(200);
      const body = QuarantinedChunksPageV1.parse(res.json());
      expect(body.rows.length).toBe(1);
      expect(body.rows[0]?.page_id).toBe(PAGE_Q);
      expect(body.rows[0]?.quarantine_reasons).toContain("secret_detected");
      expect(body.rows[0]?.chunk_text_preview.length).toBeLessThanOrEqual(280);

      const forbidden = await app.inject({
        method: "GET",
        url: QUARANTINE_BASE,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") },
      });
      expect(forbidden.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // ── Option C Phase 4 — the live-page lister route seam ──
  // The GET /pages route forwards a wired lister into listPagesForIntegration. A wired lister surfaces
  // LIVE pages (a page with NO stored chunk becomes visible + approvable); an unwired/failing lister
  // degrades to the stored query with live_list_available:false. The lister is a stub here (no network).

  function liveListerOk(): ConfluencePageListerPort {
    return {
      async listSpacePages({ spaceKey }) {
        return {
          items: [
            // A LIVE-only page with NO stored chunk — invisible to the stored query, visible here.
            { page_id: "live-only-9001", space_key: spaceKey, title: "Live Only", version: 1, last_modified_at: "2026-06-10T00:00:00Z" },
            // The stored PAGE_A also appears live.
            { page_id: PAGE_A, space_key: spaceKey, title: "Page A (live title)", version: 1, last_modified_at: "2026-06-05T00:00:00Z" },
          ],
          next_cursor: "opaque-next",
        };
      },
      // The GET /pages tests don't exercise the approval existence check; indeterminate is benign.
      async getPageForApproval() {
        return null;
      },
    };
  }

  function liveListerFails(): ConfluencePageListerPort {
    return {
      async listSpacePages() {
        throw new Error("ConfluenceRetryableError: unreachable");
      },
      async getPageForApproval() {
        return null;
      },
    };
  }

  async function makeAppWithLister(getLister?: () => ConfluencePageListerPort) {
    const app = buildApp({});
    await registerAdminRoutes(app, {
      db,
      signingKey: SIGNING_KEY,
      clock: new FakeClock({ now: NOW }),
      ...(getLister ? { getConfluencePageLister: getLister } : {}),
    });
    await app.ready();
    return app;
  }

  it("GET /pages — 200 merges LIVE pages when a lister is wired (live_list_available:true, live: cursor)", async () => {
    const app = await makeAppWithLister(liveListerOk);
    try {
      const res = await app.inject({
        method: "GET",
        url: PAGES_BASE,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      });
      expect(res.statusCode).toBe(200);
      const body = PagesListPageV1.parse(res.json());
      expect(body.live_list_available).toBe(true);
      expect(body.next_cursor).toBe("live:opaque-next");
      const by = new Map(body.rows.map((r) => [r.page_id, r]));
      // The LIVE-only page (no stored chunk) is surfaced as not_ingested + none — the Option C fix.
      expect(by.get("live-only-9001")).toMatchObject({ ingest_status: "not_ingested", approval_status: "none" });
      // The stored page A is ingested.
      expect(by.get(PAGE_A)).toMatchObject({ ingest_status: "ingested", approval_status: "none" });
    } finally {
      await app.close();
    }
  });

  it("GET /pages — 200 with live_list_available:false when the lister is UNWIRED (stored fallback)", async () => {
    const app = await makeAppWithLister(undefined);
    try {
      const res = await app.inject({
        method: "GET",
        url: PAGES_BASE,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      });
      expect(res.statusCode).toBe(200);
      const body = PagesListPageV1.parse(res.json());
      expect(body.live_list_available).toBe(false);
      // The stored query never surfaces the live-only page.
      expect(body.rows.find((r) => r.page_id === "live-only-9001")).toBeUndefined();
      expect(body.rows.every((r) => r.ingest_status === "ingested")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("GET /pages — 200 with live_list_available:false when the lister FAILS (fast fallback, no hang)", async () => {
    const app = await makeAppWithLister(liveListerFails);
    try {
      const res = await app.inject({
        method: "GET",
        url: PAGES_BASE,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      });
      expect(res.statusCode).toBe(200);
      const body = PagesListPageV1.parse(res.json());
      expect(body.live_list_available).toBe(false);
      expect(body.rows.find((r) => r.page_id === PAGE_A)).toBeDefined();
    } finally {
      await app.close();
    }
  });

  // ── Option C Phase 5 — approve: live existence check + audit(labels) + best-effort resync (D9) ──

  type ListerBehavior =
    | { exists: false }
    | { exists: true; labels: string[] }
    | { indeterminate: true };

  function approvalLister(b: ListerBehavior): ConfluencePageListerPort {
    return {
      // These approval-POST tests never hit the list path; an empty list keeps the stub complete.
      async listSpacePages() {
        return { items: [], next_cursor: null };
      },
      async getPageForApproval() {
        if ("indeterminate" in b) return null;
        if (b.exists === false) return { exists: false };
        return { exists: true, labels: b.labels };
      },
    };
  }

  type CapturedAudit = {
    action: string;
    targetKind: string;
    targetId: string;
    after: Record<string, unknown> | null;
  };

  async function makeApprovalApp(args: {
    getLister?: () => ConfluencePageListerPort;
    dispatcher?: { enqueueResync: (a: { spaceKey: string; pageId: string; triggeredByUserId: string }) => Promise<void> };
    audits?: CapturedAudit[];
  }) {
    const app = buildApp({});
    await registerAdminRoutes(app, {
      db,
      signingKey: SIGNING_KEY,
      clock: new FakeClock({ now: NOW }),
      ...(args.getLister ? { getConfluencePageLister: args.getLister } : {}),
      ...(args.dispatcher ? { pageResyncDispatcher: args.dispatcher } : {}),
      ...(args.audits
        ? {
            audit: async (e) => {
              args.audits!.push({ action: e.action, targetKind: e.targetKind, targetId: e.targetId, after: e.after });
            },
          }
        : {}),
    });
    await app.ready();
    return app;
  }

  it("POST /approval — 422 page_not_found when the live existence check returns a definitive 404", async () => {
    const app = await makeApprovalApp({ getLister: () => approvalLister({ exists: false }) });
    try {
      const res = await app.inject({
        method: "POST",
        url: `${PAGES_BASE}/${PAGE_A}/approval`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
        payload: approvalBody(),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ detail: { code: string } }>().detail.code).toBe("page_not_found");
      // No approval row was written.
      // tenant:exempt reason=test-assertion follow_up=PERMANENT-EXEMPTION-confluence-corpus
      const n = await sql<{ n: string }>`SELECT count(*) AS n FROM core.confluence_page_approvals
        WHERE space_key = ${SPACE_KEY} AND page_id = ${PAGE_A}`.execute(db);
      expect(Number(n.rows[0]!.n)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("POST /approval — 201 + audit carries observed_labels + resync dispatched (live page exists)", async () => {
    const audits: CapturedAudit[] = [];
    const dispatched: Array<{ spaceKey: string; pageId: string; triggeredByUserId: string }> = [];
    const app = await makeApprovalApp({
      getLister: () => approvalLister({ exists: true, labels: ["default", "topic:runbook"] }),
      dispatcher: { enqueueResync: async (a) => { dispatched.push(a); } },
      audits,
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: `${PAGES_BASE}/${PAGE_A}/approval`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
        payload: approvalBody(),
      });
      expect(res.statusCode).toBe(201);

      const audit = audits.find((a) => a.action === "confluence_page.approval.created");
      expect(audit).toBeDefined();
      expect(audit!.targetKind).toBe("confluence_page_approval");
      expect(audit!.after?.observed_labels).toEqual(["default", "topic:runbook"]);
      expect(audit!.after?.page_id).toBe(PAGE_A);

      // The approval dispatched a page-resync (the approve-then-ingest flow).
      expect(dispatched).toEqual([{ spaceKey: SPACE_KEY, pageId: PAGE_A, triggeredByUserId: USER }]);
    } finally {
      await app.close();
    }
  });

  it("POST /approval — indeterminate existence (transport down) → 201 + observed_labels:null (pre-authorization)", async () => {
    const audits: CapturedAudit[] = [];
    const app = await makeApprovalApp({ getLister: () => approvalLister({ indeterminate: true }), audits });
    try {
      const res = await app.inject({
        method: "POST",
        url: `${PAGES_BASE}/${PAGE_A}/approval`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
        payload: approvalBody(),
      });
      expect(res.statusCode).toBe(201); // fail-open: pre-authorization allowed
      const audit = audits.find((a) => a.action === "confluence_page.approval.created");
      expect(audit!.after?.observed_labels).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("POST /approval — enqueue FAILURE → approval still 201 (no rollback); the row persists", async () => {
    const app = await makeApprovalApp({
      getLister: () => approvalLister({ exists: true, labels: [] }),
      dispatcher: { enqueueResync: async () => { throw new Error("outbox down"); } },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: `${PAGES_BASE}/${PAGE_A}/approval`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
        payload: approvalBody(),
      });
      // The enqueue threw, but the approval committed — best-effort dispatch never rolls back.
      expect(res.statusCode).toBe(201);
      // The approval row persists despite the resync failure.
      // tenant:exempt reason=test-assertion follow_up=PERMANENT-EXEMPTION-confluence-corpus
      const n = await sql<{ n: string }>`SELECT count(*) AS n FROM core.confluence_page_approvals
        WHERE space_key = ${SPACE_KEY} AND page_id = ${PAGE_A} AND revoked_at IS NULL`.execute(db);
      expect(Number(n.rows[0]!.n)).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("POST /approval — no lister wired → 201 with NO existence check (legacy path unchanged)", async () => {
    const app = await makeApprovalApp({});
    try {
      const res = await app.inject({
        method: "POST",
        url: `${PAGES_BASE}/${PAGE_A}/approval`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
        payload: approvalBody(),
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });
});
