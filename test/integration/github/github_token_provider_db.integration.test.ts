// P0-C integration: GitHubAppTokenProvider.fromEnv resolves the UI-saved DB row (the DB tier of
// DB > env > Vault). The exact gap the review found — UI config stored but never USED at runtime —
// is what this test would have caught. Runs ONLY when CODEMASTER_PG_CORE_DSN is set (describeDb gate).

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { PostgresGitHubAppSettingsRepo } from "#backend/integrations/github/github_app_settings_repo.js";
import { GitHubAppTokenProvider } from "#backend/integrations/github/token_provider.js";
import {
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";

import { FakeClock } from "#platform/clock.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";
import { disposeAllPools, getPool, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

import type { GitHubHttpClient } from "#backend/integrations/github/api_client.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const ROTATOR = "abababab-1111-2222-3333-444444444444";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIBfake\n-----END RSA PRIVATE KEY-----";
// fromEnv builds the provider but never calls http (that's getToken's job), so a reject-stub is safe.
const noopHttp: GitHubHttpClient = {
  request: () => Promise.reject(new Error("http.request must not be called by fromEnv")),
};

describeDb("GitHubAppTokenProvider.fromEnv — DB tier (P0-C)", () => {
  const registry = new KeyRegistry();
  registry.set(
    makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(5)]]) }),
  );
  const repo = new PostgresGitHubAppSettingsRepo({
    db: tenantKysely<unknown>(INTEGRATION_DSN as string),
    registry,
  });
  const pool = getPool(INTEGRATION_DSN as string);

  beforeAll(() => {
    // The DB tier reads CODEMASTER_PG_CORE_DSN (already set — the gate) + this installed registry.
    setAuditKeyRegistry(registry);
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM core.github_app_settings WHERE scope = 'platform'");
  });
  afterAll(async () => {
    resetAuditKeyRegistryForTesting();
    await disposeAllPools();
  });

  it("builds the provider from the UI-saved DB row — no vault arg, no env (DB tier wins)", async () => {
    await repo.write({
      appId: "654321",
      privateKeyPem: PEM,
      webhookSecret: "whsec",
      enabled: true,
      rotatedByUserId: ROTATOR,
    });

    // No `vault` passed: if the DB tier did NOT resolve, fromEnv would fall through to env (empty) then
    // lazily construct VaultHttpPort.fromEnv() — which throws without VAULT_ADDR. Succeeding here proves
    // the UI-saved DB row drove the resolution.
    const provider = await GitHubAppTokenProvider.fromEnv({
      http: noopHttp,
      clock: new FakeClock({ now: NOW }),
    });
    expect(provider).toBeInstanceOf(GitHubAppTokenProvider);
  });

  it("a disabled DB row does NOT resolve (fail-closed) — falls through to the unconfigured error", async () => {
    await repo.write({
      appId: "654321",
      privateKeyPem: PEM,
      webhookSecret: "whsec",
      enabled: false,
      rotatedByUserId: ROTATOR,
    });
    // DB null (disabled) + env empty → the Vault tier builds VaultHttpPort.fromEnv() and throws (no
    // VAULT_ADDR in the test env) OR yields the unconfigured PermanentTokenError — either way it rejects.
    await expect(
      GitHubAppTokenProvider.fromEnv({ http: noopHttp, clock: new FakeClock({ now: NOW }) }),
    ).rejects.toThrow();
  });
});
