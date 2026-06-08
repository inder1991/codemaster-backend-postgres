// Real-DB integration test for the embedder runtime-state singleton repo — the 1:1 TS port of the
// frozen Python vendor/codemaster-py/codemaster/embedder/runtime_state_repo.py.
//
// Runs ONLY when CODEMASTER_PG_CORE_DSN is set (the shared describeDb gate), pointing at the DISPOSABLE
// Postgres (postgresql://postgres:postgres@localhost:5434/codemaster). SKIPS otherwise. NEVER the
// cluster, NEVER migrations.
//
// CARE — this is a SINGLETON table (CHECK singleton=true → exactly ONE row, seeded by the baseline
// migration). The test MUST NOT corrupt the shared singleton: it SNAPSHOTS the full row in beforeAll
// and RESTORES every mutated field in afterEach (the `finally` of each mutating test, hoisted to the
// hook so a thrown assertion still restores). We never INSERT/DELETE the singleton — only UPDATE-in-
// place — and we restore the original active/pending pointers, retrieval_mode, config_version and
// updated_by_email so a re-run / concurrent suite sees the pristine seed.
//
// Coverage (the task test plan):
//   - get() returns the singleton.
//   - set_pending / clear_pending move the pending pair (the pending-pair biconditional holds) and bump
//     config_version monotonically.
//   - activate() sets the active pointer, clears pending, bumps config_version.
//   - set_retrieval_mode flips to generation_only and back to fallback (each bumps config_version).
//   - bump_config_version increments the version without changing any other field.
//   - every write bumps config_version by exactly 1.

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { PostgresEmbedderRuntimeStateRepo } from "#backend/domain/repos/embedder_runtime_state_repo.js";

import { disposeAllPools, getPool, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

type Snapshot = {
  active_generation: number;
  active_model_name: string;
  pending_generation: number | null;
  pending_model_name: string | null;
  config_version: number;
  retrieval_mode: string;
  updated_by_email: string | null;
};

describeDb("PostgresEmbedderRuntimeStateRepo (integration)", () => {
  const db = tenantKysely<unknown>(INTEGRATION_DSN as string);
  const repo = new PostgresEmbedderRuntimeStateRepo({ db });
  const pool = getPool(INTEGRATION_DSN as string);

  let snapshot: Snapshot | null = null;

  const restore = async (): Promise<void> => {
    if (snapshot === null) return;
    // Restore the singleton to its pristine seed shape, INCLUDING config_version (so a re-run starts
    // from the same baseline). UPDATE-in-place; we never touch the singleton row's existence.
    await pool.query(
      `UPDATE core.embedder_runtime_state
          SET active_generation = $1, active_model_name = $2,
              pending_generation = $3, pending_model_name = $4,
              config_version = $5, retrieval_mode = $6, updated_by_email = $7
        WHERE singleton = true`,
      [
        snapshot.active_generation,
        snapshot.active_model_name,
        snapshot.pending_generation,
        snapshot.pending_model_name,
        snapshot.config_version,
        snapshot.retrieval_mode,
        snapshot.updated_by_email,
      ],
    );
  };

  beforeAll(async () => {
    const r = await pool.query(
      `SELECT active_generation, active_model_name, pending_generation, pending_model_name,
              config_version, retrieval_mode, updated_by_email
         FROM core.embedder_runtime_state WHERE singleton = true`,
    );
    expect(r.rowCount).toBe(1);
    const row = r.rows[0];
    snapshot = {
      active_generation: Number(row.active_generation),
      active_model_name: String(row.active_model_name),
      pending_generation: row.pending_generation === null ? null : Number(row.pending_generation),
      pending_model_name: row.pending_model_name,
      config_version: Number(row.config_version),
      retrieval_mode: String(row.retrieval_mode),
      updated_by_email: row.updated_by_email,
    };
  });

  afterEach(async () => {
    await restore();
  });

  afterAll(async () => {
    await restore();
    await disposeAllPools();
  });

  it("get() returns the singleton with its typed fields", async () => {
    const row = await repo.get();
    expect(row.active_generation).toBe(snapshot?.active_generation);
    expect(row.active_model_name).toBe(snapshot?.active_model_name);
    expect(row.config_version).toBe(snapshot?.config_version);
    expect(row.retrieval_mode).toBe(snapshot?.retrieval_mode);
  });

  it("set_pending sets the pending pair (biconditional holds) and bumps config_version by 1", async () => {
    const before = await repo.get();
    await repo.setPending({ generationId: 1, modelName: "qwen3-pending", updatedByEmail: "ops@example.com" });

    const after = await repo.get();
    expect(after.pending_generation).toBe(1);
    expect(after.pending_model_name).toBe("qwen3-pending");
    expect(after.config_version).toBe(before.config_version + 1);
    expect(after.updated_by_email).toBe("ops@example.com");
  });

  it("clear_pending clears BOTH pending fields (biconditional holds) and bumps config_version", async () => {
    await repo.setPending({ generationId: 1, modelName: "qwen3-pending", updatedByEmail: "ops@example.com" });
    const mid = await repo.get();
    expect(mid.pending_generation).toBe(1);

    await repo.clearPending({ updatedByEmail: "ops2@example.com" });
    const after = await repo.get();
    expect(after.pending_generation).toBeNull();
    expect(after.pending_model_name).toBeNull();
    expect(after.config_version).toBe(mid.config_version + 1);
  });

  it("activate() sets the active pointer, clears pending, bumps config_version", async () => {
    // Seed a pending pair first so activate() is observed to clear it.
    await repo.setPending({ generationId: 1, modelName: "qwen3-pending", updatedByEmail: "ops@example.com" });
    const before = await repo.get();
    expect(before.pending_generation).toBe(1);

    // active_generation must reference a real generation_id (FK). Use the seed's own active id so we
    // never violate the FK regardless of what gen 1 is on this DB.
    const targetGen = snapshot?.active_generation ?? 1;
    await repo.activate({ generationId: targetGen, modelName: "qwen3-activated", updatedByEmail: "ops@example.com" });

    const after = await repo.get();
    expect(after.active_generation).toBe(targetGen);
    expect(after.active_model_name).toBe("qwen3-activated");
    expect(after.pending_generation).toBeNull();
    expect(after.pending_model_name).toBeNull();
    expect(after.config_version).toBe(before.config_version + 1);
  });

  it("set_retrieval_mode flips to generation_only and back to fallback, each bumping config_version", async () => {
    const before = await repo.get();
    await repo.setRetrievalMode({ mode: "generation_only", updatedByEmail: "ops@example.com" });
    const gen = await repo.get();
    expect(gen.retrieval_mode).toBe("generation_only");
    expect(gen.config_version).toBe(before.config_version + 1);

    await repo.setRetrievalMode({ mode: "fallback", updatedByEmail: "ops@example.com" });
    const fb = await repo.get();
    expect(fb.retrieval_mode).toBe("fallback");
    expect(fb.config_version).toBe(gen.config_version + 1);
  });

  it("bump_config_version increments ONLY config_version (no other field changes)", async () => {
    const before = await repo.get();
    await repo.bumpConfigVersion({ updatedByEmail: "rotator@example.com" });
    const after = await repo.get();

    expect(after.config_version).toBe(before.config_version + 1);
    // Every other field is unchanged.
    expect(after.active_generation).toBe(before.active_generation);
    expect(after.active_model_name).toBe(before.active_model_name);
    expect(after.pending_generation).toBe(before.pending_generation);
    expect(after.pending_model_name).toBe(before.pending_model_name);
    expect(after.retrieval_mode).toBe(before.retrieval_mode);
    expect(after.updated_by_email).toBe("rotator@example.com");
  });

  it("the pending-pair biconditional REJECTS a half-populated pending pair (the CHECK is the safety net)", async () => {
    // Force pending_generation WITHOUT pending_model_name → violates the pending-pair biconditional.
    await expect(
      pool.query(
        "UPDATE core.embedder_runtime_state SET pending_generation = 99, pending_model_name = NULL WHERE singleton = true",
      ),
    ).rejects.toThrow(/pending_pair_biconditional|check constraint/i);
  });
});
