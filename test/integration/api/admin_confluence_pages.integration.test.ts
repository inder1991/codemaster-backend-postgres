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

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
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
 *  (the suite runs under vitest sequence.shuffle, so order-coupling on approval state must not exist). */
async function resetApprovals(): Promise<void> {
  // tenant:exempt reason=test-fixture-cleanup follow_up=PERMANENT-EXEMPTION-confluence-corpus
  await sql`DELETE FROM core.confluence_page_approvals WHERE space_key = ${SPACE_KEY}`.execute(db);
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
});
