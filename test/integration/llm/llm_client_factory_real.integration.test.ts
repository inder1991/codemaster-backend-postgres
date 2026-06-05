// De-stub LLM part 2, step 3 — proof that the PRODUCTION `LlmClientCache.forRole` path is FULLY REAL.
//
// The `defaultClientFactory` (used whenever a cache is built WITHOUT an explicit `clientFactory` — the
// production wiring) now injects the REAL, ALWAYS-ON Postgres-backed collaborators into every
// `LlmClient` it builds: the PostgresCostCapEnforcer (atomic cost gate), the BlobStorePostgresAdapter
// (zstd payload archive), and the PostgresLlmCallsTelemetryWriter (one llm_calls row per invoke). There
// is NO allow-all cost-cap, NO in-memory blob store, NO faking stub of any kind on this path — those
// were removed from `LlmClient` (cost-cap + blob are now REQUIRED constructor args; the only in-module
// fallbacks left are the REAL redactor + the no-op observability telemetry writer the cache replaces).
//
// Runs ONLY when CODEMASTER_PG_CORE_DSN is set (the shared describeDb gate); SKIPS otherwise so
// validate-fast stays green without a DB. NEVER the in-cluster DB — the disposable PG only.
//
// Two layers of proof:
//   1. STRUCTURAL — `sharedClientCollaborators(dsn)` (the exact memo `defaultClientFactory` reads)
//      returns instances of the three Postgres-backed classes, and none of their constructor names
//      matches the faking-stub pattern.
//   2. END-TO-END — a cache built with the DEFAULT clientFactory + a recorded-response SDK stub
//      (unreachable Bedrock; NO @anthropic-ai/* construction), driven through a full `invokeModel`,
//      lands real rows in telemetry.llm_calls + telemetry.llm_payloads + a per-org reservation in
//      telemetry.cost_daily — observable runtime proof the injected collaborators are the Postgres ones.

import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, expect, it } from "vitest";

import { BlobStorePostgresAdapter } from "#backend/adapters/blobstore_postgres.js";
import { InMemoryVault } from "#backend/adapters/vault_port.js";
import { PostgresCostCapEnforcer } from "#backend/cost/postgres_enforcer.js";
import { LlmClient, PostgresLlmCallsTelemetryWriter } from "#backend/integrations/llm/client.js";
import {
  LlmClientCache,
  sharedClientCollaborators,
  type SdkFactory,
} from "#backend/integrations/llm/client_cache.js";
import { LlmCredentialsProvider } from "#backend/integrations/llm/credentials_provider.js";
import { PostgresLlmProviderSettingsRepo } from "#backend/integrations/llm/llm_provider_settings_repo.js";

import { disposeAllPools, getPool, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

import type { LlmSdk } from "#backend/integrations/llm/client.js";

const VAULT_KEY_NAME = "llm_provider_settings";
const SYSTEM_ACTOR_UUID = "00000000-0000-0000-0000-0000000000aa";

describeDb("LlmClientCache production forRole path is fully real (de-stub step 3)", () => {
  const vault = new InMemoryVault();
  const dsn = INTEGRATION_DSN as string;
  // Fetch the pool / repo fresh per-call (never captured once at block scope) so a `disposeAllPools`
  // teardown anywhere never leaves a stale reference — `getPool` / `tenantKysely` rebuild transparently.
  const pool = (): ReturnType<typeof getPool> => getPool(dsn);
  const makeRepo = (): PostgresLlmProviderSettingsRepo =>
    new PostgresLlmProviderSettingsRepo({ db: tenantKysely<unknown>(dsn), vault });

  const seedPrimaryRow = async (apiKeyPlaintext: string): Promise<void> => {
    const ciphertext = await vault.transitEncrypt({
      keyName: VAULT_KEY_NAME,
      plaintext: new TextEncoder().encode(apiKeyPlaintext),
    });
    await pool().query(
      `INSERT INTO core.llm_provider_settings
         (scope, role, installation_id, provider, model_id, region,
          api_key_ciphertext, api_key_fingerprint, enabled,
          last_rotated_at, last_rotated_by_user_id)
       VALUES ('platform', 'primary', NULL, 'bedrock', 'claude-sonnet-4-6', 'us-east-1',
               $1, $2, true, '2026-06-04T12:00:00Z', $3)
       ON CONFLICT (scope, role, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET api_key_ciphertext = EXCLUDED.api_key_ciphertext,
                     api_key_fingerprint = EXCLUDED.api_key_fingerprint`,
      [ciphertext, apiKeyPlaintext.slice(-4), SYSTEM_ACTOR_UUID],
    );
  };

  beforeEach(async () => {
    await pool().query("DELETE FROM core.llm_provider_settings WHERE scope = 'platform'");
  });

  afterAll(async () => {
    await pool().query("DELETE FROM core.llm_provider_settings WHERE scope = 'platform'");
    await disposeAllPools();
  });

  it("sharedClientCollaborators(dsn) returns the REAL Postgres-backed cost-cap + blob + telemetry", () => {
    const collaborators = sharedClientCollaborators(dsn);
    expect(collaborators.costCap).toBeInstanceOf(PostgresCostCapEnforcer);
    expect(collaborators.blobStore).toBeInstanceOf(BlobStorePostgresAdapter);
    expect(collaborators.telemetry).toBeInstanceOf(PostgresLlmCallsTelemetryWriter);
    // No faking-stub constructor name anywhere on the collaborator set.
    for (const c of [collaborators.costCap, collaborators.blobStore, collaborators.telemetry]) {
      expect(c.constructor.name).not.toMatch(/AllowAll|InMemory|Stub|Fake|Mock|NoOp/i);
    }
  });

  it("forRole over the DEFAULT clientFactory builds a real LlmClient whose invoke lands real DB rows", async () => {
    await seedPrimaryRow("sk-prod-path-REAL");

    // The cache uses its DEFAULT clientFactory (real collaborators); only the sdkFactory is a recorded
    // stub (unreachable Bedrock — NO @anthropic-ai/* construction). This is the production wiring.
    const recordedSdkFactory: SdkFactory = (): LlmSdk => ({
      async createMessage(): Promise<Record<string, unknown>> {
        return {
          content: [{ type: "text", text: "No issues identified." }],
          usage: { input_tokens: 12, output_tokens: 6 },
          stop_reason: "end_turn",
        };
      },
    });
    const repo = makeRepo();
    const provider = new LlmCredentialsProvider({ repo });
    const cache = new LlmClientCache({
      repo,
      credentialsProvider: provider,
      sdkFactory: recordedSdkFactory,
      // clientFactory intentionally omitted → defaultClientFactory → REAL Postgres collaborators.
    });

    const client = await cache.forRole("primary");
    expect(client).toBeInstanceOf(LlmClient);

    const installationId = randomUUID();
    try {
      const result = await client.invokeModel({
        role: "primary",
        model: "claude-sonnet-4-6",
        messages: [
          { role: "system", content: "You are a reviewer." },
          { role: "user", content: "Review this diff." },
        ],
        installationId,
      });
      expect(result.content).toBe("No issues identified.");

      // telemetry.llm_calls — the REAL PostgresLlmCallsTelemetryWriter wrote exactly one row.
      const calls = await pool().query(
        `SELECT status, prompt_tokens, completion_tokens FROM telemetry.llm_calls
          WHERE installation_id = $1::uuid`,
        [installationId],
      );
      expect(calls.rows).toHaveLength(1);
      expect(calls.rows[0]!.status).toBe("ok");
      expect(Number(calls.rows[0]!.prompt_tokens)).toBe(12);
      expect(Number(calls.rows[0]!.completion_tokens)).toBe(6);

      // telemetry.llm_payloads — the REAL BlobStorePostgresAdapter archived request + response.
      const payloads = await pool().query(
        `SELECT key FROM telemetry.llm_payloads WHERE installation_id = $1::uuid`,
        [installationId],
      );
      expect(payloads.rows).toHaveLength(2);
      const keys = (payloads.rows as Array<{ key: string }>).map((r) => r.key);
      expect(keys.some((k) => k.endsWith("/request.json"))).toBe(true);
      expect(keys.some((k) => k.endsWith("/response.json"))).toBe(true);

      // telemetry.cost_daily — the REAL PostgresCostCapEnforcer reserved a per-org row for this install.
      const costDaily = await pool().query(
        `SELECT daily_total_cents FROM telemetry.cost_daily
          WHERE scope = 'per_org' AND scope_id = $1::uuid`,
        [installationId],
      );
      expect(costDaily.rows).toHaveLength(1);
      expect(Number(costDaily.rows[0]!.daily_total_cents)).toBeGreaterThanOrEqual(0);
    } finally {
      await pool().query("DELETE FROM telemetry.llm_calls WHERE installation_id = $1::uuid", [
        installationId,
      ]);
      await pool().query("DELETE FROM telemetry.llm_payloads WHERE installation_id = $1::uuid", [
        installationId,
      ]);
      await pool().query("DELETE FROM telemetry.cost_daily WHERE scope_id = $1::uuid", [
        installationId,
      ]);
    }
  });
});
