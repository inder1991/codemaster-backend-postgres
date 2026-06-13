// Real-DB integration test for the REAL LlmClientCache (de-stub step 3) over the REAL
// PostgresLlmProviderSettingsRepo + REAL LlmCredentialsProvider, against the DISPOSABLE Postgres
// (postgresql://postgres:postgres@localhost:5434/codemaster). Runs ONLY when CODEMASTER_PG_CORE_DSN is
// set (the shared describeDb gate); SKIPS otherwise so validate-fast stays green without a DB. NEVER
// the in-cluster DB.
//
// What is REAL here: the Kysely PG round-trip (the fingerprint PK-scan + the decrypt SELECT), the
// Vault-Transit decrypt boundary (the user-approved InMemoryVault double — we encrypt the plaintext
// THROUGH that same fixture to seed a ciphertext, the repo decrypts it back), the LlmCredentialsProvider
// TTL/rotation cache, and the LlmClientCache fingerprint logic. What is the approved double: the SDK
// factory is a recorded-response stub (the unreachable-Bedrock cassette stand-in) — the cache builds a
// REAL LlmClient over that recorded SDK, so NO AWS call, NO @anthropic-ai/* construction.
//
// Coverage (the two the de-stub task names):
//  - a settings row → for_role builds a real LlmClient (the same instance is returned within an
//    unchanged fingerprint window — the 2-slot cache).
//  - a rotation bump (last_rotated_at moves) → the fingerprint changes → for_role rebuilds (a fresh
//    LlmClient over a freshly-built SDK).

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { LlmClient } from "#backend/integrations/llm/client.js";
import { LlmClientCache, type SdkFactory } from "#backend/integrations/llm/client_cache.js";
import { LlmCredentialsProvider } from "#backend/integrations/llm/credentials_provider.js";
import { PostgresLlmProviderSettingsRepo } from "#backend/integrations/llm/llm_provider_settings_repo.js";

import { encryptField } from "#platform/crypto/aes_gcm_aad.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";
import { disposeAllPools, getPool, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

import type { LlmSdk } from "#backend/integrations/llm/client.js";

const LLM_API_KEY_AAD = new TextEncoder().encode("core.llm_provider_settings.api_key_ciphertext");
const SYSTEM_ACTOR_UUID = "00000000-0000-0000-0000-0000000000aa";

describeDb("LlmClientCache (integration)", () => {
  const registry = new KeyRegistry();
  registry.set(
    makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(7)]]) }),
  );
  const repo = new PostgresLlmProviderSettingsRepo({
    db: tenantKysely<unknown>(INTEGRATION_DSN as string),
    registry,
  });
  const provider = new LlmCredentialsProvider({ repo });
  const pool = getPool(INTEGRATION_DSN as string);

  // A recorded-response SDK factory: every build returns a fresh stub; `built` counts builds so the
  // rebuild-on-rotation assertion is observable. The stub satisfies the LlmSdk Protocol the LlmClient
  // drives — NO real `@anthropic-ai/bedrock-sdk` construction.
  let built = 0;
  const recordedSdkFactory: SdkFactory = (): LlmSdk => {
    built += 1;
    return {
      async createMessage(): Promise<Record<string, unknown>> {
        return { content: [{ type: "text", text: "recorded" }] };
      },
    };
  };

  const newCache = (): LlmClientCache =>
    new LlmClientCache({ repo, credentialsProvider: provider, sdkFactory: recordedSdkFactory });

  const encrypt = (plaintext: string): string =>
    encryptField({ plaintext: new TextEncoder().encode(plaintext), registry, aad: LLM_API_KEY_AAD });

  const seedRow = async (args: {
    role: "primary" | "secondary";
    provider: string;
    modelId: string;
    region: string | null;
    apiKeyPlaintext: string;
    enabled: boolean;
    lastRotatedAt: string;
  }): Promise<void> => {
    const ciphertext = encrypt(args.apiKeyPlaintext);
    const fingerprint = args.apiKeyPlaintext.slice(-4);
    await pool.query(
      `INSERT INTO core.llm_provider_settings
         (scope, role, installation_id, provider, model_id, region,
          api_key_ciphertext, api_key_fingerprint, enabled,
          last_rotated_at, last_rotated_by_user_id)
       VALUES ('platform', $1, NULL, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (scope, role, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET
         provider = EXCLUDED.provider, model_id = EXCLUDED.model_id, region = EXCLUDED.region,
         api_key_ciphertext = EXCLUDED.api_key_ciphertext, api_key_fingerprint = EXCLUDED.api_key_fingerprint,
         enabled = EXCLUDED.enabled, last_rotated_at = EXCLUDED.last_rotated_at`,
      [
        args.role,
        args.provider,
        args.modelId,
        args.region,
        ciphertext,
        fingerprint,
        args.enabled,
        args.lastRotatedAt,
        SYSTEM_ACTOR_UUID,
      ],
    );
  };

  const truncate = async (): Promise<void> => {
    await pool.query("DELETE FROM core.llm_provider_settings WHERE scope = 'platform'");
  };

  beforeAll(async () => {
    await pool.query("SELECT 1 FROM core.llm_provider_settings WHERE false");
  });

  beforeEach(async () => {
    built = 0;
    await truncate();
    // A fresh provider per test so its TTL/rotation cache does not leak across cases.
    provider.resetCacheForTesting();
  });

  afterAll(async () => {
    await truncate();
    await disposeAllPools();
  });

  it("for_role builds a real LlmClient from a settings row and caches it within an unchanged fingerprint", async () => {
    await seedRow({
      role: "primary",
      provider: "bedrock",
      modelId: "claude-sonnet-4-6",
      region: "us-east-1",
      apiKeyPlaintext: "sk-cache-AAAA",
      enabled: true,
      lastRotatedAt: "2026-06-04T12:00:00Z",
    });
    const cache = newCache();

    const client = await cache.forRole("primary");
    expect(client).toBeInstanceOf(LlmClient);
    expect(built).toBe(1);

    // A second call within the same (unchanged) fingerprint returns the SAME instance — no rebuild.
    const again = await cache.forRole("primary");
    expect(again).toBe(client);
    expect(built).toBe(1);
  });

  it("a rotation bump (last_rotated_at moves) changes the fingerprint and rebuilds the client", async () => {
    await seedRow({
      role: "primary",
      provider: "bedrock",
      modelId: "claude-sonnet-4-6",
      region: "us-east-1",
      apiKeyPlaintext: "sk-rot-v1",
      enabled: true,
      lastRotatedAt: "2026-06-04T12:00:00Z",
    });
    const cache = newCache();

    const first = await cache.forRole("primary");
    expect(built).toBe(1);

    // Operator rotates: new token + a bumped last_rotated_at — the PK-scan fingerprint moves.
    await seedRow({
      role: "primary",
      provider: "bedrock",
      modelId: "claude-sonnet-4-6",
      region: "us-east-1",
      apiKeyPlaintext: "sk-rot-v2",
      enabled: true,
      lastRotatedAt: "2026-06-04T13:30:00Z",
    });

    const second = await cache.forRole("primary");
    expect(second).toBeInstanceOf(LlmClient);
    // Rebuilt: the fingerprint changed, so a NEW client over a NEW SDK was constructed.
    expect(second).not.toBe(first);
    expect(built).toBe(2);
  });

  it("caches primary and secondary independently (the 2-slot cap)", async () => {
    await seedRow({
      role: "primary",
      provider: "bedrock",
      modelId: "claude-sonnet-4-6",
      region: "us-east-1",
      apiKeyPlaintext: "sk-two-PRIM",
      enabled: true,
      lastRotatedAt: "2026-06-04T12:00:00Z",
    });
    await seedRow({
      role: "secondary",
      provider: "bedrock",
      modelId: "claude-haiku-4-5",
      region: "us-east-1",
      apiKeyPlaintext: "sk-two-SEC0",
      enabled: true,
      lastRotatedAt: "2026-06-04T12:00:00Z",
    });
    const cache = newCache();

    const p = await cache.forRole("primary");
    const s = await cache.forRole("secondary");
    expect(p).toBeInstanceOf(LlmClient);
    expect(s).toBeInstanceOf(LlmClient);
    expect(p).not.toBe(s);
    // One SDK build per role.
    expect(built).toBe(2);
  });
});
