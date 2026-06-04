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
 * `TenancyPlugin` (defense-in-depth, invariant #10) — a no-op AST pass for raw `sql` templates, but it
 * guards any future ORM-builder query this repo grows; it is installed centrally by {@link tenantKysely}.
 *
 * ADR-0062: this repo NO LONGER owns a `pg.Pool`, constructs a `new Kysely(...)`, or memoizes either.
 * It is handed a `Kysely<DB>` over the process-wide single pool from {@link tenantKysely}
 * (`#platform/db/database.js`) — the structural fix that replaces the old per-DSN `POOL_CACHE` +
 * `KYSELY_CACHE` Maps so a worker no longer fans out to `N × max` connections.
 * {@link ReviewPolicyBundlesRepo.fromDsn} is the default entry point; it routes through
 * {@link tenantKysely} so every repo over the same DSN shares ONE pool. Tests / composition roots that
 * already hold a `Kysely` inject it directly via the constructor. Pool teardown is the shared
 * `disposeAllPools` / `disposePool` seam, NOT a per-repo close.
 */

import { type Kysely, sql } from "kysely";

import { ResolvedGuidanceBundleV1 } from "#contracts/resolved_guidance.v1.js";

import { tenantKysely } from "#platform/db/database.js";

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

/**
 * Implements the per-review applied-policy-bundle persistence against `core.review_policy_bundles`.
 *
 * ADR-0062: the injected `Kysely<DB>` is the tenant-scoped, shared-pool instance from
 * {@link tenantKysely}. This repo owns NO pool and NO Kysely cache — many instances over the same DSN
 * share the ONE process-wide pool. The `TenancyPlugin` is already installed by {@link tenantKysely};
 * do NOT re-install it here.
 */
export class ReviewPolicyBundlesRepo {
  // The injected, shared-pool Kysely (ADR-0062). NOT owned by this repo — never `destroy()`-ed here.
  readonly #db: Kysely<DB>;

  /**
   * Construct from an injected `Kysely<DB>` — the tenant-scoped, shared-pool instance from
   * {@link tenantKysely}. Tests / composition roots that already hold a `Kysely` inject it here.
   */
  constructor(args: { db: Kysely<DB> }) {
    this.#db = args.db;
  }

  /**
   * Default entry point (ADR-0062): build a repo over the process-wide single pool for `dsn` via
   * {@link tenantKysely}. Every repo over the same DSN shares ONE pool — no per-repo pool cache.
   */
  static fromDsn(dsn: string): ReviewPolicyBundlesRepo {
    return new ReviewPolicyBundlesRepo({ db: tenantKysely<DB>(dsn) });
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
