/**
 * Repo for `core.review_walkthroughs` (review-detail P3). Persists the structured `WalkthroughV1` per
 * review so the review-detail page can render the bot's TL;DR + per-file table.
 *
 * Public surface:
 *   - `upsert({ reviewId, installationId, walkthrough })` → `INSERT … ON CONFLICT (review_id) DO UPDATE`.
 *   - `get({ reviewId, installationId })` → tenant-scoped read; `null` when absent / in a different tenant.
 *
 * IDIOMS:
 *   - JSONB WRITE: the `WalkthroughV1` is serialised to a compact JSON string and bound as TEXT with
 *     an explicit `CAST(:walkthrough AS jsonb)`.
 *   - JSONB READ: the column is cast `walkthrough::text` in the SELECT so we reparse it through Zod
 *     (`WalkthroughV1.parse(JSON.parse(...))`) rather than trusting the `pg` driver's auto-deserialised
 *     object — the parse re-applies the contract.
 *   - TENANCY: every read carries the `installation_id` equality predicate to satisfy the GF-3
 *     raw-SQL tenancy AST gate. The Kysely instance installs the {@link TenancyPlugin}
 *     (defense-in-depth; see TENANCY NOTE below).
 *   - There are NO vector columns and NO wall-clock/random in this repo: `created_at`/`updated_at`
 *     default to the server-side SQL `now()` and the conflict branch sets `updated_at = now()` in SQL,
 *     so the #platform clock/random seams are not needed (and the check_clock_random gate is a no-op
 *     here).
 *
 * TENANCY NOTE: `core.review_walkthroughs` is NOT in the tenant-scoped registry and is absent from
 * the {@link TENANT_SCOPED_TABLES} registry — which is why the runtime
 * `TenancyPlugin` does not hard-refuse a query that omits `installation_id` on THIS table. We still
 * (a) get a plugin-installed Kysely from {@link tenantKysely}, and (b) pass the `installation_id`
 * equality predicate on the `get` read, exactly as the Python repo does — so the moment the table is
 * added to the registry, enforcement is already in place.
 *
 * ADR-0062: this repo NO LONGER owns a `pg.Pool`, constructs a `new Kysely(...)`, or memoizes either.
 * It is handed a `Kysely<ReviewWalkthroughsDB>` over the process-wide single pool from
 * {@link tenantKysely} (`#platform/db/database.js`) — the structural fix that replaces the old
 * per-DSN `MEMOIZED` Pool+Kysely cache so a worker no longer fans out to `N × max` connections.
 * {@link ReviewWalkthroughsRepo.fromDsn} is the default entry point; it routes through
 * {@link tenantKysely} so every repo over the same DSN shares ONE pool. Tests / composition roots
 * that already hold a `Kysely` inject it directly via the constructor. Pool teardown is the shared
 * `disposeAllPools` / `disposePool` seam, NOT a per-repo close — a Kysely from {@link tenantKysely}
 * must NOT be `destroy()`-ed by a repo, because that would end the shared pool out from under every
 * other repo bound to the same DSN.
 */

import { type Kysely, sql } from "kysely";

import { tenantKysely } from "#platform/db/database.js";

import { WalkthroughV1 } from "#contracts/walkthrough.v1.js";

// ─── Read projection ──────────────────────────────────────────────────────────────────────────────

/** Read projection of one `core.review_walkthroughs` row. */
export type ReviewWalkthroughRow = {
  readonly review_id: string;
  readonly installation_id: string;
  readonly walkthrough: WalkthroughV1;
};

// ─── Kysely table typing for core.review_walkthroughs ────────────────────────────────────────────

/**
 * The raw shape of the one row the `get` SELECT returns. `walkthrough` is `::text`-cast in SQL, so it
 * arrives as a JSON STRING (not a `pg`-auto-deserialised object) — we reparse it through Zod.
 */
type RawWalkthroughRow = {
  readonly review_id: string;
  readonly installation_id: string;
  readonly walkthrough: string;
};

/** Minimal Kysely table typing for `core.review_walkthroughs` (the only table this repo touches). */
type ReviewWalkthroughsTable = {
  review_id: string;
  installation_id: string;
  walkthrough: string;
  created_at: Date;
  updated_at: Date;
};

/** The Kysely schema for this repo — schema-qualified table key so the TenancyPlugin can resolve it. */
type ReviewWalkthroughsDB = {
  "core.review_walkthroughs": ReviewWalkthroughsTable;
};

// ─── Repo ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Upsert + read the per-review structured walkthrough.
 *
 * ADR-0062: the injected `Kysely<ReviewWalkthroughsDB>` is the tenant-scoped, shared-pool instance
 * from {@link tenantKysely}. This repo owns NO pool and NO Kysely cache — many instances over the same
 * DSN share the ONE process-wide pool. The `TenancyPlugin` is already installed by {@link tenantKysely};
 * do NOT re-install it here.
 */
export class ReviewWalkthroughsRepo {
  // The injected, shared-pool Kysely (ADR-0062). NOT owned by this repo — never `destroy()`-ed here.
  readonly #db: Kysely<ReviewWalkthroughsDB>;

  /**
   * Construct from an injected `Kysely<ReviewWalkthroughsDB>` — the tenant-scoped, shared-pool instance
   * from {@link tenantKysely}. Tests / composition roots that already hold a `Kysely` inject it here.
   */
  public constructor(args: { db: Kysely<ReviewWalkthroughsDB> }) {
    this.#db = args.db;
  }

  /**
   * Default entry point (ADR-0062): build a repo over the process-wide single pool for `dsn` via
   * {@link tenantKysely}. Every repo over the same DSN shares ONE pool — no per-repo pool cache.
   */
  public static fromDsn(dsn: string): ReviewWalkthroughsRepo {
    return new ReviewWalkthroughsRepo({ db: tenantKysely<ReviewWalkthroughsDB>(dsn) });
  }

  /**
   * Insert-or-update the review's walkthrough, keyed by `review_id`. JSONB written via a TEXT bind +
   * `CAST(… AS jsonb)`; the conflict branch refreshes `installation_id`, `walkthrough`, and
   * `updated_at = now()`.
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
   * (re-applies the contract).
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
