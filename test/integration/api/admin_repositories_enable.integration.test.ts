/**
 * Integration test for PUT /api/admin/repositories/{github_repo_id}/enable against the DISPOSABLE Postgres
 * (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set.
 * super_admin only; CAS flip of core.repositories.enabled, idempotent, 404 unknown.
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
const INST = "b0000000-0000-0000-0000-000000000001";
const REPO = "b0000000-0000-0000-0000-000000000002";
const GHREPO = 995000010;

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.repositories WHERE repository_id = ${REPO}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${INST}`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await sql`INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
            VALUES (${INST}, 995000001, 'itest-repoen', 'Organization')`.execute(db);
  await sql`INSERT INTO core.repositories (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
            VALUES (${REPO}, ${INST}, ${GHREPO}, 'org/repo', 'main', false)`.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function cookie(role: Role): Record<string, string> {
  return {
    [SESSION_COOKIE_NAME]: issueCookie({
      user_id: "00000000-0000-0000-0000-0000000000aa",
      email: "u@x",
      role,
      auth_source: "local",
      ldap_groups: [],
      now: NOW,
      signing_key: SIGNING_KEY,
      installation_id: null,
    }),
  };
}
const SA = () => cookie("super_admin");

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

describeDb("admin repositories enable (disposable :5434)", () => {
  it("enable flip (CAS), idempotent re-PUT, disable, 404, 422, 403", async () => {
    const app = await makeApp();
    const url = `/api/admin/repositories/${GHREPO}/enable`;

    const on = await app.inject({ method: "PUT", url, cookies: SA(), payload: { enabled: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json<{ enabled: boolean; github_repo_id: number }>().enabled).toBe(true);
    expect(on.json<{ github_repo_id: number }>().github_repo_id).toBe(GHREPO);

    // idempotent: enabling an already-enabled repo → 200 no-op
    const again = await app.inject({ method: "PUT", url, cookies: SA(), payload: { enabled: true } });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ enabled: boolean }>().enabled).toBe(true);

    const off = await app.inject({ method: "PUT", url, cookies: SA(), payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json<{ enabled: boolean }>().enabled).toBe(false);

    // unknown repo → 404
    expect((await app.inject({ method: "PUT", url: "/api/admin/repositories/999999999/enable", cookies: SA(), payload: { enabled: true } })).statusCode).toBe(404);
    // non-int path → 422
    expect((await app.inject({ method: "PUT", url: "/api/admin/repositories/not-an-int/enable", cookies: SA(), payload: { enabled: true } })).statusCode).toBe(422);
    // bad body → 422
    expect((await app.inject({ method: "PUT", url, cookies: SA(), payload: { enabled: "yes" } })).statusCode).toBe(422);
    // platform_owner is NOT allowed (super_admin only) → 403
    expect((await app.inject({ method: "PUT", url, cookies: cookie("platform_owner"), payload: { enabled: true } })).statusCode).toBe(403);
    await app.close();
  });
});
