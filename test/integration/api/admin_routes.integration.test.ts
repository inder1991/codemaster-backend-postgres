/**
 * Integration test for the admin READ routes (batch 1: orgs + dashboard) against the DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set; SKIPS otherwise.
 *
 * Seeds two installations (each with a repository so it surfaces in the orgs JOIN) and exercises the repo
 * query (platform-view vs tenant-scoped) + the Fastify routes via inject with minted session cookies.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { listOrgs } from "#backend/api/admin/admin_read_repo.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";
import { SUPER_ADMIN_PLATFORM_VIEW_UUID } from "#backend/infra/sentinels.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INSTALL_MINE = "dddddddd-1111-2222-3333-444444444444";
const INSTALL_OTHER = "eeeeeeee-1111-2222-3333-444444444444";
const ORG_MINE = "itest-admin-org-mine";
const ORG_OTHER = "itest-admin-org-other";

let pool: Pool;
let db: Kysely<unknown>;

async function seedInstallWithRepo(installId: string, org: string, ghBase: number): Promise<void> {
  await sql`
    INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
    VALUES (${installId}, ${ghBase}, ${org}, 'Organization') ON CONFLICT (installation_id) DO NOTHING
  `.execute(db);
  await sql`
    INSERT INTO core.repositories (installation_id, github_repo_id, full_name, default_branch)
    VALUES (${installId}, ${ghBase + 1}, ${org + "/repo"}, 'main')
  `.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await sql`DELETE FROM core.repositories WHERE installation_id IN (${INSTALL_MINE}, ${INSTALL_OTHER})`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id IN (${INSTALL_MINE}, ${INSTALL_OTHER})`.execute(db);
  await seedInstallWithRepo(INSTALL_MINE, ORG_MINE, 930000010);
  await seedInstallWithRepo(INSTALL_OTHER, ORG_OTHER, 930000020);
});

afterAll(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.repositories WHERE installation_id IN (${INSTALL_MINE}, ${INSTALL_OTHER})`.execute(db);
    await sql`DELETE FROM core.installations WHERE installation_id IN (${INSTALL_MINE}, ${INSTALL_OTHER})`.execute(db);
  }
  await db?.destroy();
});

function mintCookie(role: Role, installationId: string | null): string {
  return issueCookie({
    user_id: "00000000-0000-0000-0000-0000000000aa",
    email: "u@x",
    role,
    auth_source: installationId === null ? "local" : "core_local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: installationId,
  });
}

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

describeDb("admin READ routes (disposable :5434)", () => {
  it("listOrgs: platform-view sees all orgs; tenant-scoped sees only its own; foreign install → none", async () => {
    expect(await listOrgs(db, SUPER_ADMIN_PLATFORM_VIEW_UUID)).toEqual(
      expect.arrayContaining([ORG_MINE, ORG_OTHER]),
    );
    expect(await listOrgs(db, INSTALL_MINE)).toEqual([ORG_MINE]);
    expect(await listOrgs(db, "ffffffff-ffff-ffff-ffff-ffffffffffff")).toEqual([]);
  });

  it("GET /api/admin/orgs — super_admin sees all; platform_operator scoped to its install", async () => {
    const app = await makeApp();
    const sa = await app.inject({
      method: "GET",
      url: "/api/admin/orgs",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("super_admin", null) },
    });
    expect(sa.statusCode).toBe(200);
    expect(sa.json<{ orgs: Array<string> }>().orgs).toEqual(expect.arrayContaining([ORG_MINE, ORG_OTHER]));

    const scoped = await app.inject({
      method: "GET",
      url: "/api/admin/orgs",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_operator", INSTALL_MINE) },
    });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json<{ orgs: Array<string> }>().orgs).toEqual([ORG_MINE]);
    await app.close();
  });

  it("GET /api/admin/orgs — 401 without cookie, 403 for a reader", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/api/admin/orgs" })).statusCode).toBe(401);
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/orgs",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader", null) },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });

  it("GET /api/admin/dashboard — 200 static for platform_owner, 403 for platform_operator", async () => {
    const app = await makeApp();
    const ok = await app.inject({
      method: "GET",
      url: "/api/admin/dashboard",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner", null) },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ services: Array<{ name: string }> }>().services).toHaveLength(4);

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/dashboard",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_operator", null) },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });
});
