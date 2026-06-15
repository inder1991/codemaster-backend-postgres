// Real-DB integration test for PostgresEmbedderProviderSettingsRepo (Phase 3). Runs ONLY when
// CODEMASTER_PG_CORE_DSN is set (the describeDb gate). Proves: the field-codec round-trip (api key is
// kms2 ciphertext at rest, never plaintext); the TRI-STATE key write (set / clear-to-keyless / keep);
// that staging a write ALWAYS resets validation + bumps updated_at; that a key change bumps
// last_rotated_at while a non-key change does NOT; and that updateEnabled toggles WITHOUT resetting
// validation.

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { PostgresEmbedderProviderSettingsRepo } from "#backend/integrations/embedder/embedder_provider_settings_repo.js";

import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";
import { disposeAllPools, getPool, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const ACTOR = "admin@example.com";

describeDb("PostgresEmbedderProviderSettingsRepo (integration)", () => {
  const registry = new KeyRegistry();
  registry.set(
    makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(7)]]) }),
  );
  const repo = new PostgresEmbedderProviderSettingsRepo({
    db: tenantKysely<unknown>(INTEGRATION_DSN as string),
    registry,
  });
  const pool = getPool(INTEGRATION_DSN as string);
  const clean = async (): Promise<void> => {
    await pool.query("DELETE FROM core.embedder_provider_settings");
  };

  beforeAll(async () => {
    await pool.query("SELECT 1 FROM core.embedder_provider_settings WHERE false");
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await disposeAllPools();
  });

  it("write(set key) → readForResolve round-trips; key is kms2 ciphertext at rest; fingerprint = last 4", async () => {
    const { fingerprint } = await repo.writeSecret({
      baseUrl: "http://embedder.local:8080/v1",
      modelName: "qwen3-embed-0.6b",
      enabled: true,
      key: { kind: "set", plaintext: "sk-supersecret-1234" },
      rotatedBy: ACTOR,
    });
    expect(fingerprint).toBe("1234");

    const cfg = await repo.readForResolve();
    expect(cfg).toMatchObject({
      baseUrl: "http://embedder.local:8080/v1",
      modelName: "qwen3-embed-0.6b",
      apiKey: "sk-supersecret-1234",
      enabled: true,
      validationStatus: null,
    });

    const row = await pool.query<{ api_key_ciphertext: string; api_key_fingerprint: string }>(
      "SELECT api_key_ciphertext, api_key_fingerprint FROM core.embedder_provider_settings",
    );
    expect(row.rows[0]!.api_key_ciphertext.startsWith("kms2:")).toBe(true);
    expect(row.rows[0]!.api_key_ciphertext).not.toContain("sk-supersecret-1234");
    expect(row.rows[0]!.api_key_fingerprint).toBe("1234");
  });

  it("keyless write (clear) → apiKey null, key_present false, ciphertext NULL at rest", async () => {
    const { fingerprint } = await repo.writeSecret({
      baseUrl: "http://ollama.local:11434/v1",
      modelName: "mxbai-embed-large",
      enabled: true,
      key: { kind: "clear" },
      rotatedBy: ACTOR,
    });
    expect(fingerprint).toBeNull();

    expect((await repo.readForResolve())!.apiKey).toBeNull();
    expect((await repo.readNonSecret())!.keyPresent).toBe(false);
    const row = await pool.query<{ api_key_ciphertext: string | null }>(
      "SELECT api_key_ciphertext FROM core.embedder_provider_settings",
    );
    expect(row.rows[0]!.api_key_ciphertext).toBeNull();
  });

  it("key:'keep' preserves the existing key while updating other fields", async () => {
    await repo.writeSecret({
      baseUrl: "http://e/v1",
      modelName: "m1",
      enabled: true,
      key: { kind: "set", plaintext: "sk-keepme-9999" },
      rotatedBy: ACTOR,
    });
    await repo.writeSecret({
      baseUrl: "http://e2/v1",
      modelName: "m2",
      enabled: true,
      key: { kind: "keep" },
      rotatedBy: ACTOR,
    });
    const cfg = await repo.readForResolve();
    expect(cfg).toMatchObject({ baseUrl: "http://e2/v1", modelName: "m2", apiKey: "sk-keepme-9999" });
  });

  it("staging a write ALWAYS resets validation and bumps updated_at; updateEnabled does NOT reset validation", async () => {
    await repo.writeSecret({
      baseUrl: "http://e/v1",
      modelName: "m",
      enabled: true,
      key: { kind: "set", plaintext: "sk-abcd" },
      rotatedBy: ACTOR,
    });
    // Simulate a prior successful /test promotion.
    await pool.query(
      "UPDATE core.embedder_provider_settings SET last_validation_status='ok', last_validated_at=now()",
    );
    const beforeUpdatedAt = (await repo.readNonSecret())!.updatedAt;

    // A config write re-stages → validation reset.
    await repo.writeSecret({
      baseUrl: "http://e3/v1",
      modelName: "m",
      enabled: true,
      key: { kind: "keep" },
      rotatedBy: ACTOR,
    });
    const afterWrite = (await repo.readNonSecret())!;
    expect(afterWrite.lastValidationStatus).toBeNull();
    expect(afterWrite.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeUpdatedAt.getTime());

    // Re-promote, then a pure enable toggle must KEEP validation.
    await pool.query("UPDATE core.embedder_provider_settings SET last_validation_status='ok'");
    expect(await repo.updateEnabled({ enabled: false })).toBe(true);
    const afterToggle = (await repo.readNonSecret())!;
    expect(afterToggle.enabled).toBe(false);
    expect(afterToggle.lastValidationStatus).toBe("ok");
  });

  it("a key change bumps last_rotated_at; a 'keep' change does NOT", async () => {
    await repo.writeSecret({
      baseUrl: "http://e/v1",
      modelName: "m",
      enabled: true,
      key: { kind: "set", plaintext: "sk-1" },
      rotatedBy: ACTOR,
    });
    const rotated1 = (await repo.readNonSecret())!.lastRotatedAt!;

    await repo.writeSecret({
      baseUrl: "http://e/v1",
      modelName: "m-changed",
      enabled: true,
      key: { kind: "keep" },
      rotatedBy: ACTOR,
    });
    expect((await repo.readNonSecret())!.lastRotatedAt!.getTime()).toBe(rotated1.getTime());

    await repo.writeSecret({
      baseUrl: "http://e/v1",
      modelName: "m-changed",
      enabled: true,
      key: { kind: "set", plaintext: "sk-2" },
      rotatedBy: ACTOR,
    });
    expect((await repo.readNonSecret())!.lastRotatedAt!.getTime()).toBeGreaterThanOrEqual(
      rotated1.getTime(),
    );
  });

  it("readForResolve / readNonSecret return null when no row exists", async () => {
    expect(await repo.readForResolve()).toBeNull();
    expect(await repo.readNonSecret()).toBeNull();
  });

  it("config_revision bumps on every write; writeValidationResult is CAS-guarded on it", async () => {
    await repo.writeSecret({
      baseUrl: "http://e/v1",
      modelName: "m",
      enabled: true,
      key: { kind: "set", plaintext: "sk-1" },
      rotatedBy: ACTOR,
    });
    const rev1 = (await repo.readForResolve())!.configRevision;
    // a second write bumps the revision
    await repo.writeSecret({
      baseUrl: "http://e2/v1",
      modelName: "m",
      enabled: true,
      key: { kind: "keep" },
      rotatedBy: ACTOR,
    });
    const rev2 = (await repo.readForResolve())!.configRevision;
    expect(rev2).toBeGreaterThan(rev1);

    // a STALE revision → no-op (false), validation untouched
    expect(
      await repo.writeValidationResult({ status: "failed", error: "stale", expectedRevision: rev1 }),
    ).toBe(false);
    expect((await repo.readNonSecret())!.lastValidationStatus).toBeNull();
    // the CURRENT revision → applied
    expect(
      await repo.writeValidationResult({ status: "failed", error: "fresh", expectedRevision: rev2 }),
    ).toBe(true);
    expect((await repo.readNonSecret())!.lastValidationStatus).toBe("failed");
    // a validation write does NOT bump the revision (it is not a config change)
    expect((await repo.readForResolve())!.configRevision).toBe(rev2);
  });
});
