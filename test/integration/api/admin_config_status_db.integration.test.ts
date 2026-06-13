// P1 integration: /config-status reflects the DB (UI-saved) tier, not just env/file. The exact gap the
// review found — after PUT github-config the checklist still showed "pending". Exercises the DEFAULT
// configStatusProvider (no stub) against the disposable PG. Runs ONLY when CODEMASTER_PG_CORE_DSN is set.

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { PostgresGitHubAppSettingsRepo } from "#backend/integrations/github/github_app_settings_repo.js";
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
const ROTATOR = "abababab-1111-2222-3333-444444444444";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIBfake\n-----END RSA PRIVATE KEY-----";
const reg = new KeyRegistry();
reg.set(makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(4)]]) }));

type ConfigItem = { key: string; state: string; source: string };

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

async function statusItems(): Promise<Array<ConfigItem>> {
  const app = buildApp({});
  // No configStatusProvider stub → exercises the DEFAULT provider (the env/file + DB tier).
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/config-status",
      cookies: cookie("platform_operator"),
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: Array<ConfigItem> }).items;
  } finally {
    await app.close();
  }
}

describeDb("admin config-status — DB tier (P1)", () => {
  beforeAll(() => {
    if (!INTEGRATION_DSN) return;
    setAuditKeyRegistry(reg);
    pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  });
  beforeEach(async () => {
    // The DEFAULT config-status provider decrypts the github + confluence + llm singleton rows. Clean ALL
    // THREE (not just the two this file seeds) so a leftover row from another admin-config test — encrypted
    // with a DIFFERENT per-file key — can't make the provider's decrypt throw (500) under shuffled serial
    // runs (the P2 cross-file flake: every failing run was "expected 500 to be 200").
    await sql`DELETE FROM core.github_app_settings WHERE scope = 'platform'`.execute(db);
    await sql`DELETE FROM core.llm_provider_settings WHERE scope = 'platform'`.execute(db);
    await sql`DELETE FROM core.confluence_settings WHERE scope = 'platform'`.execute(db);
  });
  afterAll(async () => {
    // Don't leak seeded singleton rows to the next shuffled file (P2 flake #14): a leftover platform
    // llm row would collide with another file's beforeAll INSERT (ux_llm_provider_settings_scope_role_install),
    // and a leftover foreign-key-encrypted row would make config-status's decrypt throw (500). Clean broadly.
    await sql`DELETE FROM core.github_app_settings WHERE scope = 'platform'`.execute(db);
    await sql`DELETE FROM core.llm_provider_settings WHERE scope = 'platform'`.execute(db);
    await sql`DELETE FROM core.confluence_settings WHERE scope = 'platform'`.execute(db);
    resetAuditKeyRegistryForTesting();
    await db?.destroy();
  });

  it("a UI-saved github row → github_app.* configured/db; an llm row → llm.provider configured", async () => {
    await new PostgresGitHubAppSettingsRepo({ db, registry: reg }).write({
      appId: "123456",
      privateKeyPem: PEM,
      webhookSecret: "whsec",
      enabled: true,
      rotatedByUserId: ROTATOR,
    });
    await sql`INSERT INTO core.llm_provider_settings
                (role, provider, model_id, api_key_ciphertext, api_key_fingerprint, last_rotated_by_user_id, scope)
              VALUES ('primary', 'bedrock', 'm', 'kms2:1:x', 'ab12', ${ROTATOR}, 'platform')`.execute(db);

    const items = await statusItems();
    const github = items.filter((i) => i.key.startsWith("github_app."));
    expect(github.length).toBeGreaterThan(0);
    expect(github.every((i) => i.state === "configured" && i.source === "db")).toBe(true);
    expect(items.find((i) => i.key === "llm.provider")).toMatchObject({
      state: "configured",
      source: "db",
    });
  });

  it("with no DB rows, github_app.* stay pending and llm.provider is pending", async () => {
    const items = await statusItems();
    expect(items.filter((i) => i.key.startsWith("github_app.")).every((i) => i.state === "pending")).toBe(
      true,
    );
    expect(items.find((i) => i.key === "llm.provider")?.state).toBe("pending");
  });
});
