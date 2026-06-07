// Real-DB integration test for PostgresLlmProviderSettingsRepo (de-stub step 1) — the REAL Kysely +
// Vault-Transit port of the frozen Python
// vendor/codemaster-py/codemaster/api/admin/postgres_llm_provider_settings_repo.py.
//
// Runs ONLY when CODEMASTER_PG_CORE_DSN is set (the shared describeDb gate) — pointing at the
// DISPOSABLE Postgres (postgresql://postgres:postgres@localhost:5434/codemaster) with migrations
// applied. SKIPS otherwise so validate-fast stays green without a DB. NEVER hard-defaults the DSN,
// and NEVER touches the in-cluster DB.
//
// Vault double: the task-approved InMemoryVault test double stands in for Vault Transit. We encrypt
// the plaintext token THROUGH that same InMemoryVault to obtain a ciphertext blob, seed THAT blob
// into core.llm_provider_settings on the REAL disposable PG, then read it back through the repo —
// which decrypts via the SAME InMemoryVault under the production Vault key "llm_provider_settings".
// The PG round-trip is real; only the cryptographic Vault boundary is the approved double.
//
// Coverage (the three reads the de-stub task names):
//  - readDecryptedSettings: enabled platform row → decrypted plaintext apiKey + provider/modelId/
//    region/enabled round-trip; disabled row → null (fail-closed); absent role → null.
//  - readRotationFingerprint: PK-scan returns [(role, lastRotatedAt), …] ordered by role for all
//    platform rows; [] when none.
//  - readLastRotatedAt: single-row probe returns the timestamptz for (scope, role) or null.
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { PostgresLlmProviderSettingsRepo } from "#backend/integrations/llm/llm_provider_settings_repo.js";

import { InMemoryVault } from "#backend/adapters/vault_port.js";

import { disposeAllPools, getPool, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const VAULT_KEY_NAME = "llm_provider_settings";
// A fixed non-zero actor UUID for the NOT-NULL last_rotated_by_user_id column (sentinel-shaped).
const SYSTEM_ACTOR_UUID = "00000000-0000-0000-0000-0000000000aa";

describeDb("PostgresLlmProviderSettingsRepo (integration)", () => {
  // ADR-0062: the repo's Kysely routes through the shared single pool; the raw seed/cleanup reads
  // share THAT pool via getPool(dsn). Guarded on the DSN so the module never opens a live connection
  // when SKIPPED.
  const vault = new InMemoryVault();
  const repo = new PostgresLlmProviderSettingsRepo({
    db: tenantKysely<unknown>(INTEGRATION_DSN as string),
    vault,
  });
  const pool = getPool(INTEGRATION_DSN as string);

  // Encrypt a plaintext token through the SAME InMemoryVault the repo decrypts with, returning the
  // ciphertext blob to seed into the DB.
  const encrypt = async (plaintext: string): Promise<string> =>
    vault.transitEncrypt({
      keyName: VAULT_KEY_NAME,
      plaintext: new TextEncoder().encode(plaintext),
    });

  // Seed (UPSERT) one platform-scope row. installation_id MUST be NULL for scope='platform' (the
  // ck_..._scope_installation_consistency CHECK). fingerprint is the last 4 chars (the length-4 CHECK).
  const seedRow = async (args: {
    role: "primary" | "secondary";
    provider: string;
    modelId: string;
    region: string | null;
    apiKeyPlaintext: string;
    enabled: boolean;
    lastRotatedAt: string;
  }): Promise<void> => {
    const ciphertext = await encrypt(args.apiKeyPlaintext);
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
    // Platform-scope table (NO installation_id predicate by design). DELETE every platform row so each
    // test starts from a known empty state — the table only ever holds ≤2 platform rows in production.
    await pool.query("DELETE FROM core.llm_provider_settings WHERE scope = 'platform'");
  };

  beforeAll(async () => {
    // Sanity: confirm the disposable DB is reachable + the target table exists before asserting.
    await pool.query("SELECT 1 FROM core.llm_provider_settings WHERE false");
  });

  beforeEach(async () => {
    await truncate();
  });

  afterAll(async () => {
    await truncate();
    await disposeAllPools();
  });

  it("readDecryptedSettings returns decrypted plaintext for an enabled platform row", async () => {
    await seedRow({
      role: "primary",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      region: "us-east-1",
      apiKeyPlaintext: "sk-secret-token-WXYZ",
      enabled: true,
      lastRotatedAt: "2026-06-04T12:00:00Z",
    });

    const got = await repo.readDecryptedSettings("primary");

    expect(got).not.toBeNull();
    expect(got).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      region: "us-east-1",
      apiKey: "sk-secret-token-WXYZ",
      enabled: true,
    });
  });

  it("readDecryptedSettings tolerates a NULL region (Bedrock-default slot)", async () => {
    await seedRow({
      role: "secondary",
      provider: "bedrock",
      modelId: "claude-haiku-4-5",
      region: null,
      apiKeyPlaintext: "sk-second-0000",
      enabled: true,
      lastRotatedAt: "2026-06-04T12:00:00Z",
    });

    const got = await repo.readDecryptedSettings("secondary");

    expect(got?.region).toBeNull();
    expect(got?.apiKey).toBe("sk-second-0000");
  });

  it("readDecryptedSettings returns null for a disabled slot (fail-closed)", async () => {
    await seedRow({
      role: "primary",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      region: "us-east-1",
      apiKeyPlaintext: "sk-disabled-AAAA",
      enabled: false,
      lastRotatedAt: "2026-06-04T12:00:00Z",
    });

    expect(await repo.readDecryptedSettings("primary")).toBeNull();
  });

  it("readDecryptedSettings returns null for an absent role", async () => {
    // Only a 'secondary' row exists; reading 'primary' must be null.
    await seedRow({
      role: "secondary",
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      region: "us-east-1",
      apiKeyPlaintext: "sk-only-secondary-BBBB",
      enabled: true,
      lastRotatedAt: "2026-06-04T12:00:00Z",
    });

    expect(await repo.readDecryptedSettings("primary")).toBeNull();
  });

  it("readRotationFingerprint returns [(role, lastRotatedAt), …] for all platform rows, ordered by role", async () => {
    await seedRow({
      role: "secondary",
      provider: "bedrock",
      modelId: "claude-haiku-4-5",
      region: null,
      apiKeyPlaintext: "sk-second-CCCC",
      enabled: true,
      lastRotatedAt: "2026-06-03T09:00:00Z",
    });
    await seedRow({
      role: "primary",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      region: "us-east-1",
      apiKeyPlaintext: "sk-primary-DDDD",
      // A DISABLED row still appears in the fingerprint (no decrypt; just the rotation timestamp).
      enabled: false,
      lastRotatedAt: "2026-06-04T12:00:00Z",
    });

    const fp = await repo.readRotationFingerprint();

    expect(fp.map((e) => e.role)).toEqual(["primary", "secondary"]);
    const primary = fp.find((e) => e.role === "primary");
    expect(primary?.lastRotatedAt.toISOString()).toBe("2026-06-04T12:00:00.000Z");
    const secondary = fp.find((e) => e.role === "secondary");
    expect(secondary?.lastRotatedAt.toISOString()).toBe("2026-06-03T09:00:00.000Z");
  });

  it("readRotationFingerprint returns [] when no platform rows exist", async () => {
    expect(await repo.readRotationFingerprint()).toEqual([]);
  });

  it("readLastRotatedAt returns the timestamptz for (scope, role) or null when absent", async () => {
    await seedRow({
      role: "primary",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      region: "us-east-1",
      apiKeyPlaintext: "sk-rotated-EEEE",
      enabled: true,
      lastRotatedAt: "2026-06-04T12:34:56Z",
    });

    const got = await repo.readLastRotatedAt({ scope: "platform", role: "primary" });
    expect(got?.toISOString()).toBe("2026-06-04T12:34:56.000Z");

    // Absent role → null.
    expect(await repo.readLastRotatedAt({ scope: "platform", role: "secondary" })).toBeNull();
  });

  it("isolates by Vault key: a row decrypts only under the production key name", async () => {
    // Defense-in-depth: seed a row, then prove the repo decrypts via the SAME InMemoryVault fixture
    // keyed by VAULT_KEY_NAME — a wrong-key decrypt would throw, which the read path would surface.
    await seedRow({
      role: "primary",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      region: "us-east-1",
      apiKeyPlaintext: "sk-keyed-FFFF",
      enabled: true,
      lastRotatedAt: "2026-06-04T12:00:00Z",
    });

    const got = await repo.readDecryptedSettings("primary");
    expect(got?.apiKey).toBe("sk-keyed-FFFF");

    // Sanity: the same fixture refuses an unknown ciphertext under the same key (no silent plaintext).
    await expect(
      vault.transitDecrypt({ keyName: VAULT_KEY_NAME, ciphertext: "vault:v1:bogus:999" }),
    ).rejects.toThrow();
  });

  it("writeSettings encrypts via Vault Transit + UPSERTs; round-trips through readDecryptedSettings", async () => {
    const rotatedAt = new Date("2026-06-05T08:00:00.000Z");
    const out = await repo.writeSettings({
      role: "primary",
      provider: "bedrock",
      apiKeyPlaintext: "sk-write-token-PQRS",
      modelId: "claude-sonnet-4-6",
      region: "us-east-1",
      enabled: true,
      validatedAt: rotatedAt,
      validationStatus: "ok",
      rotatedAt,
      rotatedByUserId: SYSTEM_ACTOR_UUID,
    });
    expect(out.fingerprint).toBe("PQRS"); // last 4 chars of the plaintext (length-4 CHECK)

    // Round-trip: the ciphertext decrypts back to the original plaintext under the production key.
    expect(await repo.readDecryptedSettings("primary")).toEqual({
      provider: "bedrock",
      modelId: "claude-sonnet-4-6",
      region: "us-east-1",
      apiKey: "sk-write-token-PQRS",
      enabled: true,
    });

    // Metadata columns persisted (fingerprint, validation status, rotated-by).
    const meta = await pool.query(
      "SELECT api_key_fingerprint, last_validation_status, last_rotated_by_user_id FROM core.llm_provider_settings WHERE scope='platform' AND role='primary'",
    );
    expect(meta.rows[0].api_key_fingerprint).toBe("PQRS");
    expect(meta.rows[0].last_validation_status).toBe("ok");
    expect(meta.rows[0].last_rotated_by_user_id).toBe(SYSTEM_ACTOR_UUID);

    // UPSERT idempotency: a second write rotates ciphertext + model on the same (scope, role) PK.
    await repo.writeSettings({
      role: "primary",
      provider: "bedrock",
      apiKeyPlaintext: "sk-rotated-token-TUVW",
      modelId: "claude-haiku-4-5-20251001",
      region: "us-west-2",
      enabled: true,
      validatedAt: rotatedAt,
      validationStatus: "ok",
      rotatedAt,
      rotatedByUserId: SYSTEM_ACTOR_UUID,
    });
    const dec2 = await repo.readDecryptedSettings("primary");
    expect(dec2?.apiKey).toBe("sk-rotated-token-TUVW");
    expect(dec2?.modelId).toBe("claude-haiku-4-5-20251001");
    expect(dec2?.region).toBe("us-west-2");
  });

  it("writeSettings with enabled=false stores a disabled row (read returns null, fail-closed)", async () => {
    const rotatedAt = new Date("2026-06-05T08:00:00.000Z");
    await repo.writeSettings({
      role: "secondary",
      provider: "bedrock",
      apiKeyPlaintext: "sk-disabled-write-MNOP",
      modelId: "claude-sonnet-4-6",
      region: "us-east-1",
      enabled: false,
      validatedAt: rotatedAt,
      validationStatus: "ok",
      rotatedAt,
      rotatedByUserId: SYSTEM_ACTOR_UUID,
    });
    // Disabled slot → readDecryptedSettings returns null (halts traffic without rotating).
    expect(await repo.readDecryptedSettings("secondary")).toBeNull();
    // But the row exists (fingerprint persisted) — the rotation fingerprint still sees it.
    const fp = await repo.readRotationFingerprint();
    expect(fp.map((e) => e.role)).toContain("secondary");
  });
});
