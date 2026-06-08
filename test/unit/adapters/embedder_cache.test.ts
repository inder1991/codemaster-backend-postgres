// Unit tests for PostgresEmbedderCache (apps/backend/src/adapters/embedder_cache.ts).
//
// PostgresEmbedderCache is the TS port of the frozen Python `codemaster.embedder.cache.EmbedderCache`
// with the documented LAZY-TTL divergence (see the adapter header): instead of a background 15s poll
// TASK, a config_version-aware refresh re-reads the runtime_state row when the snapshot is older than a
// 15s TTL (driven by an injected Clock's monotonic axis). The reads (getRetrievalMode /
// getActiveGeneration / getActiveModelName) serve a frozen snapshot; a refresh validates the
// embedding-dimension invariant (the active generation's embedding_dimension must equal the expected
// dim, default 1024) — a mismatch throws EmbeddingDimensionInvariantError.
//
// These tests use STUB runtime-state + generations repos (no DB, no Temporal). The integration parity
// proof (fallback ≡ legacy) lives in test/integration/adapters/postgres_confluence_retrieval.integration.test.ts.

import { describe, expect, it } from "vitest";

import {
  EmbeddingDimensionInvariantError,
  PostgresEmbedderCache,
} from "#backend/adapters/embedder_cache.js";

import { FakeClock } from "#platform/clock.js";

import type { EmbedderRuntimeStateRowV1 } from "#contracts/embedder_runtime_state.v1.js";
import type { EmbeddingGenerationRowV1 } from "#contracts/embedding_generation.v1.js";

// ─── Stub repos (the narrow slices PostgresEmbedderCache consumes) ────────────────────────────────

/** Build a runtime-state row with overridable fields (the singleton projection the cache reads). */
function stateRow(over: Partial<EmbedderRuntimeStateRowV1> = {}): EmbedderRuntimeStateRowV1 {
  return {
    active_generation: 7,
    active_model_name: "mxbai-embed-large-v1",
    pending_generation: null,
    pending_model_name: null,
    config_version: 1,
    retrieval_mode: "fallback",
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_by_email: null,
    ...over,
  };
}

/** Build a generation row with overridable fields (only embedding_dimension is load-bearing here). */
function genRow(over: Partial<EmbeddingGenerationRowV1> = {}): EmbeddingGenerationRowV1 {
  return {
    generation_id: 7,
    state: "active",
    generation_label: null,
    generation_reason: null,
    provider_name: "qwen",
    provider_version: null,
    model_name: "mxbai-embed-large-v1",
    embedding_dimension: 1024,
    created_from_generation: null,
    chunker_version: "1",
    preprocessing_version: "1",
    normalization_version: "1",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    created_by_email: null,
    backfill_started_at: null,
    backfill_completed_at: null,
    validation_started_at: null,
    validation_completed_at: null,
    validation_report_json: null,
    validation_passed: null,
    activated_at: null,
    retired_at: null,
    retire_reason: null,
    gc_started_at: null,
    gc_completed_at: null,
    total_chunks: 0,
    chunks_backfilled: 0,
    chunks_failed: 0,
    last_error: null,
    ...over,
  };
}

/** Mutable stub of the runtime-state repo's `get()` slice; counts reads so we can assert TTL behaviour. */
class StubStateRepo {
  public reads = 0;
  public constructor(public row: EmbedderRuntimeStateRowV1) {}
  public async get(): Promise<EmbedderRuntimeStateRowV1> {
    this.reads += 1;
    return this.row;
  }
}

/** Stub of the generations repo's `get(id)` slice — returns the row for the matching generation id. */
class StubGenerationsRepo {
  public reads = 0;
  public constructor(private readonly rows: ReadonlyMap<number, EmbeddingGenerationRowV1>) {}
  public async get(generationId: number): Promise<EmbeddingGenerationRowV1 | null> {
    this.reads += 1;
    return this.rows.get(generationId) ?? null;
  }
}

function buildCache(args: {
  state: StubStateRepo;
  gens: StubGenerationsRepo;
  clock: FakeClock;
  expectedDimension?: number;
}): PostgresEmbedderCache {
  return new PostgresEmbedderCache({
    runtimeStateRepo: args.state,
    generationsRepo: args.gens,
    clock: args.clock,
    ...(args.expectedDimension !== undefined ? { expectedDimension: args.expectedDimension } : {}),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────────────────────────

describe("PostgresEmbedderCache reads", () => {
  it("getRetrievalMode / getActiveGeneration / getActiveModelName read the started snapshot", async () => {
    const state = new StubStateRepo(
      stateRow({ active_generation: 7, active_model_name: "mxbai-embed-large-v1", retrieval_mode: "fallback" }),
    );
    const gens = new StubGenerationsRepo(new Map([[7, genRow({ generation_id: 7, embedding_dimension: 1024 })]]));
    const clock = new FakeClock();
    const cache = buildCache({ state, gens, clock });

    await cache.start();

    expect(cache.getRetrievalMode()).toBe("fallback");
    expect(cache.getActiveGeneration()).toBe(7);
    expect(cache.getActiveModelName()).toBe("mxbai-embed-large-v1");
  });

  it("getActiveGeneration throws before start() (no snapshot installed)", () => {
    const state = new StubStateRepo(stateRow());
    const gens = new StubGenerationsRepo(new Map([[7, genRow()]]));
    const cache = buildCache({ state, gens, clock: new FakeClock() });
    expect(() => cache.getActiveGeneration()).toThrow();
  });
});

describe("PostgresEmbedderCache lazy-TTL refresh", () => {
  // The sync get*() reads serve the snapshot (faithful to the Python's sync get_*); the TTL refresh runs
  // at the async per-query/per-batch boundary via `tick()` (the confluence adapter / dual-write awaits it
  // once before the sync reads). These tests drive the boundary explicitly.

  it("tick() does NOT re-read the runtime state within the 15s TTL window", async () => {
    const state = new StubStateRepo(stateRow({ config_version: 1, retrieval_mode: "fallback" }));
    const gens = new StubGenerationsRepo(new Map([[7, genRow()]]));
    const clock = new FakeClock();
    const cache = buildCache({ state, gens, clock });
    await cache.start();
    const readsAfterStart = state.reads;

    // Advance only 5s (< 15s TTL) and bump config_version on the DB row: tick() must NOT refresh.
    clock.advance({ seconds: 5 });
    state.row = stateRow({ config_version: 2, retrieval_mode: "generation_only" });
    await cache.tick();

    expect(cache.getRetrievalMode()).toBe("fallback"); // still the snapshot, no refresh
    expect(state.reads).toBe(readsAfterStart); // no extra DB read inside the TTL
  });

  it("tick() refreshes past the TTL and picks up a config_version bump (mode flip propagates)", async () => {
    const state = new StubStateRepo(stateRow({ config_version: 1, retrieval_mode: "fallback", active_generation: 7 }));
    const gens = new StubGenerationsRepo(
      new Map([
        [7, genRow({ generation_id: 7, embedding_dimension: 1024 })],
        [9, genRow({ generation_id: 9, embedding_dimension: 1024 })],
      ]),
    );
    const clock = new FakeClock();
    const cache = buildCache({ state, gens, clock });
    await cache.start();

    // Operator flips retrieval_mode + active generation; config_version bumps. Advance PAST the TTL.
    state.row = stateRow({ config_version: 2, retrieval_mode: "generation_only", active_generation: 9 });
    clock.advance({ seconds: 16 });
    await cache.tick();

    expect(cache.getRetrievalMode()).toBe("generation_only");
    expect(cache.getActiveGeneration()).toBe(9);
    expect(state.reads).toBeGreaterThan(1); // a real DB re-read happened
  });

  it("tick() refreshes past the TTL but keeps the snapshot when config_version is unchanged", async () => {
    const state = new StubStateRepo(stateRow({ config_version: 5, retrieval_mode: "fallback" }));
    const gens = new StubGenerationsRepo(new Map([[7, genRow()]]));
    const clock = new FakeClock();
    const cache = buildCache({ state, gens, clock });
    await cache.start();
    const gensReadsAfterStart = gens.reads;

    clock.advance({ seconds: 20 }); // past TTL → re-reads runtime_state ...
    await cache.tick();
    // ... but config_version is the SAME, so NO dim re-validation (generations repo not re-read).
    expect(cache.getRetrievalMode()).toBe("fallback");
    expect(state.reads).toBeGreaterThan(1); // runtime_state was re-read on the tick
    expect(gens.reads).toBe(gensReadsAfterStart); // no dim re-validation when version is unchanged
  });
});

describe("PostgresEmbedderCache dimension invariant", () => {
  it("start() throws EmbeddingDimensionInvariantError when the active generation's dim != expected", async () => {
    const state = new StubStateRepo(stateRow({ active_generation: 7 }));
    const gens = new StubGenerationsRepo(new Map([[7, genRow({ generation_id: 7, embedding_dimension: 768 })]]));
    const cache = buildCache({ state, gens, clock: new FakeClock(), expectedDimension: 1024 });

    await expect(cache.start()).rejects.toBeInstanceOf(EmbeddingDimensionInvariantError);
  });

  it("a config_version-bump refresh to a wrong-dim generation throws EmbeddingDimensionInvariantError", async () => {
    const state = new StubStateRepo(stateRow({ config_version: 1, active_generation: 7 }));
    const gens = new StubGenerationsRepo(
      new Map([
        [7, genRow({ generation_id: 7, embedding_dimension: 1024 })],
        [9, genRow({ generation_id: 9, embedding_dimension: 512 })], // wrong dim
      ]),
    );
    const clock = new FakeClock();
    const cache = buildCache({ state, gens, clock, expectedDimension: 1024 });
    await cache.start();

    // Bump to the wrong-dim generation; advance past the TTL → the lazy refresh (tick) must throw.
    state.row = stateRow({ config_version: 2, active_generation: 9 });
    clock.advance({ seconds: 16 });

    await expect(cache.tick()).rejects.toBeInstanceOf(EmbeddingDimensionInvariantError);
  });

  it("start() throws when the active generation row is missing", async () => {
    const state = new StubStateRepo(stateRow({ active_generation: 42 }));
    const gens = new StubGenerationsRepo(new Map()); // no row for gen 42
    const cache = buildCache({ state, gens, clock: new FakeClock() });
    await expect(cache.start()).rejects.toBeInstanceOf(EmbeddingDimensionInvariantError);
  });
});
