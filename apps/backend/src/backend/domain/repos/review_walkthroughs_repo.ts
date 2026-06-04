/**
 * Repo for `core.review_walkthroughs` (review-detail P3).
 *
 * 1:1 TypeScript/Kysely port of the frozen Python source
 * `vendor/codemaster-py/codemaster/domain/repos/review_walkthroughs_repo.py`. Persists the structured
 * `WalkthroughV1` per review so the review-detail page can render the bot's TL;DR + per-file table.
 *
 * Public surface (method-for-method with the Python `ReviewWalkthroughsRepo`):
 *   - `upsert({ reviewId, installationId, walkthrough })` → `INSERT … ON CONFLICT (review_id) DO UPDATE`.
 *   - `get({ reviewId, installationId })` → tenant-scoped read; `null` when absent / in a different tenant.
 *
 * IDIOMS preserved from the frozen Python:
 *   - JSONB WRITE: the `WalkthroughV1` is serialised to a compact JSON string and bound as TEXT with an
 *     explicit `CAST(:walkthrough AS jsonb)` (Python: `walkthrough.model_dump_json()` +
 *     `CAST(:walkthrough AS jsonb)`).
 *   - JSONB READ: the column is cast `walkthrough::text` in the SELECT so we reparse it through Zod
 *     (`WalkthroughV1.parse(JSON.parse(...))`) rather than trusting the `pg` driver's auto-deserialised
 *     object — byte-faithful, and the parse re-applies the contract (Python: `walkthrough::text` +
 *     `WalkthroughV1.model_validate_json(...)`; asyncpg/`pg` return a `dict`/object otherwise).
 *   - TENANCY: every read carries the `installation_id` equality predicate (Python carries the
 *     `installation_id` token in its raw SQL to satisfy the GF-3 raw-SQL tenancy AST gate). The Kysely
 *     instance installs the {@link TenancyPlugin} (defense-in-depth; see TENANCY NOTE below).
 *   - There are NO vector columns and NO wall-clock/random in this repo: `created_at`/`updated_at`
 *     default to the server-side SQL `now()` and the conflict branch sets `updated_at = now()` in SQL,
 *     so the #platform clock/random seams are not needed (and the check_clock_random gate is a no-op
 *     here).
 *
 * TENANCY NOTE (parity-faithful): `core.review_walkthroughs` is NOT in the frozen Python tenant-scoped
 * registry (`scripts/check_tenant_scoped_raw_sql.py`) and is NOT a `TenantScoped` ORM model, so it is
 * absent from the ported {@link TENANT_SCOPED_TABLES} registry — which is why the runtime
 * {@link TenancyPlugin} does not hard-refuse a query that omits `installation_id` on THIS table. We
 * still (a) install the plugin on this repo's Kysely instance, and (b) pass the `installation_id`
 * equality predicate on the `get` read, exactly as the Python repo does — so the moment the table is
 * added to the registry, enforcement is already in place. We deliberately do NOT mutate the
 * verbatim-ported registry here (that is a cross-cutting change outside this repo's scope).
 *
 * ADR-0062: the `pg.Pool` and the `Kysely` instance are MEMOIZED at module scope — one per process,
 * never one per call. Call {@link closeReviewWalkthroughsDb} on shutdown (and from integration-test
 * `afterAll`) to drain the pool.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";

import { WalkthroughV1 } from "#contracts/walkthrough.v1.js";

// ─── Read projection (1:1 with the Python `ReviewWalkthroughRow`) ────────────────────────────────

/** Read projection of one `core.review_walkthroughs` row. */
export type ReviewWalkthroughRow = {
  readonly review_id: string;
  readonly installation_id: string;
  readonly walkthrough: WalkthroughV1;
};

// ─── Memoized Pool + Kysely (ADR-0062 — one per process, never per call) ─────────────────────────

/**
 * The raw shape of the one row the `get` SELECT returns. `walkthrough` is `::text`-cast in SQL, so it
 * arrives as a JSON STRING (not a `pg`-auto-deserialised object) — we reparse it through Zod.
 */
type RawWalkthroughRow = {
  readonly review_id: string;
  readonly installation_id: string;
  readonly walkthrough: string;
};

/** Memoized `{ pool, db }` keyed by DSN. One Kysely (with TenancyPlugin) + one Pool per DSN. */
const MEMOIZED = new Map<string, { pool: Pool; db: Kysely<unknown> }>();

function getDb(dsn: string): { pool: Pool; db: Kysely<unknown> } {
  const existing = MEMOIZED.get(dsn);
  if (existing !== undefined) {
    return existing;
  }
  const pool = new Pool({ connectionString: dsn, max: 8 });
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool }),
    // Install the tenancy plugin so installation_id scoping is enforced on any registered scoped table
    // this repo's Kysely instance touches (defense-in-depth; see the TENANCY NOTE in the module header).
    plugins: [new TenancyPlugin()],
  });
  const entry = { pool, db };
  MEMOIZED.set(dsn, entry);
  return entry;
}

/**
 * Drains every memoized pool and forgets the memoized Kysely instances. Call on process shutdown and
 * from integration-test `afterAll`. Idempotent.
 */
export async function closeReviewWalkthroughsDb(): Promise<void> {
  const entries = [...MEMOIZED.values()];
  MEMOIZED.clear();
  await Promise.all(entries.map(async (e) => e.db.destroy()));
}

// ─── Repo ────────────────────────────────────────────────────────────────────────────────────────

/** Upsert + read the per-review structured walkthrough. */
export class ReviewWalkthroughsRepo {
  readonly #db: Kysely<unknown>;

  /**
   * @param args.dsn  Postgres DSN for the memoized Pool + Kysely (ADR-0062). The Pool/Kysely are
   *   shared across every `ReviewWalkthroughsRepo` constructed with the same DSN.
   */
  public constructor(args: { dsn: string }) {
    this.#db = getDb(args.dsn).db;
  }

  /**
   * Insert-or-update the review's walkthrough, keyed by `review_id`. JSONB written via a TEXT bind +
   * `CAST(… AS jsonb)`; the conflict branch refreshes `installation_id`, `walkthrough`, and
   * `updated_at = now()` — verbatim with the Python `ON CONFLICT (review_id) DO UPDATE`.
   */
  public async upsert(args: {
    reviewId: string;
    installationId: string;
    walkthrough: WalkthroughV1;
  }): Promise<void> {
    // Re-validate through the contract, then serialise to the compact canonical JSON string (the
    // analogue of Python's `walkthrough.model_dump_json()`).
    const walkthroughJson = JSON.stringify(WalkthroughV1.parse(args.walkthrough));
    await sql`
      INSERT INTO core.review_walkthroughs
          (review_id, installation_id, walkthrough)
      VALUES
          (${args.reviewId}, ${args.installationId}, CAST(${walkthroughJson} AS jsonb))
      ON CONFLICT (review_id) DO UPDATE SET
          installation_id = EXCLUDED.installation_id,
          walkthrough     = EXCLUDED.walkthrough,
          updated_at      = now()
    `.execute(this.#db);
  }

  /**
   * Read the walkthrough for a review, scoped to its tenant. Returns `null` when absent or owned by a
   * different tenant. The JSONB column is cast to text so the JSON string reparses through Zod
   * (byte-faithful; re-applies the contract) — the analogue of Python's `walkthrough::text` +
   * `WalkthroughV1.model_validate_json(...)`.
   */
  public async get(args: {
    reviewId: string;
    installationId: string;
  }): Promise<ReviewWalkthroughRow | null> {
    const result = await sql<RawWalkthroughRow>`
      SELECT review_id, installation_id,
             walkthrough::text AS walkthrough
      FROM core.review_walkthroughs
      WHERE review_id = ${args.reviewId}
        AND installation_id = ${args.installationId}
    `.execute(this.#db);

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      review_id: row.review_id,
      installation_id: row.installation_id,
      walkthrough: WalkthroughV1.parse(JSON.parse(row.walkthrough)),
    };
  }

  // ── Test-only helpers (NOT part of the Python public surface) ──
  // The Python repo has no delete/count; these exist solely so the integration test can clean up its
  // own rows and assert idempotency. They operate by the `review_id` primary key (the row's own
  // identity), so they need no tenant predicate.

  /** TEST-ONLY: delete the walkthrough row for a review_id (PK cleanup). */
  public async deleteForTest(args: { reviewId: string }): Promise<void> {
    await sql`DELETE FROM core.review_walkthroughs WHERE review_id = ${args.reviewId}`.execute(
      this.#db,
    );
  }

  /** TEST-ONLY: count the walkthrough rows for a review_id (idempotency assertion). */
  public async countForTest(args: { reviewId: string }): Promise<number> {
    const result = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM core.review_walkthroughs WHERE review_id = ${args.reviewId}
    `.execute(this.#db);
    return Number(result.rows[0]?.n ?? "0");
  }
}
