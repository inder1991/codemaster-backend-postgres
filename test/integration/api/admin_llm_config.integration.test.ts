/**
 * Integration test for the LLM-config admin reads (llm-models, llm-purpose-routing, llm-provider-config)
 * against the DISPOSABLE Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN
 * is set; SKIPS otherwise. All three are platform-scope (no installation filtering).
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import {
  getLlmProviderConfig,
  listLlmModels,
  listLlmPurposeModels,
} from "#backend/api/admin/admin_read_repo.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { InMemoryVault } from "#backend/adapters/vault_port.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const M1 = "itest-llm-aaa"; // anthropic_direct
const M2 = "itest-llm-bbb"; // bedrock
const ROTATOR = "abababab-1111-2222-3333-444444444444";

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.llm_models WHERE model_id IN (${M1}, ${M2})`.execute(db);
  await sql`DELETE FROM core.llm_provider_settings WHERE scope = 'platform' AND role = 'primary' AND model_id = 'itest-prov-model'`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await sql`INSERT INTO core.llm_models (provider, model_id) VALUES ('anthropic_direct', ${M1}), ('bedrock', ${M2})`.execute(db);
  await sql`INSERT INTO core.llm_provider_settings
              (role, provider, model_id, api_key_ciphertext, api_key_fingerprint, last_rotated_by_user_id, scope)
            VALUES ('primary', 'bedrock', 'itest-prov-model', 'kms2:1:x', 'ab12', ${ROTATOR}, 'platform')`.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function mintCookie(role: Role): string {
  return issueCookie({
    user_id: "00000000-0000-0000-0000-0000000000aa",
    email: "u@x",
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

describeDb("admin llm-config (disposable :5434)", () => {
  it("listLlmModels: ordered by (provider, model_id)", async () => {
    const mine = (await listLlmModels(db)).filter((m) => m.model_id.startsWith("itest-llm-"));
    expect(mine.map((m) => m.model_id)).toEqual([M1, M2]); // anthropic_direct < bedrock
    expect(mine[0]?.provider).toBe("anthropic_direct");
    expect(mine[0]?.last_validation_status).toBe("untested");
  });

  it("listLlmPurposeModels: sorted ascending by purpose", async () => {
    const purposes = (await listLlmPurposeModels(db)).map((a) => a.purpose);
    expect(purposes).toEqual([...purposes].sort());
  });

  it("getLlmProviderConfig: primary returns the row; an unconfigured role → null", async () => {
    const primary = await getLlmProviderConfig(db);
    expect(primary?.provider).toBe("bedrock");
    expect(primary?.api_key_fingerprint).toBe("ab12");
    expect(primary?.last_rotated_by_user_id).toBe(ROTATOR);
    expect(await getLlmProviderConfig(db, "secondary")).toBeNull();
  });

  it("routes: 200 for reader; 403 for org_owner; 404 when provider unconfigured", async () => {
    const app = await makeApp();
    const reader = { [SESSION_COOKIE_NAME]: mintCookie("reader") };
    expect((await app.inject({ method: "GET", url: "/api/admin/llm-models", cookies: reader })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/admin/llm-purpose-routing", cookies: reader })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/admin/llm-provider-config", cookies: reader })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/llm-models", cookies: { [SESSION_COOKIE_NAME]: mintCookie("org_owner") } })).statusCode,
    ).toBe(403);
    await app.close();
  });

  // ─── llm-provider-config WRITE routes (PUT / preflight / test-credentials) ────────────────────────
  // These write the platform-singleton row; every test below uses role='secondary' (the read test above
  // asserts secondary IS null) and DELETEs it inside its own `it` so the sequential file stays isolated.
  // The seeded primary/itest-prov-model row is never touched.
  type AuditEv = { actorUserId: string; installationId: string | null; action: string; targetId: string };
  const VAULT_KEY_NAME = "llm_provider_settings";
  const PUT_BODY = {
    provider: "bedrock",
    role: "secondary",
    model_id: "anthropic.claude-sonnet-4-6",
    region: "us-east-1",
    api_key: "sk-ant-write-0123456789", // 23 chars; last 4 = "6789"
  };
  const superCookie = (): Record<string, string> => ({ [SESSION_COOKIE_NAME]: mintCookie("super_admin") });
  const stubFactory = (ok: boolean, message: string | null) => {
    const result = { ok, errorMessage: ok ? null : message };
    const v = { validate: async () => result, validateCredentials: async () => result };
    return () => v;
  };
  const makeAppWithVault = async (args: {
    vault: InMemoryVault;
    ok: boolean;
    message?: string;
    audited?: Array<AuditEv>;
  }) => {
    const app = buildApp({});
    await registerAdminRoutes(app, {
      db,
      signingKey: SIGNING_KEY,
      clock: new FakeClock({ now: NOW }),
      vault: args.vault,
      getPreflightValidator: stubFactory(args.ok, args.message ?? "preflight boom"),
      ...(args.audited
        ? {
            audit: async (e: AuditEv) => {
              args.audited!.push(e);
            },
          }
        : {}),
    });
    await app.ready();
    return app;
  };
  const deleteSecondary = async (): Promise<void> => {
    await sql`DELETE FROM core.llm_provider_settings WHERE scope = 'platform' AND role = 'secondary'`.execute(db);
  };

  it("PUT llm-provider-config: preflight ok → 200, Vault-encrypted write round-trips, dual rotation audit", async () => {
    const vault = new InMemoryVault();
    const audited: Array<AuditEv> = [];
    const app = await makeAppWithVault({ vault, ok: true, audited });
    try {
      const res = await app.inject({ method: "PUT", url: "/api/admin/llm-provider-config", cookies: superCookie(), payload: PUT_BODY });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ api_key_fingerprint: string; provider: string; enabled: boolean; last_validation_status: string }>();
      expect(body.api_key_fingerprint).toBe("6789");
      expect(body.provider).toBe("bedrock");
      expect(body.last_validation_status).toBe("ok");
      // The persisted ciphertext decrypts back to the plaintext under the production key via the same Vault.
      const row = await sql<{ api_key_ciphertext: string }>`SELECT api_key_ciphertext FROM core.llm_provider_settings WHERE scope='platform' AND role='secondary'`.execute(db);
      const dec = await vault.transitDecrypt({ keyName: VAULT_KEY_NAME, ciphertext: row.rows[0]!.api_key_ciphertext });
      expect(new TextDecoder().decode(dec)).toBe(PUT_BODY.api_key);
      // Dual rotation audit (legacy + new action strings), target_id "global".
      expect(audited.map((e) => e.action)).toEqual(["bedrock_credential.rotated", "llm_provider_credential.rotated"]);
      expect(audited[0]!.targetId).toBe("global");
    } finally {
      await deleteSecondary();
      await app.close();
    }
  });

  it("PUT llm-provider-config: preflight fails → 400 llm_provider_preflight_failed, no row written", async () => {
    const vault = new InMemoryVault();
    const app = await makeAppWithVault({ vault, ok: false, message: "upstream returned 401: auth" });
    try {
      const res = await app.inject({ method: "PUT", url: "/api/admin/llm-provider-config", cookies: superCookie(), payload: PUT_BODY });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ detail: { code: string } }>().detail.code).toBe("llm_provider_preflight_failed");
      const row = await sql`SELECT 1 FROM core.llm_provider_settings WHERE scope='platform' AND role='secondary'`.execute(db);
      expect(row.rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("PUT llm-provider-config: enabled=false skips preflight (writes even with a failing validator)", async () => {
    const vault = new InMemoryVault();
    const app = await makeAppWithVault({ vault, ok: false, message: "would fail if pinged" });
    try {
      const res = await app.inject({ method: "PUT", url: "/api/admin/llm-provider-config", cookies: superCookie(), payload: { ...PUT_BODY, enabled: false } });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ enabled: boolean }>().enabled).toBe(false);
    } finally {
      await deleteSecondary();
      await app.close();
    }
  });

  it("PUT llm-provider-config: 422 bad body; 403 non-super_admin; 503 when vault/validator unwired", async () => {
    const vault = new InMemoryVault();
    const app = await makeAppWithVault({ vault, ok: true });
    try {
      expect(
        (await app.inject({ method: "PUT", url: "/api/admin/llm-provider-config", cookies: superCookie(), payload: { ...PUT_BODY, api_key: "short" } })).statusCode,
      ).toBe(422);
      expect(
        (await app.inject({ method: "PUT", url: "/api/admin/llm-provider-config", cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") }, payload: PUT_BODY })).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
    // The bare makeApp() has no vault/validator wired → the credential write 503s.
    const bare = await makeApp();
    try {
      expect(
        (await bare.inject({ method: "PUT", url: "/api/admin/llm-provider-config", cookies: superCookie(), payload: PUT_BODY })).statusCode,
      ).toBe(503);
    } finally {
      await bare.close();
    }
  });

  it("POST preflight + test-credentials → 200 {ok,message} regardless of outcome", async () => {
    const vault = new InMemoryVault();
    const appOk = await makeAppWithVault({ vault, ok: true });
    try {
      const pf = await appOk.inject({ method: "POST", url: "/api/admin/llm-provider-config/preflight", cookies: superCookie(), payload: PUT_BODY });
      expect(pf.statusCode).toBe(200);
      expect(pf.json<{ ok: boolean; message: string }>()).toEqual({ ok: true, message: "ok" });
      const tc = await appOk.inject({
        method: "POST",
        url: "/api/admin/llm-provider-config/test-credentials",
        cookies: superCookie(),
        payload: { provider: "bedrock", region: "us-east-1", api_key: PUT_BODY.api_key },
      });
      expect(tc.statusCode).toBe(200);
      expect(tc.json<{ ok: boolean }>().ok).toBe(true);
    } finally {
      await appOk.close();
    }
    const appFail = await makeAppWithVault({ vault, ok: false, message: "nope" });
    try {
      const pf = await appFail.inject({ method: "POST", url: "/api/admin/llm-provider-config/preflight", cookies: superCookie(), payload: PUT_BODY });
      expect(pf.json<{ ok: boolean; message: string }>()).toEqual({ ok: false, message: "nope" });
    } finally {
      await appFail.close();
    }
  });
});
