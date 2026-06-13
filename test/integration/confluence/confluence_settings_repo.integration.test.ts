// Real-DB integration test for PostgresConfluenceSettingsRepo (go-live Step 4c). Runs ONLY when
// CODEMASTER_PG_CORE_DSN is set (the describeDb gate). Proves the field-codec round-trip + that the DB
// holds only ciphertext for the token column.

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { PostgresConfluenceSettingsRepo } from "#backend/integrations/confluence/confluence_settings_repo.js";

import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";
import { disposeAllPools, getPool, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const ROTATOR = "abababab-1111-2222-3333-444444444444";

describeDb("PostgresConfluenceSettingsRepo (integration)", () => {
  const registry = new KeyRegistry();
  registry.set(
    makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(6)]]) }),
  );
  const repo = new PostgresConfluenceSettingsRepo({
    db: tenantKysely<unknown>(INTEGRATION_DSN as string),
    registry,
  });
  const pool = getPool(INTEGRATION_DSN as string);
  const clean = async (): Promise<void> => {
    await pool.query("DELETE FROM core.confluence_settings WHERE scope = 'platform'");
  };

  beforeAll(async () => {
    await pool.query("SELECT 1 FROM core.confluence_settings WHERE false");
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await disposeAllPools();
  });

  it("write → read round-trips creds (Cloud, authEmail set); token is ciphertext at rest", async () => {
    await repo.write({
      baseUrl: "https://acme.atlassian.net/wiki",
      authEmail: "bot@acme.com",
      token: "atlassian-token-xyz",
      enabled: true,
      rotatedByUserId: ROTATOR,
    });

    expect(await repo.read()).toEqual({
      baseUrl: "https://acme.atlassian.net/wiki",
      authEmail: "bot@acme.com",
      token: "atlassian-token-xyz",
      enabled: true,
    });

    const row = await pool.query<{ token_ciphertext: string }>(
      "SELECT token_ciphertext FROM core.confluence_settings WHERE scope='platform'",
    );
    expect(row.rows[0]?.token_ciphertext.startsWith("kms2:")).toBe(true);
    expect(row.rows[0]?.token_ciphertext).not.toContain("atlassian-token-xyz");
  });

  it("round-trips a Server/DC PAT (authEmail NULL → Bearer)", async () => {
    await repo.write({
      baseUrl: "https://wiki.internal",
      authEmail: null,
      token: "pat-abc",
      enabled: true,
      rotatedByUserId: ROTATOR,
    });
    expect(await repo.read()).toMatchObject({ authEmail: null, token: "pat-abc" });
  });

  it("read returns null when disabled (fail-closed) / unconfigured", async () => {
    expect(await repo.read()).toBeNull();
    await repo.write({
      baseUrl: "https://x",
      authEmail: null,
      token: "t",
      enabled: false,
      rotatedByUserId: ROTATOR,
    });
    expect(await repo.read()).toBeNull();
  });
});
