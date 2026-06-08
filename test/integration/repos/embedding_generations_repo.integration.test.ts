// Real-DB integration test for the embedder generation STATE-MACHINE repo — the 1:1 TS port of the
// frozen Python vendor/codemaster-py/codemaster/embedder/generations_repo.py.
//
// Runs ONLY when CODEMASTER_PG_CORE_DSN is set (the shared describeDb gate), pointing at the DISPOSABLE
// Postgres (postgresql://postgres:postgres@localhost:5434/codemaster) with migrations applied. SKIPS
// otherwise so validate-fast stays green without a DB. NEVER the cluster, NEVER migrations.
//
// CARE — these are SINGLETON / platform tables:
//   * core.embedding_generations is seeded by the baseline migration with gen 1 (state=active,
//     backfill_started_at/completed_at NULL — the migration-seed shape that drives the COALESCE branch
//     in transition_to_active). The singleton core.embedder_runtime_state.active_generation FK points at
//     gen 1. So this test NEVER deletes gen 1 and ALWAYS restores any seed-active row it demotes.
//   * generation_id comes from a bigint SEQUENCE. The test inserts NEW generations (ids > the seed) and
//     DELETEs exactly those rows in cleanup — keyed by a unique model_name marker so a concurrent suite
//     never collides and cleanup is surgical.
//
// Coverage (the task test plan):
//   - insertNew → fresh generation_id (sequence), state=backfilling, backfill_started_at set,
//     completed/activated/retired NULL (the backfilling biconditional).
//   - transition chain backfilling→ready→active→retired; each state↔timestamp pairing read back +
//     asserted to satisfy the DB biconditional.
//   - transitionToActive single-active enforcement: promoting a second generation DEMOTES the prior
//     active to 'ready' (activated_at NULL, backfill_completed_at COALESCE'd) — including the seed gen 1.
//   - a hand-rolled UPDATE that would VIOLATE the state biconditional is REJECTED by PG (the CHECK is
//     the safety net).
//   - record_validation / record_gc_* / record_error / update_backfill_progress / list_recent /
//     count_chunk_embeddings.

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { PostgresEmbeddingGenerationsRepo } from "#backend/domain/repos/embedding_generations_repo.js";

import { disposeAllPools, getPool, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// A unique model_name marker per file run so concurrent suites never collide; cleanup is keyed on it.
const TEST_MODEL = `zzinttest-gen-${process.pid}`;

type SeedActiveSnapshot = {
  generationId: number;
  backfillCompletedAt: Date | null;
};

describeDb("PostgresEmbeddingGenerationsRepo (integration)", () => {
  const db = tenantKysely<unknown>(INTEGRATION_DSN as string);
  const repo = new PostgresEmbeddingGenerationsRepo({ db });
  const pool = getPool(INTEGRATION_DSN as string);

  // The seed-active generation (gen 1) we may demote during the single-active test. Snapshot the fields
  // transition_to_active mutates so we can restore the seed to 'active' afterward (the runtime-state FK
  // depends on it). We DO NOT touch the runtime-state row itself.
  let seedActive: SeedActiveSnapshot | null = null;

  const cleanup = async (): Promise<void> => {
    // Remove only the generations THIS test created (keyed by the unique model marker). Never gen 1.
    await pool.query("DELETE FROM core.embedding_generations WHERE model_name = $1", [TEST_MODEL]);
  };

  const restoreSeedActive = async (): Promise<void> => {
    if (seedActive === null) return;
    // If a single-active test demoted the seed to 'ready', put it back to 'active'. Idempotent: a no-op
    // when the seed is already active.
    await pool.query(
      `UPDATE core.embedding_generations
          SET state = 'active', activated_at = COALESCE(activated_at, now()),
              backfill_completed_at = $2, retired_at = NULL, retire_reason = NULL
        WHERE generation_id = $1 AND state <> 'active'`,
      [seedActive.generationId, seedActive.backfillCompletedAt],
    );
  };

  beforeAll(async () => {
    await pool.query("SELECT 1 FROM core.embedding_generations WHERE false");
    const seed = await pool.query(
      "SELECT generation_id, backfill_completed_at FROM core.embedding_generations WHERE state = 'active' ORDER BY generation_id LIMIT 1",
    );
    if (seed.rowCount && seed.rows[0]) {
      seedActive = {
        generationId: Number(seed.rows[0].generation_id),
        backfillCompletedAt: seed.rows[0].backfill_completed_at as Date | null,
      };
    }
    await cleanup();
  });

  afterEach(async () => {
    await restoreSeedActive();
    await cleanup();
  });

  afterAll(async () => {
    await restoreSeedActive();
    await cleanup();
    await disposeAllPools();
  });

  async function insertFresh(
    overrides: { label?: string | null; reason?: string | null; fromGen?: number | null } = {},
  ): ReturnType<typeof repo.insertNew> {
    return repo.insertNew({
      modelName: TEST_MODEL,
      embeddingDimension: 1024,
      generationLabel: overrides.label ?? "test-gen",
      generationReason: overrides.reason ?? "integration test",
      createdByEmail: "ops@example.com",
      createdFromGeneration: overrides.fromGen ?? null,
    });
  }

  it("insertNew returns a fresh sequence id in state=backfilling with the backfilling biconditional", async () => {
    const a = await insertFresh();
    const b = await insertFresh();

    // Sequence allocates DISTINCT, monotonically increasing ids.
    expect(b.generation_id).toBeGreaterThan(a.generation_id);

    expect(a.state).toBe("backfilling");
    expect(a.provider_name).toBe("qwen");
    expect(a.embedding_dimension).toBe(1024);
    // backfilling biconditional: started set, completed/activated/retired NULL.
    expect(a.backfill_started_at).not.toBeNull();
    expect(a.backfill_completed_at).toBeNull();
    expect(a.activated_at).toBeNull();
    expect(a.retired_at).toBeNull();
    expect(a.retire_reason).toBeNull();
    // defaults applied.
    expect(a.chunker_version).toBe("1");
    expect(a.total_chunks).toBe(0);

    // get() round-trips the same row.
    const got = await repo.get(a.generation_id);
    expect(got?.generation_id).toBe(a.generation_id);
    expect(got?.model_name).toBe(TEST_MODEL);
  });

  it("transition backfilling→ready sets backfill_completed_at (ready biconditional)", async () => {
    const g = await insertFresh();
    await repo.transitionToReady(g.generation_id);

    const row = await repo.get(g.generation_id);
    expect(row?.state).toBe("ready");
    // ready biconditional: completed set, activated/retired NULL.
    expect(row?.backfill_completed_at).not.toBeNull();
    expect(row?.activated_at).toBeNull();
    expect(row?.retired_at).toBeNull();
  });

  it("transition ready→active sets activated_at (active biconditional) and demotes the prior active [single-active]", async () => {
    // Two of OUR generations; promote g1, then promote g2 — g1 must be demoted to 'ready'.
    const g1 = await insertFresh({ label: "first" });
    const g2 = await insertFresh({ label: "second" });
    await repo.transitionToReady(g1.generation_id);
    await repo.transitionToReady(g2.generation_id);

    await repo.transitionToActive(g1.generation_id);
    const afterG1Active = await repo.get(g1.generation_id);
    expect(afterG1Active?.state).toBe("active");
    expect(afterG1Active?.activated_at).not.toBeNull();
    expect(afterG1Active?.retired_at).toBeNull();

    // Promoting g2 demotes g1 (AND the seed gen 1) to 'ready' in the same transaction.
    await repo.transitionToActive(g2.generation_id);

    const g2Row = await repo.get(g2.generation_id);
    expect(g2Row?.state).toBe("active");
    expect(g2Row?.activated_at).not.toBeNull();

    const g1Row = await repo.get(g1.generation_id);
    // SINGLE-ACTIVE INVARIANT: the prior active is demoted to 'ready' (activated_at cleared,
    // backfill_completed_at preserved → ready biconditional holds).
    expect(g1Row?.state).toBe("ready");
    expect(g1Row?.activated_at).toBeNull();
    expect(g1Row?.backfill_completed_at).not.toBeNull();

    // Exactly ONE active generation across the whole table.
    const actives = await pool.query("SELECT COUNT(*) AS c FROM core.embedding_generations WHERE state = 'active'");
    expect(Number(actives.rows[0].c)).toBe(1);
  });

  it("transitionToActive demotes the seed gen 1 via the COALESCE branch (backfill_completed_at was NULL)", async () => {
    // The seed gen 1 has backfill_completed_at = NULL. Demoting it to 'ready' would violate the ready
    // biconditional unless transition_to_active COALESCEs it to now(). This is the [[embedder-seed-demote]]
    // memory case. Promote OUR generation; the seed is demoted to ready with a freshly-stamped
    // backfill_completed_at.
    if (seedActive === null || seedActive.backfillCompletedAt !== null) {
      // Only meaningful when the seed-active row had a NULL completed_at (the migration-seed shape).
      return;
    }
    const g = await insertFresh();
    await repo.transitionToReady(g.generation_id);
    await repo.transitionToActive(g.generation_id);

    const seedRow = await repo.get(seedActive.generationId);
    expect(seedRow?.state).toBe("ready");
    expect(seedRow?.activated_at).toBeNull();
    // COALESCE'd from NULL → now(): the ready biconditional is satisfied.
    expect(seedRow?.backfill_completed_at).not.toBeNull();
  });

  it("transition active→retired sets retired_at + retire_reason (retired biconditional + retire_reason biconditional)", async () => {
    const g = await insertFresh();
    await repo.transitionToReady(g.generation_id);
    // transitionToRetired only fires on backfilling/ready (matches the Python WHERE clause).
    await repo.transitionToRetired(g.generation_id, "manual_retire");

    const row = await repo.get(g.generation_id);
    expect(row?.state).toBe("retired");
    expect(row?.retired_at).not.toBeNull();
    expect(row?.retire_reason).toBe("manual_retire");
  });

  it("transitionToActive on a retired generation clears retired_at + retire_reason (rollback path)", async () => {
    // The Python promote-target UPDATE sets retired_at=NULL, retire_reason=NULL so retired→active
    // satisfies the active biconditional (active AND retired_at IS NULL).
    const g = await insertFresh();
    await repo.transitionToReady(g.generation_id);
    await repo.transitionToRetired(g.generation_id, "cancelled");
    expect((await repo.get(g.generation_id))?.state).toBe("retired");

    await repo.transitionToActive(g.generation_id);
    const row = await repo.get(g.generation_id);
    expect(row?.state).toBe("active");
    expect(row?.activated_at).not.toBeNull();
    expect(row?.retired_at).toBeNull();
    expect(row?.retire_reason).toBeNull();
  });

  it("the DB state biconditional REJECTS a state set without its timestamp (the CHECK is the safety net)", async () => {
    const g = await insertFresh();
    // Force state='ready' WITHOUT setting backfill_completed_at → violates the ready biconditional.
    await expect(
      pool.query(
        "UPDATE core.embedding_generations SET state = 'ready' WHERE generation_id = $1",
        [g.generation_id],
      ),
    ).rejects.toThrow(/embedding_generations_state_biconditional|check constraint/i);
  });

  it("update_backfill_progress updates counts (with and without total_chunks)", async () => {
    const g = await insertFresh();
    await repo.updateBackfillProgress({ generationId: g.generation_id, chunksBackfilled: 10, chunksFailed: 2 });
    let row = await repo.get(g.generation_id);
    expect(row?.chunks_backfilled).toBe(10);
    expect(row?.chunks_failed).toBe(2);
    expect(row?.total_chunks).toBe(0); // untouched

    await repo.updateBackfillProgress({ generationId: g.generation_id, chunksBackfilled: 50, chunksFailed: 3, totalChunks: 100 });
    row = await repo.get(g.generation_id);
    expect(row?.chunks_backfilled).toBe(50);
    expect(row?.chunks_failed).toBe(3);
    expect(row?.total_chunks).toBe(100);
  });

  it("record_validation stamps timestamps + re-encodes the JSONB report to canonical JSON text", async () => {
    const g = await insertFresh();
    const report = JSON.stringify({ passed: true, samples: 42 });
    await repo.recordValidation({ generationId: g.generation_id, reportJson: report, passed: true });

    const row = await repo.get(g.generation_id);
    expect(row?.validation_started_at).not.toBeNull();
    expect(row?.validation_completed_at).not.toBeNull();
    expect(row?.validation_passed).toBe(true);
    // asyncpg/pg parses JSONB to an object; the repo re-encodes to canonical JSON text (the Python
    // json.dumps branch). Parse it back to assert structural equality regardless of key ordering.
    expect(JSON.parse(row?.validation_report_json ?? "null")).toEqual({ passed: true, samples: 42 });
  });

  it("record_gc_started / record_gc_completed / record_error stamp their fields", async () => {
    const g = await insertFresh();
    await repo.recordGcStarted(g.generation_id);
    await repo.recordGcCompleted(g.generation_id);
    await repo.recordError({ generationId: g.generation_id, errorMsg: "boom" });

    const row = await repo.get(g.generation_id);
    expect(row?.gc_started_at).not.toBeNull();
    expect(row?.gc_completed_at).not.toBeNull();
    expect(row?.last_error).toBe("boom");
  });

  it("record_error truncates a very long error to 8192 chars (Python error_msg[:8192])", async () => {
    const g = await insertFresh();
    await repo.recordError({ generationId: g.generation_id, errorMsg: "x".repeat(10000) });
    const row = await repo.get(g.generation_id);
    expect(row?.last_error?.length).toBe(8192);
  });

  it("list_recent returns our generations newest-first and get() returns null for a missing id", async () => {
    const a = await insertFresh({ label: "older" });
    const b = await insertFresh({ label: "newer" });
    const recent = await repo.listRecent(50);
    const ours = recent.filter((r) => r.model_name === TEST_MODEL);
    // Newest-first: b (higher id) precedes a among ours.
    const idxB = ours.findIndex((r) => r.generation_id === b.generation_id);
    const idxA = ours.findIndex((r) => r.generation_id === a.generation_id);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeGreaterThan(idxB);

    expect(await repo.get(-1)).toBeNull();
  });

  it("count_chunk_embeddings counts rows under a generation (zero for a fresh generation)", async () => {
    const g = await insertFresh();
    expect(await repo.countChunkEmbeddings(g.generation_id)).toBe(0);
  });

  it("count_canonical_chunks returns the two canonical-chunk counts", async () => {
    const counts = await repo.countCanonicalChunks();
    expect(typeof counts.confluence_chunks).toBe("number");
    expect(typeof counts.knowledge_chunks).toBe("number");
    expect(counts.confluence_chunks).toBeGreaterThanOrEqual(0);
    expect(counts.knowledge_chunks).toBeGreaterThanOrEqual(0);
  });
});
