// Integration test for promoteValidatedEmbedderConfig (Phase 6 / r7 D9) — the whole concurrency +
// consistency model, exercised against the real DB:
//   - happy path (greenfield, contract change): validation→ok, the active generation's provenance flips
//     to the new model+provider, runtime active_model_name updates, config_version bumps — atomically;
//   - CAS miss: a concurrent re-stage (updated_at moved) → EmbedderConfigChangedError, nothing promoted;
//   - contract change on a NON-greenfield corpus → EmbedderNotGreenfieldError;
//   - re-test of the UNCHANGED active config on a non-greenfield corpus → SUCCEEDS (7-2);
//   - a dimension disagreement on the active generation → EmbedderProvenanceError.

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { PostgresEmbedderProviderSettingsRepo } from "#backend/integrations/embedder/embedder_provider_settings_repo.js";
import { PostgresEmbeddingGenerationsRepo } from "#backend/domain/repos/embedding_generations_repo.js";
import {
  EmbedderConfigChangedError,
  EmbedderNotGreenfieldError,
  EmbedderProvenanceError,
  promoteValidatedEmbedderConfig,
} from "#backend/api/admin/embedder_config_promote.js";

import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";
import { disposeAllPools, getPool, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const ACTOR = "admin@example.com";

describeDb("promoteValidatedEmbedderConfig (integration)", () => {
  const pool = getPool(INTEGRATION_DSN as string);
  const db = tenantKysely<unknown>(INTEGRATION_DSN as string);
  const registry = new KeyRegistry();
  registry.set(makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(9)]]) }));
  const repo = new PostgresEmbedderProviderSettingsRepo({ db, registry });
  const genRepo = new PostgresEmbeddingGenerationsRepo({ db });

  /** Restore the fresh greenfield baseline: seed gen 1 (qwen/qwen3-embed-0.6b/1024), runtime → gen 1,
   *  config_version 1, empty corpus, no staged settings. */
  const resetSeed = async (): Promise<void> => {
    await pool.query("DELETE FROM core.embedder_provider_settings");
    await pool.query("DELETE FROM core.chunk_embeddings");
    await pool.query("DELETE FROM core.knowledge_chunks");
    await pool.query("DELETE FROM core.confluence_chunks");
    await pool.query("DELETE FROM cache.cache_embeddings");
    await pool.query("DELETE FROM core.embedding_generations WHERE generation_id <> 1");
    await pool.query(
      "UPDATE core.embedding_generations SET model_name='qwen3-embed-0.6b', provider_name='qwen', " +
        "embedding_dimension=1024, state='active' WHERE generation_id = 1",
    );
    await pool.query(
      "UPDATE core.embedder_runtime_state SET active_generation=1, active_model_name='qwen3-embed-0.6b', " +
        "pending_generation=NULL, pending_model_name=NULL, config_version=1 WHERE singleton = true",
    );
  };

  beforeAll(resetSeed);
  beforeEach(resetSeed);
  afterAll(async () => {
    await resetSeed();
    await disposeAllPools();
  });

  // Stage a config and return its config_revision (the CAS token) from the SAME read path the route uses.
  const stage = async (modelName: string): Promise<number> => {
    await repo.writeSecret({
      baseUrl: "http://embedder.local:8080/v1",
      modelName,
      enabled: true,
      key: { kind: "set", plaintext: "sk-secret" },
      rotatedBy: ACTOR,
    });
    return (await repo.readForResolve())!.configRevision;
  };

  it("happy path (greenfield, contract change): validation→ok, provenance + active_model_name + config_version", async () => {
    const token = await stage("mxbai-embed-large");
    await promoteValidatedEmbedderConfig(db, {
      expectedRevision: token,
      modelName: "mxbai-embed-large",
      provider: "openai_compat",
      expectedDimension: 1024,
      actorEmail: ACTOR,
    });

    expect((await repo.readNonSecret())!.lastValidationStatus).toBe("ok");
    const gen = await pool.query<{ model_name: string; provider_name: string }>(
      "SELECT model_name, provider_name FROM core.embedding_generations WHERE generation_id = 1",
    );
    expect(gen.rows[0]).toEqual({ model_name: "mxbai-embed-large", provider_name: "openai_compat" });
    const rt = await pool.query<{ active_model_name: string; config_version: string }>(
      "SELECT active_model_name, config_version FROM core.embedder_runtime_state",
    );
    expect(rt.rows[0]!.active_model_name).toBe("mxbai-embed-large");
    expect(Number(rt.rows[0]!.config_version)).toBe(2);
  });

  it("CAS miss: a concurrent re-stage (config_revision moved) → EmbedderConfigChangedError, nothing promoted", async () => {
    const staleToken = await stage("mxbai-embed-large");
    // Simulate a concurrent PUT that re-staged the row (bumped config_revision) between probe and promote.
    await pool.query(
      "UPDATE core.embedder_provider_settings SET config_revision = config_revision + 1 WHERE singleton = true",
    );
    await expect(
      promoteValidatedEmbedderConfig(db, {
        expectedRevision: staleToken,
        modelName: "mxbai-embed-large",
        provider: "openai_compat",
        expectedDimension: 1024,
        actorEmail: ACTOR,
      }),
    ).rejects.toBeInstanceOf(EmbedderConfigChangedError);
    // Nothing promoted: validation still null, generation still the seed.
    expect((await repo.readNonSecret())!.lastValidationStatus).toBeNull();
    const gen = await pool.query<{ provider_name: string }>(
      "SELECT provider_name FROM core.embedding_generations WHERE generation_id = 1",
    );
    expect(gen.rows[0]!.provider_name).toBe("qwen");
  });

  it("contract change on a NON-greenfield corpus → EmbedderNotGreenfieldError", async () => {
    const token = await stage("mxbai-embed-large");
    // A second generation makes the corpus non-greenfield.
    await genRepo.insertNew({
      modelName: "qwen3-embed-0.6b",
      embeddingDimension: 1024,
      generationLabel: null,
      generationReason: null,
      createdByEmail: ACTOR,
      createdFromGeneration: 1,
    });
    await expect(
      promoteValidatedEmbedderConfig(db, {
        expectedRevision: token,
        modelName: "mxbai-embed-large",
        provider: "openai_compat",
        expectedDimension: 1024,
        actorEmail: ACTOR,
      }),
    ).rejects.toBeInstanceOf(EmbedderNotGreenfieldError);
  });

  it("re-test of the UNCHANGED active config on a non-greenfield corpus SUCCEEDS (7-2)", async () => {
    // First promote mxbai-embed-large on the greenfield corpus.
    const t1 = await stage("mxbai-embed-large");
    await promoteValidatedEmbedderConfig(db, {
      expectedRevision: t1,
      modelName: "mxbai-embed-large",
      provider: "openai_compat",
      expectedDimension: 1024,
      actorEmail: ACTOR,
    });
    // Now the corpus is non-greenfield (a re-embed generation exists)…
    await genRepo.insertNew({
      modelName: "mxbai-embed-large",
      embeddingDimension: 1024,
      generationLabel: null,
      generationReason: null,
      createdByEmail: ACTOR,
      createdFromGeneration: 1,
    });
    // …but re-testing the SAME active config must still succeed (contract unchanged → no greenfield gate).
    const t2 = await stage("mxbai-embed-large");
    await promoteValidatedEmbedderConfig(db, {
      expectedRevision: t2,
      modelName: "mxbai-embed-large",
      provider: "openai_compat",
      expectedDimension: 1024,
      actorEmail: ACTOR,
    });
    expect((await repo.readNonSecret())!.lastValidationStatus).toBe("ok");
  });

  it("a dimension disagreement on the active generation → EmbedderProvenanceError", async () => {
    await pool.query("UPDATE core.embedding_generations SET embedding_dimension = 512 WHERE generation_id = 1");
    const token = await stage("mxbai-embed-large");
    await expect(
      promoteValidatedEmbedderConfig(db, {
        expectedRevision: token,
        modelName: "mxbai-embed-large",
        provider: "openai_compat",
        expectedDimension: 1024,
        actorEmail: ACTOR,
      }),
    ).rejects.toBeInstanceOf(EmbedderProvenanceError);
  });
});
