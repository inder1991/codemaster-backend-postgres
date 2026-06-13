// P0-C-parity integration: makeResolvingConfluenceReader resolves the UI-saved DB row — proving a
// UI-saved Confluence config is USED at runtime (the token provider reads through this reader), not just
// stored. Runs ONLY when CODEMASTER_PG_CORE_DSN is set (describeDb gate).

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { PostgresConfluenceSettingsRepo } from "#backend/integrations/confluence/confluence_settings_repo.js";
import { makeResolvingConfluenceReader } from "#backend/integrations/confluence/confluence_config_resolver.js";
import {
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";

import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";
import { disposeAllPools, getPool, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const ROTATOR = "abababab-1111-2222-3333-444444444444";
const reg = new KeyRegistry();
reg.set(makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(7)]]) }));

describeDb("makeResolvingConfluenceReader — DB tier (Step 4c read-side)", () => {
  const repo = new PostgresConfluenceSettingsRepo({
    db: tenantKysely<unknown>(INTEGRATION_DSN as string),
    registry: reg,
  });
  const pool = getPool(INTEGRATION_DSN as string);

  beforeAll(() => {
    // The reader's DB tier reads CODEMASTER_PG_CORE_DSN (already set — the gate) + this installed registry.
    setAuditKeyRegistry(reg);
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM core.confluence_settings WHERE scope = 'platform'");
  });
  afterAll(async () => {
    resetAuditKeyRegistryForTesting();
    await disposeAllPools();
  });

  it("resolves the UI-saved DB row → the {base_url, token, email} record the token provider parses", async () => {
    await repo.write({
      baseUrl: "https://acme.atlassian.net/wiki",
      authEmail: "bot@acme.com",
      token: "db-token-xyz",
      enabled: true,
      rotatedByUserId: ROTATOR,
    });

    // No env, no Vault — the DB tier must win (else it would fall through to VaultHttpPort.fromEnv and throw).
    const record = await makeResolvingConfluenceReader().kvRead({ path: "codemaster/confluence/token" });
    expect(record).toEqual({
      base_url: "https://acme.atlassian.net/wiki",
      token: "db-token-xyz",
      email: "bot@acme.com",
    });
  });

  it("omits the email key for a Server/DC PAT row (authEmail NULL → Bearer)", async () => {
    await repo.write({
      baseUrl: "https://wiki.internal",
      authEmail: null,
      token: "pat",
      enabled: true,
      rotatedByUserId: ROTATOR,
    });
    const record = await makeResolvingConfluenceReader().kvRead({ path: "codemaster/confluence/token" });
    expect(record).toEqual({ base_url: "https://wiki.internal", token: "pat" });
    expect("email" in record).toBe(false);
  });
});
