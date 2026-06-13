// Real-DB integration test for PostgresGitHubAppSettingsRepo (go-live Step 4b). Runs ONLY when
// CODEMASTER_PG_CORE_DSN is set (the describeDb gate); SKIPS otherwise. Proves the field-codec
// round-trip + that the DB holds only ciphertext for the secret columns.

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { PostgresGitHubAppSettingsRepo } from "#backend/integrations/github/github_app_settings_repo.js";

import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";
import { disposeAllPools, getPool, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const ROTATOR = "abababab-1111-2222-3333-444444444444";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIBfake\n-----END RSA PRIVATE KEY-----";

describeDb("PostgresGitHubAppSettingsRepo (integration)", () => {
  const registry = new KeyRegistry();
  registry.set(
    makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(9)]]) }),
  );
  const repo = new PostgresGitHubAppSettingsRepo({
    db: tenantKysely<unknown>(INTEGRATION_DSN as string),
    registry,
  });
  const pool = getPool(INTEGRATION_DSN as string);
  const clean = async (): Promise<void> => {
    await pool.query("DELETE FROM core.github_app_settings WHERE scope = 'platform'");
  };

  beforeAll(async () => {
    await pool.query("SELECT 1 FROM core.github_app_settings WHERE false");
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await disposeAllPools();
  });

  it("write → read round-trips the creds; secrets are ciphertext at rest", async () => {
    await repo.write({
      appId: "123456",
      privateKeyPem: PEM,
      webhookSecret: "whsec-abc",
      enabled: true,
      rotatedByUserId: ROTATOR,
    });

    expect(await repo.read()).toEqual({
      appId: "123456",
      privateKeyPem: PEM,
      webhookSecret: "whsec-abc",
      enabled: true,
    });

    const row = await pool.query<{ private_key_pem_ciphertext: string; webhook_secret_ciphertext: string }>(
      "SELECT private_key_pem_ciphertext, webhook_secret_ciphertext FROM core.github_app_settings WHERE scope='platform'",
    );
    expect(row.rows[0]?.private_key_pem_ciphertext.startsWith("kms2:")).toBe(true);
    expect(row.rows[0]?.webhook_secret_ciphertext).not.toContain("whsec-abc");
  });

  it("read returns null when disabled (fail-closed)", async () => {
    await repo.write({
      appId: "1",
      privateKeyPem: PEM,
      webhookSecret: "w",
      enabled: false,
      rotatedByUserId: ROTATOR,
    });
    expect(await repo.read()).toBeNull();
  });

  it("read returns null when unconfigured", async () => {
    expect(await repo.read()).toBeNull();
  });
});
