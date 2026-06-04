/**
 * Repo for `core.fix_prompts` (fix-prompt feature) — a 1:1 Kysely port of the frozen Python
 * `vendor/codemaster-py/codemaster/domain/repos/fix_prompt_repo.py::FixPromptRepo`.
 *
 * Idempotent upsert keyed by `review_id` (replay/retry-safe) + tenancy-scoped read. Mirrors the
 * Python repo method-for-method:
 *   - persist(record, { installationId })        → INSERT … ON CONFLICT (review_id) DO UPDATE …
 *   - getByReviewId(reviewId, { installationId }) → SELECT … WHERE review_id = :r AND installation_id = :i
 *
 * Tenancy: every statement carries `installation_id`. The read goes through the Kysely query builder
 * with an explicit `.where("installation_id", "=", …)` predicate, so the {@link TenancyPlugin}
 * (installed on this repo's Kysely instance) enforces the GF-3 invariant at query-build time — the
 * structural analogue of the Python GF-3 raw-SQL tenancy AST gate. The upsert is an INSERT (out of
 * the plugin's SELECT/UPDATE/DELETE scope, exactly as in the Python hook) but still binds
 * `installation_id` as a column value.
 *
 * ADR-0062 (Postgres connection-pool lifecycle): the pg Pool and the Kysely instance are memoized —
 * created ONCE per repo instance, never per call. The pool is injected (constructor injection) so a
 * single pool can back many repos. {@link FixPromptRepo.close} disposes the Kysely wrapper via
 * `destroy()`, which ends the injected pool (Kysely owns the pool handed to its dialect) — call it
 * exactly once at shutdown, never per request.
 *
 * Datetime fidelity: `generated_at` is read back via `to_char(… AT TIME ZONE 'UTC', …)` so the
 * `timestamptz` round-trips as a canonical microsecond-precision `Z`-suffixed RFC3339 string
 * (pg's default `Date` mapping is millisecond-only and would silently truncate the Python
 * microsecond instant — the [[empirical_verification_before_architectural_claims]] trap).
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import type { Pool } from "pg";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";

import { FixPromptV1 } from "#contracts/fix_prompt.v1.js";

/** The single column row of `core.fix_prompts` as Kysely sees it (read path only). */
type FixPromptsTable = {
  review_id: string;
  installation_id: string;
  prompt: string;
  generation_mode: string;
  finding_count: number;
  truncated: boolean;
  // Read as a canonical `…Z` microsecond string via the to_char projection below; the column type is
  // timestamptz, but the typed select projects a string alias, so we never touch the raw Date mapping.
  generated_at: string;
};

/** Minimal DB schema the repo's Kysely instance is typed against. */
type FixPromptDb = {
  "core.fix_prompts": FixPromptsTable;
};

/** Tenant-scope token threaded through every public method (the Python `installation_id` kwarg). */
export type TenantScope = {
  readonly installationId: string;
};

export class FixPromptRepo {
  // Memoized per ADR-0062 — one Kysely instance (wrapping the injected, caller-owned pool) for the
  // repo's lifetime; never re-created per call.
  private readonly db: Kysely<FixPromptDb>;

  constructor(args: { pool: Pool }) {
    this.db = new Kysely<FixPromptDb>({
      dialect: new PostgresDialect({ pool: args.pool }),
      plugins: [new TenancyPlugin()],
    });
  }

  /**
   * Insert-or-update the review's fix-prompt, keyed by `review_id`. Idempotent under retry/replay:
   * a second persist with the same `review_id` UPDATEs every column in place (ON CONFLICT DO UPDATE),
   * mirroring the Python statement byte-for-byte.
   */
  async persist(record: FixPromptV1, scope: TenantScope): Promise<void> {
    await sql`
      INSERT INTO core.fix_prompts
          (review_id, installation_id, prompt, generation_mode,
           finding_count, truncated, generated_at)
      VALUES
          (${record.review_id}, ${scope.installationId}, ${record.prompt}, ${record.generation_mode},
           ${record.finding_count}, ${record.truncated}, ${record.generated_at}::timestamptz)
      ON CONFLICT (review_id) DO UPDATE SET
          installation_id = EXCLUDED.installation_id,
          prompt          = EXCLUDED.prompt,
          generation_mode = EXCLUDED.generation_mode,
          finding_count   = EXCLUDED.finding_count,
          truncated       = EXCLUDED.truncated,
          generated_at    = EXCLUDED.generated_at
    `.execute(this.db);
  }

  /**
   * Read the fix-prompt for a review, scoped to its tenant. Returns `null` when absent or owned by a
   * different tenant. The `.where("installation_id", …)` predicate satisfies the TenancyPlugin and
   * is the exact analogue of the Python `WHERE … AND installation_id = :installation_id`.
   */
  async getByReviewId(reviewId: string, scope: TenantScope): Promise<FixPromptV1 | null> {
    const row = await this.db
      .selectFrom("core.fix_prompts")
      .select([
        "review_id",
        "prompt",
        "generation_mode",
        "finding_count",
        "truncated",
        // Project the timestamptz as a canonical microsecond-precision `…Z` RFC3339 string so the
        // round-trip is byte-faithful to the contract's `generated_at` form (NOT the lossy Date map).
        sql<string>`to_char(generated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          "generated_at",
        ),
      ])
      .where("review_id", "=", reviewId)
      .where("installation_id", "=", scope.installationId)
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }

    return FixPromptV1.parse({
      review_id: row.review_id,
      prompt: row.prompt,
      generation_mode: row.generation_mode,
      finding_count: row.finding_count,
      truncated: row.truncated,
      generated_at: row.generated_at,
    });
  }

  /**
   * Dispose the Kysely wrapper (and, transitively, the injected pool Kysely owns). Call once at
   * shutdown — never per request (ADR-0062).
   */
  async close(): Promise<void> {
    await this.db.destroy();
  }
}
