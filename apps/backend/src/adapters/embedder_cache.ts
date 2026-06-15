/**
 * PostgresEmbedderCache — config_version-aware in-process snapshot of the singleton
 * `core.embedder_runtime_state` row (spec v4 §11.5). Worker activities + retrieval queries read the
 * active generation / model / retrieval_mode from this cache (avoiding a per-call DB round-trip), and
 * the read methods serve a FROZEN snapshot so concurrent readers never see a torn read.
 *
 * ── LAZY-TTL refresh, NOT a background poll TASK ────────────────────────────────────────────────────
 * Every `get*()` read first checks whether the snapshot is older than a 15s TTL (measured on the
 * injected {@link Clock}'s monotonic axis); if so, it re-reads `core.embedder_runtime_state` and — on
 * a config_version change — installs a fresh snapshot (re-validating the embedding-dimension
 * invariant against the new active generation).
 *
 * The per-query / per-batch readers are the ONLY consumers, and the lazy refresh gives the SAME
 * ≤30s-staleness guarantee as a 15s poll (a reader observes a config bump within one TTL of its next
 * read). A worker-spawned poll loop is OUT OF SCOPE here — it belongs to the embedder-maintenance
 * worker composition, tracked as FOLLOW-UP-embedder-cache-worker-composition. The lazy refresh emits
 * no metric.
 *
 * ── Dimension invariant (spec v4 §4.4) ──────────────────────────────────────────────────────────────
 * The active generation's `core.embedding_generations.embedding_dimension` MUST equal the expected dim
 * (default {@link PLATFORM_EMBEDDING_DIMENSION} = 1024). A mismatch (or a missing active generation
 * row) throws {@link EmbeddingDimensionInvariantError}. This avoids a network round-trip in the cache
 * while preserving the structural guarantee: a generation whose stored dim disagrees with the platform
 * invariant can never be served.
 *
 * ── Singleton over CODEMASTER_PG_CORE_DSN ────────────────────────────────────────────────────────────
 * {@link embedderCacheSingleton} builds + memoizes ONE started cache over the process-wide ADR-0062 pool
 * (like the other repos; lazy first build). The retrieval wiring AND the confluence dual-write share
 * that single instance so they read the same snapshot.
 *
 * ── ADR-0062 ─────────────────────────────────────────────────────────────────────────────────────────
 * Owns NO pool/engine cache — handed narrow repo ports over the shared `tenantKysely` pool by injection.
 */

import { PostgresEmbedderRuntimeStateRepo } from "#backend/domain/repos/embedder_runtime_state_repo.js";
import { PostgresEmbeddingGenerationsRepo } from "#backend/domain/repos/embedding_generations_repo.js";

import { EMBEDDING_DIM } from "#backend/adapters/embeddings_port.js";

import type { Clock } from "#platform/clock.js";
import { tenantKysely } from "#platform/db/database.js";

import type { EmbedderRuntimeStateRowV1, RetrievalMode } from "#contracts/embedder_runtime_state.v1.js";

// ─── Constants ───────────────────────────────────────────────────────────────────────────────────

/** v4 §11.5 ≤30s SLA = 15s refresh TTL. */
const REFRESH_TTL_SECONDS = 15.0;

/** v4 §4.4 platform invariant: every active generation must embed at the CONFIGURED dimension
 *  (= EMBEDDING_DIM / CODEMASTER_EMBEDDING_DIMENSION, default 1024). Single source of truth. */
export const PLATFORM_EMBEDDING_DIMENSION = EMBEDDING_DIM;

// ─── Errors ──────────────────────────────────────────────────────────────────────────────────────

/** Base for embedder-cache errors. */
export class EmbedderCacheError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EmbedderCacheError";
  }
}

/**
 * v4 §4.4 — the active generation's persisted `embedding_dimension` disagrees with the platform
 * invariant (or the active generation row is missing).
 */
export class EmbeddingDimensionInvariantError extends EmbedderCacheError {
  public constructor(message: string) {
    super(message);
    this.name = "EmbeddingDimensionInvariantError";
  }
}

// ─── Narrow injected ports (the exact slice the cache consumes) ──────────────────────────────────

/** The runtime-state `get()` slice {@link PostgresEmbedderRuntimeStateRepo} satisfies. */
export type RuntimeStateReader = {
  get(): Promise<EmbedderRuntimeStateRowV1>;
};

/** The generations `get(id)` slice {@link PostgresEmbeddingGenerationsRepo} satisfies (dim check). */
export type GenerationsReader = {
  get(generationId: number): Promise<{ embedding_dimension: number } | null>;
};

/** Immutable snapshot of the runtime state at last refresh. */
type CachedState = {
  readonly activeGeneration: number;
  readonly activeModelName: string;
  readonly retrievalMode: RetrievalMode;
  readonly configVersion: number;
  /** Monotonic seconds at which this snapshot was installed (drives the lazy TTL). */
  readonly observedAtMonotonic: number;
};

export type PostgresEmbedderCacheOptions = {
  runtimeStateRepo: RuntimeStateReader;
  generationsRepo: GenerationsReader;
  clock: Clock;
  /** Expected embedding dimension (default {@link PLATFORM_EMBEDDING_DIMENSION} = 1024). */
  expectedDimension?: number;
};

/**
 * In-process, config_version-aware cache for the embedder runtime state with a LAZY-TTL refresh.
 * Implements the structural `EmbedderCache` the {@link PostgresConfluenceRetrieval} adapter consumes
 * (getRetrievalMode / getActiveGeneration) PLUS `getActiveModelName` for the dual-write.
 */
export class PostgresEmbedderCache {
  private readonly stateRepo: RuntimeStateReader;
  private readonly gensRepo: GenerationsReader;
  private readonly clock: Clock;
  private readonly expectedDimension: number;
  private snapshot: CachedState | null = null;

  public constructor(opts: PostgresEmbedderCacheOptions) {
    this.stateRepo = opts.runtimeStateRepo;
    this.gensRepo = opts.generationsRepo;
    this.clock = opts.clock;
    this.expectedDimension = opts.expectedDimension ?? PLATFORM_EMBEDDING_DIMENSION;
  }

  /**
   * Load the initial snapshot + validate the dimension invariant. Raises
   * {@link EmbeddingDimensionInvariantError} if the active generation's persisted dim disagrees with
   * the expected dim (or the row is missing).
   */
  public async start(): Promise<void> {
    const row = await this.stateRepo.get();
    await this.validateDimInvariant(row.active_generation);
    this.snapshot = {
      activeGeneration: row.active_generation,
      activeModelName: row.active_model_name,
      retrievalMode: row.retrieval_mode,
      configVersion: row.config_version,
      observedAtMonotonic: this.clock.monotonic(),
    };
  }

  // ── Reads (snapshot-based, lazy-TTL-refreshed) ─────────────────────────────────────────────────

  /** "fallback" (Phase A) or "generation_only" (Phase C). */
  public getRetrievalMode(): RetrievalMode {
    return this.current().retrievalMode;
  }

  /** Active embedding-generation id. */
  public getActiveGeneration(): number {
    return this.current().activeGeneration;
  }

  /** Active embedding model name (the dual-write's `embedding_model_name`). */
  public getActiveModelName(): string {
    return this.current().activeModelName;
  }

  // ── Internal ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Return the live snapshot for a sync read.
   *
   * The sync `get*()` reads serve the snapshot WITHOUT a DB round-trip (faithful to the Python's sync
   * `get_*`). The TTL refresh cannot happen in a sync method (it reads Postgres), so it is driven at the
   * async per-query / per-batch boundary via {@link tick}: the {@link search}-equivalent caller (the
   * confluence retrieval adapter; the dual-write activity) awaits `tick()` ONCE per query/batch before
   * the sync reads, so a stale snapshot is refreshed within one TTL of the next query — the same
   * ≤30s-staleness guarantee the Python's 15s poll gives. A sync read on a TTL-expired snapshot that was
   * never `tick()`-ed simply returns the last snapshot (bounded staleness, never a torn/throwing read).
   */
  private current(): CachedState {
    return this.requireSnapshot();
  }

  private requireSnapshot(): CachedState {
    if (this.snapshot === null) {
      throw new EmbedderCacheError("PostgresEmbedderCache.start() not called");
    }
    return this.snapshot;
  }

  /**
   * Re-read the runtime state when the TTL has elapsed; on a config_version change install a fresh
   * snapshot (re-validating the dim invariant). Returns nothing; the new snapshot is observable via the
   * sync reads. Idempotent within a TTL window (a no-op if the snapshot is still fresh).
   */
  private async refreshIfStale(): Promise<void> {
    const snap = this.requireSnapshot();
    const elapsed = this.clock.monotonic() - snap.observedAtMonotonic;
    if (elapsed < REFRESH_TTL_SECONDS) {
      return;
    }
    const row = await this.stateRepo.get();
    if (row.config_version === snap.configVersion) {
      // No change — just re-stamp the observation time so the TTL clock restarts (no dim re-check).
      this.snapshot = { ...snap, observedAtMonotonic: this.clock.monotonic() };
      return;
    }
    // config_version bumped — re-validate the dim invariant against the (possibly new) active generation.
    await this.validateDimInvariant(row.active_generation);
    this.snapshot = {
      activeGeneration: row.active_generation,
      activeModelName: row.active_model_name,
      retrievalMode: row.retrieval_mode,
      configVersion: row.config_version,
      observedAtMonotonic: this.clock.monotonic(),
    };
  }

  /**
   * Validate the active generation's persisted dimension equals the expected dim (default 1024).
   * Raises {@link EmbeddingDimensionInvariantError} on a mismatch or a missing generation row.
   */
  private async validateDimInvariant(activeGeneration: number): Promise<void> {
    const gen = await this.gensRepo.get(activeGeneration);
    if (gen === null) {
      throw new EmbeddingDimensionInvariantError(
        `active generation ${activeGeneration} has no embedding_generations row; ` +
          "cannot validate the platform embedding-dimension invariant",
      );
    }
    if (gen.embedding_dimension !== this.expectedDimension) {
      throw new EmbeddingDimensionInvariantError(
        `active generation ${activeGeneration} has embedding_dimension=${gen.embedding_dimension}; ` +
          `platform invariant requires ${this.expectedDimension}. ` +
          "See FOLLOW-UP-embedder-multi-dimension-support.",
      );
    }
  }

  /**
   * Drive a lazy-TTL refresh ahead of a read (the async entry point). The confluence retrieval adapter's
   * `search()` (and the dual-write activity) `await`s this ONCE per query/batch before the sync reads, so
   * the sync `get*()` returns a fresh snapshot within one TTL of a config_version bump; tests call it
   * directly. Public so the per-query boundary can refresh before serving. Same name as the structural
   * `refresh()` the adapter's optional seam expects (aliased below for the adapter contract).
   */
  public async tick(): Promise<void> {
    await this.refreshIfStale();
  }

  /**
   * Structural alias of {@link tick} matching the adapter's optional `refresh?(): Promise<void>` seam.
   * The {@link PostgresConfluenceRetrieval} adapter awaits `refresh()` (when present) at the top of
   * `search()`, so wiring the real cache drives the lazy-TTL refresh per query without the adapter
   * knowing about the concrete cache type.
   */
  public async refresh(): Promise<void> {
    await this.refreshIfStale();
  }
}

// ─── Lazily-memoized singleton over CODEMASTER_PG_CORE_DSN ────────────────────────────────────────
//
// Both wiring sites (the confluence retrieval adapter AND the confluence dual-write activity) MUST share
// the SAME started cache instance so they read one snapshot. The build is DSN-keyed + memoized (like the
// other repos): the first call over a DSN constructs + `start()`s the cache (which loads the snapshot +
// validates the dim invariant); subsequent calls over the same DSN return the same started instance.

/** Per-DSN memo of the in-flight / resolved started cache (one instance shared across wiring sites). */
const CACHE_BY_DSN = new Map<string, Promise<PostgresEmbedderCache>>();

/**
 * Build + `start()` (and memoize) ONE {@link PostgresEmbedderCache} over the shared ADR-0062 pool for
 * `dsn`. The cache is backed by {@link PostgresEmbedderRuntimeStateRepo} (the runtime-state singleton
 * reader) + {@link PostgresEmbeddingGenerationsRepo} (the dim-invariant check), both over the shared
 * `tenantKysely(dsn)` pool. The returned promise resolves AFTER `start()` completes (snapshot loaded +
 * dim invariant validated) — so a caller that awaits it is guaranteed a usable cache.
 *
 * Memoization keys on the DSN: the retrieval wiring + the dual-write wiring pass the SAME DSN, so they
 * receive the SAME started instance (the shared-singleton requirement).
 */
export async function buildEmbedderCacheForDsn(
  dsn: string,
  opts: { clock: Clock; expectedDimension?: number },
): Promise<PostgresEmbedderCache> {
  const existing = CACHE_BY_DSN.get(dsn);
  if (existing !== undefined) {
    return existing;
  }
  const built = (async (): Promise<PostgresEmbedderCache> => {
    const db = tenantKysely<unknown>(dsn);
    const cache = new PostgresEmbedderCache({
      runtimeStateRepo: new PostgresEmbedderRuntimeStateRepo({ db }),
      generationsRepo: new PostgresEmbeddingGenerationsRepo({ db }),
      clock: opts.clock,
      ...(opts.expectedDimension !== undefined ? { expectedDimension: opts.expectedDimension } : {}),
    });
    await cache.start();
    return cache;
  })();
  CACHE_BY_DSN.set(dsn, built);
  // If start() rejects (e.g. dim-invariant failure), drop the memo so a later call can retry.
  built.catch(() => CACHE_BY_DSN.delete(dsn));
  return built;
}

/** Test-only: clear the per-DSN cache memo so a fresh build re-reads the runtime state. */
export function _resetEmbedderCacheSingletonForTests(): void {
  CACHE_BY_DSN.clear();
}

// ─── Lazy EmbedderCache façade (deferred build for the worker composition root) ──────────────────
//
// `buildConfluencePort()` (sync, at worker boot) and the confluence dual-write wiring must NOT touch
// Postgres at construction (the deferred-Vault / lazy-pool posture the whole composition root uses). This
// façade defers the `buildEmbedderCacheForDsn` build (which `start()`s → reads the DB) to the FIRST
// `refresh()` — which the confluence retrieval adapter's `search()` always awaits before its sync reads.
// So the real cache is built + started the moment a confluence query actually fires, never at boot. Both
// the retrieval façade and the dual-write resolver share the SAME DSN-memoized singleton.

/** The structural `EmbedderCache` the {@link PostgresConfluenceRetrieval} adapter consumes (+ refresh). */
export type LazyEmbedderCacheFacade = {
  getRetrievalMode(): RetrievalMode;
  getActiveGeneration(): number;
  getActiveModelName(): string;
  refresh(): Promise<void>;
};

/**
 * A lazy {@link EmbedderCache} that builds + `start()`s the real DSN-memoized {@link PostgresEmbedderCache}
 * on first `refresh()` and delegates every read to it thereafter. The retrieval adapter awaits `refresh()`
 * at the top of `search()`, so the sync getters always run AFTER the build resolved (a getter called before
 * the first refresh throws — the adapter never does that). Construction is deferred to the first confluence
 * query, keeping worker boot off the DB.
 */
export function makeLazyEmbedderCache(
  dsn: string,
  opts: { clock: Clock; expectedDimension?: number },
): LazyEmbedderCacheFacade {
  let resolved: PostgresEmbedderCache | null = null;
  const buildOpts = {
    clock: opts.clock,
    ...(opts.expectedDimension !== undefined ? { expectedDimension: opts.expectedDimension } : {}),
  };
  const require_ = (): PostgresEmbedderCache => {
    if (resolved === null) {
      throw new EmbedderCacheError(
        "lazy EmbedderCache read before its first refresh() — the confluence adapter must await refresh() " +
          "before reading the snapshot",
      );
    }
    return resolved;
  };
  return {
    getRetrievalMode: () => require_().getRetrievalMode(),
    getActiveGeneration: () => require_().getActiveGeneration(),
    getActiveModelName: () => require_().getActiveModelName(),
    refresh: async () => {
      if (resolved === null) {
        resolved = await buildEmbedderCacheForDsn(dsn, buildOpts);
        return; // start() already loaded a fresh snapshot — no extra tick needed this call.
      }
      await resolved.refresh();
    },
  };
}
