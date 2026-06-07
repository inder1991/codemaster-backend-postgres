/**
 * Integration test for the notification-rules WRITE routes (POST create / PATCH / DELETE / POST dry-run)
 * against the DISPOSABLE Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN
 * is set. Covers 201/204/200, 403 (reader + platform_operator can't mutate), 404, 422 (bad uuid / cron / recipient).
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
const SLACK = { schema_version: 1, type: "slack", channel: "#alerts" };

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.notification_rules WHERE name LIKE 'itest-nrw-%'`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
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
const OWNER = () => cookie("platform_owner");

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

function createBody(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, trigger_event: "pr.opened", filters: {}, recipients: [SLACK], schedule_cron: "0 9 * * *", ...extra };
}

describeDb("admin notification-rules write routes (disposable :5434)", () => {
  it("create: 201 owner; 403 reader + platform_operator; 422 bad cron + bad recipient", async () => {
    const app = await makeApp();
    const ok = await app.inject({
      method: "POST",
      url: "/api/admin/notification-rules",
      cookies: OWNER(),
      payload: createBody("itest-nrw-create"),
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ state: string; rule_id: string }>().state).toBe("active");

    expect(
      (await app.inject({ method: "POST", url: "/api/admin/notification-rules", cookies: cookie("reader"), payload: createBody("itest-nrw-r") })).statusCode,
    ).toBe(403);
    // platform_operator can READ notification-rules but NOT mutate
    expect(
      (await app.inject({ method: "POST", url: "/api/admin/notification-rules", cookies: cookie("platform_operator"), payload: createBody("itest-nrw-o") })).statusCode,
    ).toBe(403);
    // invalid cron → 422
    expect(
      (await app.inject({ method: "POST", url: "/api/admin/notification-rules", cookies: OWNER(), payload: createBody("itest-nrw-c", { schedule_cron: "not a cron" }) })).statusCode,
    ).toBe(422);
    // invalid recipient (slack channel without #/C prefix) → 422
    expect(
      (await app.inject({ method: "POST", url: "/api/admin/notification-rules", cookies: OWNER(), payload: createBody("itest-nrw-rc", { recipients: [{ schema_version: 1, type: "slack", channel: "bad" }] }) })).statusCode,
    ).toBe(422);
    await app.close();
  });

  it("patch: 200 partial update; 404 unknown; 422 bad uuid + bad cron", async () => {
    const app = await makeApp();
    const created = await app.inject({ method: "POST", url: "/api/admin/notification-rules", cookies: OWNER(), payload: createBody("itest-nrw-patch") });
    const ruleId = created.json<{ rule_id: string }>().rule_id;
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/admin/notification-rules/${ruleId}`,
      cookies: OWNER(),
      payload: { name: "itest-nrw-patched", state: "paused" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<{ name: string; state: string; trigger_event: string }>().name).toBe("itest-nrw-patched");
    expect(patched.json<{ state: string }>().state).toBe("paused");
    expect(patched.json<{ trigger_event: string }>().trigger_event).toBe("pr.opened"); // untouched

    expect(
      (await app.inject({ method: "PATCH", url: `/api/admin/notification-rules/be000000-0000-0000-0000-0000000000ff`, cookies: OWNER(), payload: { name: "itest-nrw-x" } })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "PATCH", url: `/api/admin/notification-rules/not-a-uuid`, cookies: OWNER(), payload: { name: "itest-nrw-x" } })).statusCode,
    ).toBe(422);
    expect(
      (await app.inject({ method: "PATCH", url: `/api/admin/notification-rules/${ruleId}`, cookies: OWNER(), payload: { schedule_cron: "bogus bogus" } })).statusCode,
    ).toBe(422);
    await app.close();
  });

  it("delete: 204 then 404; 422 bad uuid", async () => {
    const app = await makeApp();
    const created = await app.inject({ method: "POST", url: "/api/admin/notification-rules", cookies: OWNER(), payload: createBody("itest-nrw-delete") });
    const ruleId = created.json<{ rule_id: string }>().rule_id;
    expect((await app.inject({ method: "DELETE", url: `/api/admin/notification-rules/${ruleId}`, cookies: OWNER() })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/notification-rules/${ruleId}`, cookies: OWNER() })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/notification-rules/not-a-uuid`, cookies: OWNER() })).statusCode).toBe(422);
    await app.close();
  });

  it("dry-run: 200 returns recipient summaries; 404 unknown", async () => {
    const app = await makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/notification-rules",
      cookies: OWNER(),
      payload: createBody("itest-nrw-dry", {
        recipients: [SLACK, { schema_version: 1, type: "webhook", url: "https://h/x", secret_vault_path: "kv/p" }],
      }),
    });
    const ruleId = created.json<{ rule_id: string }>().rule_id;
    const dry = await app.inject({ method: "POST", url: `/api/admin/notification-rules/${ruleId}/dry-run`, cookies: OWNER() });
    expect(dry.statusCode).toBe(200);
    const summaries = dry.json<{ would_dispatch_to: Array<Record<string, string>> }>().would_dispatch_to;
    expect(summaries).toEqual([
      { type: "slack", channel: "#alerts" },
      { type: "webhook", secret_vault_path: "kv/p" }, // url dropped
    ]);
    expect(
      (await app.inject({ method: "POST", url: `/api/admin/notification-rules/be000000-0000-0000-0000-0000000000ff/dry-run`, cookies: OWNER() })).statusCode,
    ).toBe(404);
    await app.close();
  });
});
