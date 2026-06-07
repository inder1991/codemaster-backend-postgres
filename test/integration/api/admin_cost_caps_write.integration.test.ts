/**
 * Integration test for the cost-cap WRITE routes (POST /changes [+/approve, /reject]) against the
 * DISPOSABLE Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set.
 * Uses per_org_override targets (own rows) so it never touches the shared settings singletons.
 *
 * Note: cost-cap approve/reject take NO body — the approver IS the session user, so a SECOND approver is a
 * second cookie (user_id=APP), and a self-approve is the requester's own cookie (user_id=REQ).
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
const REQ = "af000000-0000-0000-0000-000000000010";
const APP = "af000000-0000-0000-0000-000000000011";
const OV_R = "af000000-0000-0000-0000-00000000000a";
const OV_A = "af000000-0000-0000-0000-00000000000b";
const OV_J = "af000000-0000-0000-0000-00000000000c";

let pool: Pool;
let db: Kysely<unknown>;

async function ensureSettings(): Promise<void> {
  await sql`INSERT INTO core.cost_cap_settings (scope, cap_cents, updated_at, updated_by_user_id)
            VALUES ('global', 1000000, ${NOW}, ${REQ}), ('per_org_default', 500000, ${NOW}, ${REQ})
            ON CONFLICT (scope) DO NOTHING`.execute(db);
}

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.cost_cap_pending_changes WHERE requested_by_user_id IN (${REQ}, ${APP})`.execute(db);
  await sql`DELETE FROM core.cost_cap_overrides WHERE installation_id IN (${OV_R}, ${OV_A}, ${OV_J})`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id IN (${OV_R}, ${OV_A}, ${OV_J})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  for (const inst of [OV_R, OV_A, OV_J]) {
    await sql`INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
              VALUES (${inst}, ${994000000 + Number.parseInt(inst.slice(-1), 16)}, ${"itest-ccw-" + inst.slice(-1)}, 'Organization')`.execute(db);
  }
  await ensureSettings();
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function cookie(role: Role, userId: string): Record<string, string> {
  return {
    [SESSION_COOKIE_NAME]: issueCookie({
      user_id: userId,
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
const REQUESTER = () => cookie("platform_owner", REQ);
const APPROVER = () => cookie("platform_owner", APP);

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

function ovBody(targetId: string | null, newCap = 900000): Record<string, unknown> {
  return { schema_version: 1, target_kind: "per_org_override", target_id: targetId, new_cap_cents: newCap, expires_at: null };
}

describeDb("admin cost-caps write routes (disposable :5434)", () => {
  it("request: 202; 403 reader; 422 over-ceiling; 400 bad target consistency; 409 concurrent", async () => {
    const app = await makeApp();
    const ok = await app.inject({ method: "POST", url: "/api/admin/cost-caps/changes", cookies: REQUESTER(), payload: ovBody(OV_R) });
    expect(ok.statusCode).toBe(202);
    expect(ok.json<{ state: string }>().state).toBe("pending");

    expect((await app.inject({ method: "POST", url: "/api/admin/cost-caps/changes", cookies: cookie("reader", REQ), payload: ovBody(OV_A) })).statusCode).toBe(403);
    // new_cap_cents over the hard ceiling → 422 (contract)
    expect((await app.inject({ method: "POST", url: "/api/admin/cost-caps/changes", cookies: REQUESTER(), payload: ovBody(OV_A, 9_999_999) })).statusCode).toBe(422);
    // per_org_override without target_id → 400
    expect((await app.inject({ method: "POST", url: "/api/admin/cost-caps/changes", cookies: REQUESTER(), payload: ovBody(null) })).statusCode).toBe(400);
    // global WITH a target_id → 400
    expect(
      (await app.inject({ method: "POST", url: "/api/admin/cost-caps/changes", cookies: REQUESTER(), payload: { schema_version: 1, target_kind: "global", target_id: OV_A, new_cap_cents: 100, expires_at: null } })).statusCode,
    ).toBe(400);
    // 2nd change for the same scope → 409 with the existing id
    const conflict = await app.inject({ method: "POST", url: "/api/admin/cost-caps/changes", cookies: REQUESTER(), payload: ovBody(OV_R) });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ detail: { existing_pending_change_id: string } }>().detail.existing_pending_change_id).toBe(
      ok.json<{ pending_change_id: string }>().pending_change_id,
    );
    await app.close();
  });

  it("approve: 403 self; 200 by a 2nd user (+ override written); 409 re-approve; 404 absent; 422 bad uuid", async () => {
    const app = await makeApp();
    await ensureSettings();
    const created = await app.inject({ method: "POST", url: "/api/admin/cost-caps/changes", cookies: REQUESTER(), payload: ovBody(OV_A) });
    const id = created.json<{ pending_change_id: string }>().pending_change_id;

    expect((await app.inject({ method: "POST", url: `/api/admin/cost-caps/changes/${id}/approve`, cookies: REQUESTER() })).statusCode).toBe(403);
    const applied = await app.inject({ method: "POST", url: `/api/admin/cost-caps/changes/${id}/approve`, cookies: APPROVER() });
    expect(applied.statusCode).toBe(200);
    expect(applied.json<{ state: string }>().state).toBe("applied");
    const ov = await sql<{ cap_cents: string | number }>`SELECT cap_cents FROM core.cost_cap_overrides WHERE installation_id = ${OV_A}`.execute(db);
    expect(Number(ov.rows[0]!.cap_cents)).toBe(900000);

    expect((await app.inject({ method: "POST", url: `/api/admin/cost-caps/changes/${id}/approve`, cookies: APPROVER() })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/admin/cost-caps/changes/af000000-0000-0000-0000-0000000000ff/approve`, cookies: APPROVER() })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/admin/cost-caps/changes/not-a-uuid/approve`, cookies: APPROVER() })).statusCode).toBe(422);
    await app.close();
  });

  it("reject: 403 self (two-person); 200 by a 2nd user", async () => {
    const app = await makeApp();
    const created = await app.inject({ method: "POST", url: "/api/admin/cost-caps/changes", cookies: REQUESTER(), payload: ovBody(OV_J) });
    const id = created.json<{ pending_change_id: string }>().pending_change_id;
    expect((await app.inject({ method: "POST", url: `/api/admin/cost-caps/changes/${id}/reject`, cookies: REQUESTER() })).statusCode).toBe(403);
    const rejected = await app.inject({ method: "POST", url: `/api/admin/cost-caps/changes/${id}/reject`, cookies: APPROVER() });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json<{ state: string }>().state).toBe("rejected");
    await app.close();
  });
});
