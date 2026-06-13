// Integration test for the Confluence-config admin routes (go-live Step 4c) against the disposable PG.
// Runs ONLY when CODEMASTER_PG_CORE_DSN is set. Proves PUT writes + GET returns the non-secret view +
// the audit event carries no token. Mirrors admin_github_config.integration.test.ts.

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
const reg = new KeyRegistry();
reg.set(makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(2)]]) }));
const BASE_URL = "https://acme.atlassian.net/wiki";

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

describeDb("admin confluence-config (disposable)", () => {
  beforeAll(() => {
    if (!INTEGRATION_DSN) return;
    setAuditKeyRegistry(reg);
    pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  });
  beforeEach(async () => {
    await sql`DELETE FROM core.confluence_settings WHERE scope = 'platform'`.execute(db);
  });
  afterAll(async () => {
    resetAuditKeyRegistryForTesting();
    await db?.destroy();
  });

  it("PUT (super_admin) writes; GET returns configured WITHOUT the token", async () => {
    const app = await makeApp();
    const put = await app.inject({
      method: "PUT",
      url: "/api/admin/confluence-config",
      cookies: cookie("super_admin"),
      payload: { base_url: BASE_URL, auth_email: "bot@acme.com", token: "secret-token-xyz" },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: "GET", url: "/api/admin/confluence-config", cookies: cookie("super_admin") });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ configured: true, baseUrl: BASE_URL, authEmail: "bot@acme.com", enabled: true });
    expect(get.body).not.toContain("secret-token-xyz"); // never returns the token
    await app.close();
  });

  it("PUT emits a confluence_settings.rotated audit event with NO token in the payload", async () => {
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
        url: "/api/admin/confluence-config",
        cookies: cookie("super_admin"),
        payload: { base_url: BASE_URL, token: "secret-token-xyz" }, // PAT (no auth_email)
      });
      expect(res.statusCode).toBe(200);
      expect(audited).toHaveLength(1);
      expect(audited[0]?.action).toBe("confluence_settings.rotated");
      expect(JSON.stringify(audited[0]?.after)).not.toContain("secret-token-xyz");
    } finally {
      await app.close();
    }
  });

  it("PUT is 403 for non-super_admin and 422 on a bad body (missing token, non-URL base_url)", async () => {
    const app = await makeApp();
    expect(
      (await app.inject({ method: "PUT", url: "/api/admin/confluence-config", cookies: cookie("platform_owner"), payload: { base_url: BASE_URL, token: "t" } })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "PUT", url: "/api/admin/confluence-config", cookies: cookie("super_admin"), payload: { base_url: BASE_URL } })).statusCode,
    ).toBe(422);
    expect(
      (await app.inject({ method: "PUT", url: "/api/admin/confluence-config", cookies: cookie("super_admin"), payload: { base_url: "not-a-url", token: "t" } })).statusCode,
    ).toBe(422);
    await app.close();
  });

  it("GET returns configured:false when unconfigured", async () => {
    const app = await makeApp();
    const get = await app.inject({ method: "GET", url: "/api/admin/confluence-config", cookies: cookie("super_admin") });
    expect(get.json()).toEqual({ configured: false });
    await app.close();
  });
});
