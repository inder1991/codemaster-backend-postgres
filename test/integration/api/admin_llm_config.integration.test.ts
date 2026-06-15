/**
 * Integration test for the LLM-config admin reads (llm-models, llm-purpose-routing, llm-provider-config)
 * against the DISPOSABLE Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN
 * is set; SKIPS otherwise. All three are platform-scope (no installation filtering).
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { decryptField, encryptField } from "#platform/crypto/aes_gcm_aad.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

import { buildApp } from "#backend/api/app.js";
import {
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";
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
// The field-encryption registry the LLM routes decrypt with (boot-installed in prod; here installed
// in beforeAll). Seeds/asserts use the SAME registry + per-column AAD.
const LLM_API_KEY_AAD = new TextEncoder().encode("core.llm_provider_settings.api_key_ciphertext");
const fieldRegistry = new KeyRegistry();
fieldRegistry.set(
  makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(7)]]) }),
);

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.llm_models WHERE model_id IN (${M1}, ${M2})`.execute(db);
  // Broad (all platform llm rows, not just this file's model) so a leftover platform row from another
  // shuffled file can't collide with this file's beforeAll INSERT (P2 flake #14: duplicate key on
  // ux_llm_provider_settings_scope_role_install).
  await sql`DELETE FROM core.llm_provider_settings WHERE scope = 'platform'`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  setAuditKeyRegistry(fieldRegistry); // the LLM routes decrypt the api key via this registry
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
  resetAuditKeyRegistryForTesting();
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
      // W4.7 / EL1 — the PUT re-reads the slot it just WROTE (the Python read_metadata_for_ui(primary)
      // quirk returned the PRIMARY slot's body for a secondary write, and 500'd with no primary row).
      const body = res.json<{ api_key_fingerprint: string; provider: string; model_id: string }>();
      expect(body.provider).toBe("bedrock");
      expect(body.model_id).toBe(PUT_BODY.model_id); // the SECONDARY we just wrote
      expect(body.api_key_fingerprint).toBe("6789"); // last 4 of the written key
      // But the SECONDARY slot WAS written — its ciphertext decrypts back to the plaintext under the same Vault.
      const row = await sql<{ api_key_ciphertext: string }>`SELECT api_key_ciphertext FROM core.llm_provider_settings WHERE scope='platform' AND role='secondary'`.execute(db);
      const dec = decryptField({ ciphertext: row.rows[0]!.api_key_ciphertext, registry: fieldRegistry, aad: LLM_API_KEY_AAD });
      expect(new TextDecoder().decode(dec)).toBe(PUT_BODY.api_key);
      // Dual rotation audit (legacy + new action strings), target_id "global".
      expect(audited.map((e) => e.action)).toEqual(["bedrock_credential.rotated", "llm_provider_credential.rotated"]);
      expect(audited[0]!.targetId).toBe("global");
    } finally {
      await deleteSecondary();
      await app.close();
    }
  });

  it("PUT llm-provider-config: accepts a region-prefixed Bedrock inference-profile model_id (us.anthropic.…)", async () => {
    // gate 4: the model_id prefix gate was dropped; the (stubbed) preflight is the validator. Proves the
    // region-prefixed shape survives parse → preflight → DB write → response.
    const vault = new InMemoryVault();
    const app = await makeAppWithVault({ vault, ok: true });
    const PROFILE = "us.anthropic.claude-sonnet-4-6-v1:0";
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/admin/llm-provider-config",
        cookies: superCookie(),
        payload: { ...PUT_BODY, model_id: PROFILE },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ model_id: string }>().model_id).toBe(PROFILE);
      const row = await sql<{ model_id: string }>`SELECT model_id FROM core.llm_provider_settings WHERE scope='platform' AND role='secondary'`.execute(db);
      expect(row.rows[0]!.model_id).toBe(PROFILE);
    } finally {
      await deleteSecondary();
      await app.close();
    }
  });

  it("PUT llm-provider-config: EL1 — a secondary write with NO primary row still 200s with the secondary's metadata", async () => {
    const vault = new InMemoryVault();
    const app = await makeAppWithVault({ vault, ok: true });
    // Remove the seeded primary so the legacy primary re-read would find nothing (the old 500 path).
    await sql`DELETE FROM core.llm_provider_settings WHERE scope = 'platform' AND role = 'primary' AND model_id = 'itest-prov-model'`.execute(db);
    try {
      const res = await app.inject({ method: "PUT", url: "/api/admin/llm-provider-config", cookies: superCookie(), payload: PUT_BODY });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ model_id: string }>().model_id).toBe(PUT_BODY.model_id);
    } finally {
      await deleteSecondary();
      await sql`INSERT INTO core.llm_provider_settings
                  (role, provider, model_id, api_key_ciphertext, api_key_fingerprint, last_rotated_by_user_id, scope)
                VALUES ('primary', 'bedrock', 'itest-prov-model', 'kms2:1:x', 'ab12', ${ROTATOR}, 'platform')`.execute(db);
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
      // EL1: the response reflects the slot just written — disabled secondary.
      expect(res.json<{ enabled: boolean }>().enabled).toBe(false);
      const row = await sql<{ enabled: boolean }>`SELECT enabled FROM core.llm_provider_settings WHERE scope='platform' AND role='secondary'`.execute(db);
      expect(row.rows[0]!.enabled).toBe(false);
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

  it("PUT llm-provider-config works WITHOUT opts.vault — the field codec needs only the registry + validator (P0-A.2d)", async () => {
    // openshift mode wires no vault; after the 4a field-codec swap the LLM write encrypts via the
    // installed field-key registry, so it must NOT 503 just because opts.vault is undefined.
    const app = buildApp({});
    await registerAdminRoutes(app, {
      db,
      signingKey: SIGNING_KEY,
      clock: new FakeClock({ now: NOW }),
      getPreflightValidator: stubFactory(true, null),
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/admin/llm-provider-config",
        cookies: superCookie(),
        payload: PUT_BODY,
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await deleteSecondary();
      await app.close();
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

  // ─── llm-models /test (per-model preflight validation) ───────────────────────────────────────────
  // Reuses makeAppWithVault + the seeded bedrock/primary settings row. The seed's api_key_ciphertext is a
  // fake literal ('kms2:1:x') InMemoryVault can't decrypt, so the round-trip tests write a real ciphertext
  // onto it and restore in finally. setValidation targets the seeded catalog rows M1/M2 (afterAll cleans them).
  const testUrl = (provider: string, modelId: string): string => `/api/admin/llm-models/${provider}/${modelId}/test`;
  const setPrimaryCiphertext = async (plaintext: string): Promise<void> => {
    const ct = encryptField({ plaintext: new TextEncoder().encode(plaintext), registry: fieldRegistry, aad: LLM_API_KEY_AAD });
    await sql`UPDATE core.llm_provider_settings SET api_key_ciphertext = ${ct} WHERE scope='platform' AND role='primary' AND provider='bedrock'`.execute(db);
  };
  const restorePrimaryCiphertext = async (): Promise<void> => {
    await sql`UPDATE core.llm_provider_settings SET api_key_ciphertext = 'kms2:1:x' WHERE scope='platform' AND role='primary' AND provider='bedrock'`.execute(db);
  };
  const resetModelValidation = async (modelId: string): Promise<void> => {
    await sql`UPDATE core.llm_models SET last_validation_status='untested', last_validation_error=NULL WHERE model_id=${modelId}`.execute(db);
  };
  const statusOf = async (modelId: string): Promise<string | undefined> =>
    (await listLlmModels(db)).find((m) => m.model_id === modelId)?.last_validation_status;

  it("llm-models /test: 403 reader; 503 when vault/validator unwired", async () => {
    const vault = new InMemoryVault();
    const app = await makeAppWithVault({ vault, ok: true });
    try {
      expect(
        (await app.inject({ method: "POST", url: testUrl("bedrock", M2), cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") } })).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
    const bare = await makeApp();
    try {
      expect((await bare.inject({ method: "POST", url: testUrl("bedrock", M2), cookies: superCookie() })).statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });

  it("llm-models /test: 200 no-creds (anthropic_direct has no settings row) — no setValidation", async () => {
    const vault = new InMemoryVault();
    const app = await makeAppWithVault({ vault, ok: true });
    try {
      const res = await app.inject({ method: "POST", url: testUrl("anthropic_direct", M1), cookies: superCookie() });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ ok: boolean; message: string }>();
      expect(body.ok).toBe(false);
      expect(body.message).toContain("no enabled credentials configured for provider anthropic_direct");
      expect(await statusOf(M1)).toBe("untested"); // no validation persisted
    } finally {
      await app.close();
    }
  });

  it("llm-models /test: 200 unknown-provider → ok:false (provider-narrowing guard, no throw)", async () => {
    const vault = new InMemoryVault();
    const app = await makeAppWithVault({ vault, ok: true });
    try {
      const res = await app.inject({ method: "POST", url: testUrl("nope", M2), cookies: superCookie() });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ ok: boolean; message: string }>();
      expect(body.ok).toBe(false);
      expect(body.message).toContain("nope");
    } finally {
      await app.close();
    }
  });

  it("llm-models /test: ping fails → 200 {ok:false} + catalog status 'failed' (decrypt round-trip)", async () => {
    const vault = new InMemoryVault();
    const app = await makeAppWithVault({ vault, ok: false, message: "upstream returned 403: forbidden" });
    try {
      await setPrimaryCiphertext("sk-real-bedrock-0123456789");
      const res = await app.inject({ method: "POST", url: testUrl("bedrock", M2), cookies: superCookie() });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ ok: boolean; message: string }>()).toEqual({ ok: false, message: "upstream returned 403: forbidden" });
      expect(await statusOf(M2)).toBe("failed");
    } finally {
      await restorePrimaryCiphertext();
      await resetModelValidation(M2);
      await app.close();
    }
  });

  it("llm-models /test: ping ok → 200 {ok:true,message:'validated'} + catalog status 'ok'", async () => {
    const vault = new InMemoryVault();
    const app = await makeAppWithVault({ vault, ok: true });
    try {
      await setPrimaryCiphertext("sk-real-bedrock-0123456789");
      const res = await app.inject({ method: "POST", url: testUrl("bedrock", M2), cookies: superCookie() });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ ok: boolean; message: string }>()).toEqual({ ok: true, message: "validated" });
      expect(await statusOf(M2)).toBe("ok");
    } finally {
      await restorePrimaryCiphertext();
      await resetModelValidation(M2);
      await app.close();
    }
  });

  // ─── legacy bedrock-config GET/PUT shim ──────────────────────────────────────────────────────────
  // The PUT writes the SAME (scope='platform', role='primary') row this file seeds (itest-prov-model), so
  // every write test restores the seed in finally to keep the read assertions (getLlmProviderConfig primary)
  // valid under the file's shuffled sequential execution.
  const BEDROCK_BODY = { model_id: "anthropic.claude-sonnet-4-6", region: "us-east-1", api_key: "sk-ant-bedrock-0123456789" }; // last4 "6789"
  const restorePrimarySeed = async (): Promise<void> => {
    await sql`INSERT INTO core.llm_provider_settings
                (role, provider, model_id, region, api_key_ciphertext, api_key_fingerprint,
                 enabled, last_validation_status, last_validated_at, last_rotated_by_user_id, scope)
              VALUES ('primary','bedrock','itest-prov-model',NULL,'kms2:1:x','ab12',true,NULL,NULL,${ROTATOR},'platform')
              ON CONFLICT (scope, role, COALESCE(installation_id,'00000000-0000-0000-0000-000000000000'::uuid))
              DO UPDATE SET provider=EXCLUDED.provider, model_id=EXCLUDED.model_id, region=EXCLUDED.region,
                api_key_ciphertext=EXCLUDED.api_key_ciphertext, api_key_fingerprint=EXCLUDED.api_key_fingerprint,
                enabled=EXCLUDED.enabled, last_validation_status=EXCLUDED.last_validation_status,
                last_validated_at=EXCLUDED.last_validated_at, last_rotated_by_user_id=EXCLUDED.last_rotated_by_user_id,
                last_rotated_at=now()`.execute(db);
  };

  it("bedrock-config GET: 200 returns the primary bedrock config; 403 for org_owner", async () => {
    const app = await makeApp();
    try {
      const ok = await app.inject({ method: "GET", url: "/api/admin/bedrock-config", cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json<{ provider: string; model_id: string }>().model_id).toBe("itest-prov-model");
      expect(
        (await app.inject({ method: "GET", url: "/api/admin/bedrock-config", cookies: { [SESSION_COOKIE_NAME]: mintCookie("org_owner") } })).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("bedrock-config PUT: happy → 200 + Vault round-trip + dual rotation audit (restores seed)", async () => {
    const vault = new InMemoryVault();
    const audited: Array<AuditEv> = [];
    const app = await makeAppWithVault({ vault, ok: true, audited });
    try {
      const res = await app.inject({ method: "PUT", url: "/api/admin/bedrock-config", cookies: superCookie(), payload: BEDROCK_BODY });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ provider: string; model_id: string; api_key_fingerprint: string; last_validation_status: string }>();
      expect(body.provider).toBe("bedrock");
      expect(body.model_id).toBe("anthropic.claude-sonnet-4-6");
      expect(body.api_key_fingerprint).toBe("6789");
      expect(body.last_validation_status).toBe("ok");
      const row = await sql<{ api_key_ciphertext: string }>`SELECT api_key_ciphertext FROM core.llm_provider_settings WHERE scope='platform' AND role='primary'`.execute(db);
      const dec = decryptField({ ciphertext: row.rows[0]!.api_key_ciphertext, registry: fieldRegistry, aad: LLM_API_KEY_AAD });
      expect(new TextDecoder().decode(dec)).toBe(BEDROCK_BODY.api_key);
      expect(audited.map((e) => e.action)).toEqual(["bedrock_credential.rotated", "llm_provider_credential.rotated"]);
    } finally {
      await restorePrimarySeed();
      await app.close();
    }
  });

  it("bedrock-config PUT: enabled=false skips preflight (writes; restores seed)", async () => {
    const vault = new InMemoryVault();
    const app = await makeAppWithVault({ vault, ok: false, message: "would fail if pinged" });
    try {
      const res = await app.inject({ method: "PUT", url: "/api/admin/bedrock-config", cookies: superCookie(), payload: { ...BEDROCK_BODY, enabled: false } });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ enabled: boolean }>().enabled).toBe(false);
    } finally {
      await restorePrimarySeed();
      await app.close();
    }
  });

  it("bedrock-config PUT: 400 bedrock_preflight_failed (no write); 422 extra/missing field; 503 unwired", async () => {
    const vault = new InMemoryVault();
    const app = await makeAppWithVault({ vault, ok: false, message: "upstream 401" });
    try {
      const res = await app.inject({ method: "PUT", url: "/api/admin/bedrock-config", cookies: superCookie(), payload: BEDROCK_BODY });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ detail: { code: string } }>().detail.code).toBe("bedrock_preflight_failed");
      // no write: the seed row is untouched
      expect((await sql<{ model_id: string }>`SELECT model_id FROM core.llm_provider_settings WHERE scope='platform' AND role='primary'`.execute(db)).rows[0]?.model_id).toBe("itest-prov-model");
      // 422 — a stray provider field is rejected by .strict()
      expect(
        (await app.inject({ method: "PUT", url: "/api/admin/bedrock-config", cookies: superCookie(), payload: { ...BEDROCK_BODY, provider: "bedrock" } })).statusCode,
      ).toBe(422);
      // 422 — region is REQUIRED in the legacy shape
      expect(
        (await app.inject({ method: "PUT", url: "/api/admin/bedrock-config", cookies: superCookie(), payload: { model_id: "anthropic.claude-sonnet-4-6", api_key: "sk-ant-bedrock-0123456789" } })).statusCode,
      ).toBe(422);
    } finally {
      await app.close();
    }
    const bare = await makeApp();
    try {
      expect((await bare.inject({ method: "PUT", url: "/api/admin/bedrock-config", cookies: superCookie(), payload: BEDROCK_BODY })).statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });
});
