/**
 * Repo for `core.review_policy_bundles` (review-detail P0-B).
 *
 * 1:1 TypeScript/Kysely port of the frozen Python repo
 * `vendor/codemaster-py/codemaster/domain/repos/review_policy_bundles_repo.py`. Persists the
 * per-review merged {@link ResolvedGuidanceBundleV1} (the output of
 * `codemaster.policy.citation_context_builder.merge_per_chunk_bundles`) so the review-detail
 * governance scorecard can show rules that APPLIED AND PASSED, not only rules that became findings.
 *
 * SQL semantics preserved verbatim from the Python source:
 *  - `upsert` issues `INSERT ... ON CONFLICT (review_id) DO UPDATE SET ... updated_at = now()`;
 *    the bundle is bound as a JSON string and inserted through `CAST(:x AS jsonb)` (write idiom —
 *    asyncpg/pg pass a `text` literal that Postgres parses into `jsonb`).
 *  - `get` reads `applied_bundle::text` (read-cast idiom) so the driver hands back a JSON STRING we
 *    reparse through the contract — never a pre-deserialized object whose key order / number shape
 *    could drift from the canonical contract serialization.
 *  - `rule_count = len(bundle.applicable_rules)` — derived, never trusted from the caller.
 *
 * Tenancy: every read statement carries the `installation_id` token in the SQL and is keyed by it,
 * matching the frozen Python repo (GF-3 raw-SQL tenancy discipline). The Kysely instance installs
 * {@link TenancyPlugin} (defense-in-depth, invariant #10) — a no-op AST pass for raw `sql` templates,
 * but it guards any future ORM-builder query this repo grows.
 *
 * Lifecycle (ADR-0062): the pg {@link Pool} and {@link Kysely} instance are memoized per DSN — NEVER
 * constructed per call. Construct the repo with an explicit `pool` (tests, DI) or let it lazily
 * memoize one from `CODEMASTER_PG_CORE_DSN`.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { ResolvedGuidanceBundleV1 } from "#contracts/resolved_guidance.v1.js";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";

/** Minimal Kysely database schema for this repo's single table. */
type ReviewPolicyBundlesTable = {
  review_id: string;
  installation_id: string;
  applied_bundle: string;
  rule_count: number;
  created_at: Date;
  updated_at: Date;
};

type DB = {
  "core.review_policy_bundles": ReviewPolicyBundlesTable;
};

/** Read projection of one `core.review_policy_bundles` row (the Python `ReviewPolicyBundleRow`). */
export type ReviewPolicyBundleRow = {
  readonly review_id: string;
  readonly installation_id: string;
  readonly rule_count: number;
  readonly bundle: ResolvedGuidanceBundleV1;
};

/** Shape of the `applied_bundle::text` read row before reparsing the JSON string into the contract. */
type AppliedBundleReadRow = {
  review_id: string;
  installation_id: string;
  applied_bundle: string;
  rule_count: number;
};

// ── Memoized pool + Kysely instance (ADR-0062) ──────────────────────────────────────────────────
//
// One Pool + one Kysely per process per DSN — building a Pool per call exhausts Postgres connections
// (the TooManyConnectionsError class the ADR exists to prevent). The cache is keyed by DSN so a test
// pointing at the disposable PG and production pointing at the cluster never share an instance.

const POOL_CACHE = new Map<string, Pool>();
const KYSELY_CACHE = new Map<string, Kysely<DB>>();

/** Memoized {@link Pool} for `dsn`. */
function poolFor(dsn: string): Pool {
  const existing = POOL_CACHE.get(dsn);
  if (existing !== undefined) {
    return existing;
  }
  const pool = new Pool({ connectionString: dsn });
  POOL_CACHE.set(dsn, pool);
  return pool;
}

/** Memoized {@link Kysely} instance (TenancyPlugin installed) over the memoized pool for `dsn`. */
function kyselyForDsn(dsn: string): Kysely<DB> {
  const existing = KYSELY_CACHE.get(dsn);
  if (existing !== undefined) {
    return existing;
  }
  const db = kyselyOver(poolFor(dsn));
  KYSELY_CACHE.set(dsn, db);
  return db;
}

/** Build a {@link Kysely} over an existing {@link Pool} with the tenancy plugin installed. */
function kyselyOver(pool: Pool): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new TenancyPlugin()],
  });
}

export class ReviewPolicyBundlesRepo {
  readonly #db: Kysely<DB>;

  /**
   * Construct the repo.
   *
   * @param args.db   An explicit (memoized) Kysely instance — preferred for DI / tests.
   * @param args.pool An explicit (memoized) pg Pool — a Kysely is wrapped over it with the tenancy
   *                  plugin installed. Use this when the caller owns the pool lifecycle (tests).
   *
   * With neither, the repo lazily memoizes a pool + Kysely from `CODEMASTER_PG_CORE_DSN`.
   */
  constructor(args: { db?: Kysely<DB>; pool?: Pool } = {}) {
    if (args.db !== undefined) {
      this.#db = args.db;
      return;
    }
    if (args.pool !== undefined) {
      this.#db = kyselyOver(args.pool);
      return;
    }
    const dsn = process.env["CODEMASTER_PG_CORE_DSN"];
    if (dsn === undefined || dsn.length === 0) {
      throw new Error(
        "ReviewPolicyBundlesRepo: no Kysely/pool supplied and CODEMASTER_PG_CORE_DSN is unset",
      );
    }
    this.#db = kyselyForDsn(dsn);
  }

  /**
   * Insert-or-update the review's applied policy bundle.
   *
   * Re-runs of the same review (synchronize / manual rerun) overwrite the prior bundle, keyed by
   * `review_id` (the table's primary key). `rule_count` is derived from the bundle, never the caller.
   */
  async upsert(args: {
    review_id: string;
    installation_id: string;
    bundle: ResolvedGuidanceBundleV1;
  }): Promise<void> {
    // Canonicalize through the contract so the persisted JSON matches Pydantic's `model_dump_json`
    // (the Python source binds `bundle.model_dump_json()`). `.parse` applies defaults + rejects junk.
    const validated = ResolvedGuidanceBundleV1.parse(args.bundle);
    const ruleCount = validated.applicable_rules.length;
    const appliedBundleJson = JSON.stringify(validated);

    await sql`
      INSERT INTO core.review_policy_bundles
          (review_id, installation_id, applied_bundle, rule_count)
      VALUES
          (${args.review_id}, ${args.installation_id},
           CAST(${appliedBundleJson} AS jsonb), ${ruleCount})
      ON CONFLICT (review_id) DO UPDATE SET
          installation_id = EXCLUDED.installation_id,
          applied_bundle  = EXCLUDED.applied_bundle,
          rule_count      = EXCLUDED.rule_count,
          updated_at      = now()
    `.execute(this.#db);
  }

  /**
   * Read the applied bundle for a review, scoped to its tenant.
   *
   * Returns `null` when absent or in a different tenant. The JSONB is cast back to text so the
   * contract reparses it (the driver otherwise hands back a deserialized object whose shape could
   * drift from the canonical contract serialization).
   */
  async get(args: {
    review_id: string;
    installation_id: string;
  }): Promise<ReviewPolicyBundleRow | null> {
    const result = await sql<AppliedBundleReadRow>`
      SELECT review_id,
             installation_id,
             applied_bundle::text AS applied_bundle,
             rule_count
      FROM core.review_policy_bundles
      WHERE review_id = ${args.review_id}
        AND installation_id = ${args.installation_id}
    `.execute(this.#db);

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      review_id: row.review_id,
      installation_id: row.installation_id,
      rule_count: row.rule_count,
      bundle: ResolvedGuidanceBundleV1.parse(JSON.parse(row.applied_bundle)),
    };
  }
}
