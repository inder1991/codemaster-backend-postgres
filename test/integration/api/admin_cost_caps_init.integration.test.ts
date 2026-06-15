/**
 * Integration test for the FIRST-TIME cost-cap config path against the DISPOSABLE Postgres (localhost:5434 —
 * NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set; SKIPS else.
 *
 * Covers the "unconfigured platform" posture that previously 500'd: GET returns settings:null (200), and a
 * direct PUT /api/admin/cost-caps/settings bootstraps the two scope rows (refused 409 once configured).
 *
 * Singletons are SHARED infra (the other cost-cap test files read/seed them). To stay order/shuffle-safe this
 * file DELETES the two settings rows in beforeEach (every test starts unconfigured) and RESTORES them in
 * afterAll so sibling files still find a configured platform. Files run serially (--no-file-parallelism).
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { buildCostCapsPage } from "#backend/api/admin/cost_caps_read.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");

let pool: Pool;
let db: Kysely<unknown>;

async function deleteSettings(): Promise<void> {
  await sql`DELETE FROM core.cost_cap_settings WHERE scope IN ('global', 'per_org_default')`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
});

beforeEach(async () => {
  // Every test starts from the UNCONFIGURED posture (order/shuffle independent).
  if (INTEGRATION_DSN) await deleteSettings();
});

afterAll(async () => {
  // Leave the shared singletons CONFIGURED so sibling cost-cap files (whose approve guard reads them) pass
  // regardless of file order.
  if (INTEGRATION_DSN) {
    await sql`INSERT INTO core.cost_cap_settings (scope, cap_cents, updated_at, updated_by_user_id)
              VALUES ('global', 500000, ${NOW}, NULL), ('per_org_default', 100000, ${NOW}, NULL)
              ON CONFLICT (scope) DO UPDATE SET cap_cents = EXCLUDED.cap_cents, updated_at = EXCLUDED.updated_at`.execute(db);
  }
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

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

const SETTINGS_URL = "/api/admin/cost-caps/settings";
const initBody = (g = 800000, p = 200000): Record<string, unknown> => ({
  schema_version: 1,
  global_cap_cents: g,
  per_org_default_cap_cents: p,
});

describeDb("admin cost-caps first-time config (disposable :5434)", () => {
  it("buildCostCapsPage: settings is null (not a throw) when unconfigured", async () => {
    const page = await buildCostCapsPage(db, NOW);
    expect(page.settings).toBeNull();
    // The rest of the page still assembles — an unconfigured platform is a valid 200 state.
    expect(Array.isArray(page.overrides)).toBe(true);
    expect(typeof page.todays_spend_global_cents).toBe("number");
  });

  it("GET /api/admin/cost-caps: 200 with settings:null when unconfigured (was 500)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/cost-caps",
      cookies: cookie("platform_owner"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ settings: unknown }>().settings).toBeNull();
    await app.close();
  });

  it("PUT .../settings: initializes the two caps (direct write), then 409 on re-init", async () => {
    const app = await makeApp();
    const created = await app.inject({
      method: "PUT",
      url: SETTINGS_URL,
      cookies: cookie("platform_owner"),
      payload: initBody(800000, 200000),
    });
    expect(created.statusCode).toBe(200);
    const page = created.json<{ settings: { global_cap_cents: number; per_org_default_cap_cents: number } | null }>();
    expect(page.settings?.global_cap_cents).toBe(800000);
    expect(page.settings?.per_org_default_cap_cents).toBe(200000);

    // Rows really landed in the DB.
    const rows = await sql<{ scope: string; cap_cents: string | number }>`
      SELECT scope, cap_cents FROM core.cost_cap_settings WHERE scope IN ('global', 'per_org_default') ORDER BY scope
    `.execute(db);
    expect(rows.rows.map((r) => r.scope)).toEqual(["global", "per_org_default"]);

    // Already configured → the two-person change flow owns further edits.
    const second = await app.inject({
      method: "PUT",
      url: SETTINGS_URL,
      cookies: cookie("platform_owner"),
      payload: initBody(900000, 300000),
    });
    expect(second.statusCode).toBe(409);
    // The 409 must NOT have weakened/overwritten the first values.
    const after = await app.inject({ method: "GET", url: "/api/admin/cost-caps", cookies: cookie("platform_owner") });
    expect(after.json<{ settings: { global_cap_cents: number } | null }>().settings?.global_cap_cents).toBe(800000);
    await app.close();
  });

  it("PUT .../settings: concurrent first-time inits → exactly one 200 + one 409 (advisory-lock serialised)", async () => {
    const app = await makeApp();
    // Two operators bootstrap simultaneously on the empty table. Without serialisation BOTH would 200 and
    // one write would be silently lost (ON CONFLICT DO NOTHING). The advisory lock guarantees a single winner.
    const [a, b] = await Promise.all([
      app.inject({ method: "PUT", url: SETTINGS_URL, cookies: cookie("platform_owner"), payload: initBody(800000, 200000) }),
      app.inject({ method: "PUT", url: SETTINGS_URL, cookies: cookie("platform_owner"), payload: initBody(900000, 300000) }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    // The persisted cap is the winner's value — a real write, never a lost one.
    const row = await sql<{ cap_cents: string | number }>`
      SELECT cap_cents FROM core.cost_cap_settings WHERE scope = 'global'
    `.execute(db);
    expect([800000, 900000]).toContain(Number(row.rows[0]!.cap_cents));
    await app.close();
  });

  it("POST .../changes: 409 on an unconfigured platform (no un-approvable orphan pending change)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/cost-caps/changes",
      cookies: cookie("platform_owner"),
      payload: { schema_version: 1, target_kind: "global", target_id: null, new_cap_cents: 700000, expires_at: null },
    });
    // 409 = the guard fired BEFORE insertPendingChange (no orphan row created); must bootstrap first.
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("PUT .../settings: 422 when a cap exceeds the hard ceiling", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: SETTINGS_URL,
      cookies: cookie("platform_owner"),
      payload: initBody(5_000_001, 200000), // > 5_000_000 ceiling
    });
    expect(res.statusCode).toBe(422);
    expect((await buildCostCapsPage(db, NOW)).settings).toBeNull(); // nothing written
    await app.close();
  });

  it("PUT .../settings: 403 for a reader (super_admin / platform_owner only)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: SETTINGS_URL,
      cookies: cookie("reader"),
      payload: initBody(),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
