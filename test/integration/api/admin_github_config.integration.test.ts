// Integration test for the GitHub-config admin routes (go-live Step 4b) against the disposable PG.
// Runs ONLY when CODEMASTER_PG_CORE_DSN is set. Proves PUT writes + GET returns the non-secret view.

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import {
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIBfake\n-----END RSA PRIVATE KEY-----";
const reg = new KeyRegistry();
reg.set(makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(3)]]) }));

let pool: Pool;
let db: Kysely<unknown>;

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

describeDb("admin github-config (disposable)", () => {
  beforeAll(() => {
    if (!INTEGRATION_DSN) return;
    setAuditKeyRegistry(reg);
    pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  });
  beforeEach(async () => {
    await sql`DELETE FROM core.github_app_settings WHERE scope = 'platform'`.execute(db);
  });
  afterAll(async () => {
    resetAuditKeyRegistryForTesting();
    await db?.destroy();
  });

  it("PUT (super_admin) writes; GET returns configured WITHOUT secrets", async () => {
    const app = await makeApp();
    const put = await app.inject({
      method: "PUT",
      url: "/api/admin/github-config",
      cookies: cookie("super_admin"),
      payload: { app_id: "123456", private_key_pem: PEM, webhook_secret: "whsec-abc" },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: "GET", url: "/api/admin/github-config", cookies: cookie("super_admin") });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ configured: true, appId: "123456", enabled: true });
    expect(get.body).not.toContain("whsec-abc"); // never returns secrets
    expect(get.body).not.toContain("RSA PRIVATE KEY");
    await app.close();
  });

  it("PUT emits a github_app_settings.rotated audit event with NO secrets in the payload (P1)", async () => {
    const audited: Array<{ action: string; after: unknown }> = [];
    const app = buildApp({});
    await registerAdminRoutes(app, {
      db,
      signingKey: SIGNING_KEY,
      clock: new FakeClock({ now: NOW }),
      audit: async (e) => {
        audited.push({ action: e.action, after: e.after });
      },
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/admin/github-config",
        cookies: cookie("super_admin"),
        payload: { app_id: "123456", private_key_pem: PEM, webhook_secret: "whsec-abc" },
      });
      expect(res.statusCode).toBe(200);
      expect(audited).toHaveLength(1);
      expect(audited[0]?.action).toBe("github_app_settings.rotated");
      const after = JSON.stringify(audited[0]?.after);
      expect(after).not.toContain("whsec-abc");
      expect(after).not.toContain("RSA PRIVATE KEY");
      expect(after).toContain("123456"); // app_id IS recorded (non-secret)
    } finally {
      await app.close();
    }
  });

  it("PUT is 403 for non-super_admin and 422 on a bad body", async () => {
    const app = await makeApp();
    expect(
      (await app.inject({ method: "PUT", url: "/api/admin/github-config", cookies: cookie("platform_owner"), payload: { app_id: "1", private_key_pem: PEM, webhook_secret: "w" } })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "PUT", url: "/api/admin/github-config", cookies: cookie("super_admin"), payload: { app_id: "1" } })).statusCode,
    ).toBe(422);
    await app.close();
  });

  it("GET returns configured:false when unconfigured", async () => {
    const app = await makeApp();
    const get = await app.inject({ method: "GET", url: "/api/admin/github-config", cookies: cookie("super_admin") });
    expect(get.json()).toEqual({ configured: false });
    await app.close();
  });
});
