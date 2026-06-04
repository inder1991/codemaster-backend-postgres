/**
 * The ADR-0062 single-engine seam — ONE `pg.Pool` per DSN across the whole process.
 *
 * ## Why this module exists
 *
 * Before ADR-0062 every repo memoized its OWN `pg.Pool` (e.g.
 * `review_findings_repo.ts::tenantKyselyForDsn`, `review_walkthroughs_repo.ts`, …). With N repo
 * types each opening a pool of `max` connections against the same DSN, a single worker fanned out to
 * `N × max` connections. On the kind cluster's ~100-connection budget that exhausts Postgres on a
 * rolling deploy — the `TooManyConnectionsError` 500s documented in the ADR-0062 memory note.
 *
 * The fix is structural, not a detection layer (per the "eliminate over detect" principle): there is
 * exactly ONE pool per DSN, owned by the module-level {@link POOLS} Map, and EVERY repo — regardless
 * of its typed schema — shares it via {@link getPool} / {@link tenantKysely}. A Kysely instance is a
 * lightweight query-builder wrapper over the pool it is handed; it does NOT open its own connections,
 * so building many `Kysely<T>` instances for different schemas over the SAME pool costs nothing at
 * the connection level. That is the whole point: the POOL is the scarce resource and it is the
 * singleton; the typed Kysely wrappers are cheap.
 *
 * ## Contract for repos (ADR-0062)
 *
 * Repos MUST NOT construct their own `pg.Pool` or `new Kysely(...)`. They call {@link tenantKysely}
 * with their typed schema `T` and receive a `Kysely<T>` over the shared pool with the
 * {@link TenancyPlugin} installed. The DI-friendly repos that accept an injected `Kysely` should be
 * handed the result of {@link tenantKysely}; the lazy-fallback repos that read
 * `CODEMASTER_PG_CORE_DSN` should call {@link tenantKysely} instead of `new Pool(...)`.
 *
 * ## Lifecycle
 *
 * {@link disposePool} / {@link disposeAllPools} end the pool(s) and clear the maps — for test
 * teardown (so a `vitest` run does not leak open sockets) and worker/API shutdown. Because a Kysely
 * built here shares the pool, ending the pool also tears down the Kysely's connection source; we drop
 * the memoized Kysely in lockstep so a subsequent {@link tenantKysely} for the same DSN rebuilds over
 * a fresh pool rather than handing back a Kysely whose pool was ended.
 */

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";

/** Default per-pool connection cap. Small on purpose: ONE pool per DSN now, not N. */
const DEFAULT_POOL_MAX = 8;

/**
 * The ADR-0062 singleton: DSN -> the one `pg.Pool` for that DSN. Module-level so it is shared across
 * every importer in the process. Never reassigned — entries are added by {@link getPool} and removed
 * by {@link disposePool} / {@link disposeAllPools}.
 */
const POOLS = new Map<string, Pool>();

/**
 * DSN -> the memoized tenant-scoped Kysely over the shared pool. A second cache so repeated
 * {@link tenantKysely} calls for the same DSN reuse one builder; the connection-sharing invariant is
 * carried by {@link POOLS}, this map is the cheap "don't rebuild the wrapper" optimization.
 *
 * Typed as `Kysely<unknown>` because the cache is keyed by DSN, not by schema — a single pool serves
 * every typed schema in the process. {@link tenantKysely} re-narrows to the caller's `T` on return;
 * this is sound because the Kysely is a compile-time-only typing over the runtime-untyped pool.
 */
const KYSELYS = new Map<string, Kysely<unknown>>();

/**
 * Return THE process-wide `pg.Pool` for `dsn`, creating it on first use and memoizing it forever
 * after (until {@link disposePool} / {@link disposeAllPools}). Subsequent calls with the same `dsn`
 * return the SAME instance — this identity is the ADR-0062 invariant.
 *
 * The pool is lazy: `pg.Pool` does not open a socket until the first query, so constructing it for an
 * unreachable DSN is free (the unit tests rely on this).
 *
 * `opts.max` is honored only on the call that actually creates the pool; once memoized the existing
 * pool is returned as-is (you cannot resize a live pool through this seam).
 */
export function getPool(dsn: string, opts: { max?: number } = {}): Pool {
  const existing = POOLS.get(dsn);
  if (existing !== undefined) {
    return existing;
  }
  const pool = new Pool({ connectionString: dsn, max: opts.max ?? DEFAULT_POOL_MAX });
  POOLS.set(dsn, pool);
  return pool;
}

/**
 * Build (or return the memoized) tenant-scoped `Kysely<T>` for `dsn`, over the SHARED pool from
 * {@link getPool} with the {@link TenancyPlugin} installed. Repos call this with their typed schema.
 *
 * The Kysely does NOT open its own connections — it is a query-builder over the one pool — so binding
 * many typed schemas to the same DSN does not multiply connections. The memoization keeps it cheap;
 * the pool sharing is the invariant that prevents connection exhaustion.
 */
export function tenantKysely<T>(dsn: string): Kysely<T> {
  const cached = KYSELYS.get(dsn);
  if (cached !== undefined) {
    return cached as Kysely<T>;
  }
  const db = new Kysely<T>({
    dialect: new PostgresDialect({ pool: getPool(dsn) }),
    plugins: [new TenancyPlugin()],
  });
  KYSELYS.set(dsn, db as Kysely<unknown>);
  return db;
}

/**
 * End the pool for `dsn` (closing its connections) and drop both memoized entries, so a later
 * {@link getPool} / {@link tenantKysely} for the same DSN rebuilds from scratch. No-op when the DSN
 * was never opened.
 *
 * The cached Kysely shares this pool, so we destroy it first (which is a no-op on its own connection
 * source once the pool is ended) and then end the pool — dropping the Kysely entry guarantees the
 * next {@link tenantKysely} does not hand back a builder whose pool has been ended.
 */
export async function disposePool(dsn: string): Promise<void> {
  const db = KYSELYS.get(dsn);
  KYSELYS.delete(dsn);
  if (db !== undefined) {
    await db.destroy();
  }
  const pool = POOLS.get(dsn);
  POOLS.delete(dsn);
  if (pool !== undefined && db === undefined) {
    // No Kysely owned this pool, so destroy() above did not end it — end it directly.
    await pool.end();
  }
}

/** End every memoized pool and clear both maps (test teardown / process shutdown). */
export async function disposeAllPools(): Promise<void> {
  const dsns = [...POOLS.keys()];
  await Promise.all(dsns.map(async (dsn) => disposePool(dsn)));
}
