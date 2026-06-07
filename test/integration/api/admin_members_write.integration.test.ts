/**
 * Integration test for the members WRITE routes (POST role-changes request/approve/reject) against the
 * DISPOSABLE Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set.
 *
 * Exercises the full HTTP surface: 201 request, 400 path/body mismatch, 403 platform-scope-needs-super_admin,
 * 409 concurrent, 403 self-approval (two-person rule), 200 approve (+ role_grants written), 409 stale,
 * 404 not-found, 200 reject, 403 reader, 422 bad uuid/body.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INST = "ad000000-0000-0000-0000-000000000001";
const REQ = "ad000000-0000-0000-0000-000000000010"; // requester (cookie user_id)
const APP = "ad000000-0000-0000-0000-000000000011"; // approver
const SUBJ_REQ = "ad000000-0000-0000-0000-00000000000a";
const SUBJ_APP = "ad000000-0000-0000-0000-00000000000b";
const SUBJ_REJ = "ad000000-0000-0000-0000-00000000000c";

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.role_grant_pending WHERE subject_id IN (${SUBJ_REQ}, ${SUBJ_APP}, ${SUBJ_REJ})`.execute(db);
  await sql`DELETE FROM core.role_grants WHERE subject_id IN (${SUBJ_REQ}, ${SUBJ_APP}, ${SUBJ_REJ})`.execute(db);
  await sql`DELETE FROM core.users WHERE user_id IN (${REQ}, ${APP})`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${INST}`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await sql`INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
            VALUES (${INST}, 992000001, 'itest-memwr', 'Organization')`.execute(db);
  await sql`INSERT INTO core.users (user_id, installation_id, email, display_name)
            VALUES (${REQ}, ${INST}, 'req@x', 'Req'), (${APP}, ${INST}, 'app@x', 'App')`.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function cookie(role: Role, installationId: string | null, userId: string): Record<string, string> {
  return {
    [SESSION_COOKIE_NAME]: issueCookie({
      user_id: userId,
      email: "u@x",
      role,
      auth_source: "local",
      ldap_groups: [],
      now: NOW,
      signing_key: SIGNING_KEY,
      installation_id: installationId,
    }),
  };
}

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

const REQUESTER = () => cookie("platform_owner", INST, REQ);

describeDb("admin members write routes (disposable :5434)", () => {
  it("request: 201 happy; 400 path/body mismatch; 403 platform-scope; 403 reader; 409 concurrent", async () => {
    const app = await makeApp();
    const ok = await app.inject({
      method: "POST",
      url: `/api/admin/members/user/${SUBJ_REQ}/role-changes`,
      cookies: REQUESTER(),
      payload: { subject_kind: "user", subject_id: SUBJ_REQ, role: "reader", action: "grant", scope: "installation" },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ state: string; scope: string }>().state).toBe("pending");
    expect(ok.json<{ scope: string }>().scope).toBe("installation");

    // path subject_id ≠ body subject_id → 400
    const mismatch = await app.inject({
      method: "POST",
      url: `/api/admin/members/user/${SUBJ_REQ}/role-changes`,
      cookies: REQUESTER(),
      payload: { subject_kind: "user", subject_id: SUBJ_APP, role: "reader", action: "grant", scope: "installation" },
    });
    expect(mismatch.statusCode).toBe(400);

    // platform scope as platform_owner → 403 (only super_admin may stage platform grants)
    const platform = await app.inject({
      method: "POST",
      url: `/api/admin/members/user/${SUBJ_APP}/role-changes`,
      cookies: REQUESTER(),
      payload: { subject_kind: "user", subject_id: SUBJ_APP, role: "reader", action: "grant", scope: "platform" },
    });
    expect(platform.statusCode).toBe(403);

    // reader role → 403 (requireRole)
    const reader = await app.inject({
      method: "POST",
      url: `/api/admin/members/user/${SUBJ_APP}/role-changes`,
      cookies: cookie("reader", INST, REQ),
      payload: { subject_kind: "user", subject_id: SUBJ_APP, role: "reader", action: "grant", scope: "installation" },
    });
    expect(reader.statusCode).toBe(403);

    // second request for the same subject → 409 with the existing pending id
    const concurrent = await app.inject({
      method: "POST",
      url: `/api/admin/members/user/${SUBJ_REQ}/role-changes`,
      cookies: REQUESTER(),
      payload: { subject_kind: "user", subject_id: SUBJ_REQ, role: "reader", action: "grant", scope: "installation" },
    });
    expect(concurrent.statusCode).toBe(409);
    expect(concurrent.json<{ detail: { existing_pending_id: string } }>().detail.existing_pending_id).toBe(
      ok.json<{ pending_id: string }>().pending_id,
    );
    await app.close();
  });

  it("approve: 403 self-approval; 200 by a different user (+ role_grants written); 409 re-approve; 404 absent", async () => {
    const app = await makeApp();
    const created = await app.inject({
      method: "POST",
      url: `/api/admin/members/user/${SUBJ_APP}/role-changes`,
      cookies: REQUESTER(),
      payload: { subject_kind: "user", subject_id: SUBJ_APP, role: "reader", action: "grant", scope: "installation" },
    });
    expect(created.statusCode).toBe(201);
    const pendingId = created.json<{ pending_id: string }>().pending_id;

    // requester approving their own request → 403 (two-person rule)
    const self = await app.inject({
      method: "POST",
      url: `/api/admin/members/role-changes/${pendingId}/approve`,
      cookies: REQUESTER(),
      payload: { approver_user_id: REQ },
    });
    expect(self.statusCode).toBe(403);

    // a different approver → 200 applied
    const applied = await app.inject({
      method: "POST",
      url: `/api/admin/members/role-changes/${pendingId}/approve`,
      cookies: REQUESTER(),
      payload: { approver_user_id: APP },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json<{ state: string }>().state).toBe("applied");
    const grants = await sql`SELECT 1 FROM core.role_grants WHERE subject_id=${SUBJ_APP} AND installation_id=${INST}`.execute(db);
    expect(grants.rows).toHaveLength(1);

    // re-approve → 409 stale
    const stale = await app.inject({
      method: "POST",
      url: `/api/admin/members/role-changes/${pendingId}/approve`,
      cookies: REQUESTER(),
      payload: { approver_user_id: APP },
    });
    expect(stale.statusCode).toBe(409);

    // unknown pending_id → 404; non-uuid → 422
    const absent = await app.inject({
      method: "POST",
      url: `/api/admin/members/role-changes/ad000000-0000-0000-0000-0000000000ff/approve`,
      cookies: REQUESTER(),
      payload: { approver_user_id: APP },
    });
    expect(absent.statusCode).toBe(404);
    const badUuid = await app.inject({
      method: "POST",
      url: `/api/admin/members/role-changes/not-a-uuid/approve`,
      cookies: REQUESTER(),
      payload: { approver_user_id: APP },
    });
    expect(badUuid.statusCode).toBe(422);
    await app.close();
  });

  it("reject: 200 (requester may reject own draft; no role_grants written)", async () => {
    const app = await makeApp();
    const created = await app.inject({
      method: "POST",
      url: `/api/admin/members/user/${SUBJ_REJ}/role-changes`,
      cookies: REQUESTER(),
      payload: { subject_kind: "user", subject_id: SUBJ_REJ, role: "reader", action: "grant", scope: "installation" },
    });
    const pendingId = created.json<{ pending_id: string }>().pending_id;
    const rejected = await app.inject({
      method: "POST",
      url: `/api/admin/members/role-changes/${pendingId}/reject`,
      cookies: REQUESTER(),
      payload: { approver_user_id: REQ }, // self-reject allowed
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json<{ state: string }>().state).toBe("rejected");
    const grants = await sql`SELECT 1 FROM core.role_grants WHERE subject_id=${SUBJ_REJ}`.execute(db);
    expect(grants.rows).toHaveLength(0);
    await app.close();
  });
});
