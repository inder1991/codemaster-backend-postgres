/**
 * Repo for `core.fix_prompts` (fix-prompt feature). Idempotent upsert keyed by `review_id`
 * (replay/retry-safe) + tenancy-scoped read. Methods:
 *   - persist(record, { installationId })        → INSERT … ON CONFLICT (review_id) DO UPDATE …
 *   - getByReviewId(reviewId, { installationId }) → SELECT … WHERE review_id = :r AND installation_id = :i
 *
 * Tenancy: every statement carries `installation_id`. The read goes through the Kysely query builder
 * with an explicit `.where("installation_id", "=", …)` predicate, so the {@link TenancyPlugin}
 * (installed centrally by {@link tenantKysely} on the shared-pool Kysely this repo is handed) enforces
 * the GF-3 invariant at query-build time — the structural analogue of the Python GF-3 raw-SQL tenancy
 * AST gate. The upsert is an INSERT (out of the plugin's SELECT/UPDATE/DELETE scope, exactly as in the
 * Python hook) but still binds `installation_id` as a column value.
 *
 * ADR-0062 (Postgres connection-pool lifecycle): this repo NO LONGER owns a `pg.Pool` or constructs a
 * `new Kysely(...)`. It is handed a `Kysely<FixPromptDb>` over the process-wide single pool from
 * {@link tenantKysely} (`#platform/db/database.js`) — the structural fix that replaces the old
 * per-repo pool cache so a worker no longer fans out to `N × max` connections. {@link FixPromptRepo.fromDsn}
 * is the default entry point; it routes through {@link tenantKysely} so every repo over the same DSN
 * shares ONE pool. Tests / composition roots that already hold a `Kysely` inject it directly via the
 * constructor. Pool teardown is the shared {@link disposeAllPools} / {@link disposePool} seam, NOT a
 * per-repo `close()` — a Kysely from {@link tenantKysely} must NOT be `destroy()`-ed by a repo, because
 * doing so would end the shared pool out from under every other repo bound to the same DSN.
 *
 * Datetime fidelity: `generated_at` is read back via `to_char(… AT TIME ZONE 'UTC', …)` so the
 * `timestamptz` round-trips as a canonical microsecond-precision `Z`-suffixed RFC3339 string
 * (pg's default `Date` mapping is millisecond-only and would silently truncate the Python
 * microsecond instant — the [[empirical_verification_before_architectural_claims]] trap).
 */

import { type Kysely, sql } from "kysely";

import { tenantKysely } from "#platform/db/database.js";

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
  // de-Temporal Phase 2 (W3.3 / D4 / F3) — RECOVERABLE GitHub-comment post claim. The success columns
  // (`github_comment_id`/`comment_posted_at`) are set ONLY after a confirmed GitHub post (biconditional
  // CHECK `ck_fix_prompts_posted_iff_comment_id`); the in-flight claim is a reclaimable LEASE
  // (`comment_claim_owner`/`comment_claim_expires_at`) a re-run takes over once it expires. Nullable until
  // a post is claimed/recorded; the read path here does not project them.
  github_comment_id: number | null;
  comment_posted_at: string | null;
  comment_claim_owner: string | null;
  comment_claim_expires_at: string | null;
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
  // The injected, shared-pool Kysely (ADR-0062). NOT owned by this repo — never `destroy()`-ed here.
  private readonly db: Kysely<FixPromptDb>;

  /**
   * Construct from an injected `Kysely<FixPromptDb>` — the tenant-scoped, shared-pool instance from
   * {@link tenantKysely}. The {@link TenancyPlugin} is already installed by {@link tenantKysely}; do
   * NOT re-install it here.
   */
  constructor(args: { db: Kysely<FixPromptDb> }) {
    this.db = args.db;
  }

  /**
   * Default entry point (ADR-0062): build a repo over the process-wide single pool for `dsn` via
   * {@link tenantKysely}. Every repo over the same DSN shares ONE pool — no per-repo pool cache.
   */
  static fromDsn(dsn: string): FixPromptRepo {
    return new FixPromptRepo({ db: tenantKysely<FixPromptDb>(dsn) });
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

  // ─── de-Temporal Phase 2 (W3.3 / F2 / F3 / F5) — recoverable GitHub-comment post claim ─────────────
  //
  // The naive "set comment_posted_at, then post" conflates in-flight with done: a crash AFTER the claim
  // but BEFORE the GitHub post would make every re-run skip → the comment is permanently lost (F3). So the
  // success columns (`github_comment_id`/`comment_posted_at`) are set ONLY on a confirmed post
  // (biconditional CHECK `ck_fix_prompts_posted_iff_comment_id`); the in-flight claim is a reclaimable
  // LEASE (`comment_claim_owner`/`comment_claim_expires_at`). All three methods are TENANT-SCOPED (F5):
  // they take `scope: { installationId }` and carry `AND installation_id = …` so the GF-3 raw-SQL tenancy
  // gate's escape-hatch (a) (the `installation_id` token in the SQL) is satisfied — matching `persist`.

  /**
   * Try to acquire the in-flight post claim for `reviewId`, scoped to its tenant. Wins iff the row exists,
   * is not yet posted (`comment_posted_at IS NULL`), and has no LIVE claim (no claim, or an expired one).
   * Sets `comment_claim_owner`/`comment_claim_expires_at = now() + ttlS`. Returns `true` iff EXACTLY this
   * caller took the lease (`numAffectedRows === 1`). Claim ≠ success — a crash after this and before the
   * post leaves the lease to expire so a re-run can reclaim it (the comment is never permanently lost).
   */
  async claimCommentPost(
    reviewId: string,
    owner: string,
    ttlS: number,
    scope: TenantScope,
  ): Promise<boolean> {
    const result = await sql`
      UPDATE core.fix_prompts
         SET comment_claim_owner      = ${owner},
             comment_claim_expires_at = now() + make_interval(secs => ${ttlS})
       WHERE review_id = ${reviewId}
         AND installation_id = ${scope.installationId}
         AND comment_posted_at IS NULL
         AND (comment_claim_expires_at IS NULL OR comment_claim_expires_at < now())
    `.execute(this.db);
    // Kysely returns numAffectedRows as a bigint on UPDATE; exactly-one-row → this caller won the lease.
    return Number(result.numAffectedRows ?? 0n) === 1;
  }

  /**
   * Record a CONFIRMED GitHub post: set `comment_posted_at = now()` + `github_comment_id`, and clear the
   * in-flight claim. Fenced on `comment_claim_owner = ${owner}` so only the lease holder can record (a
   * stale/lost holder no-ops). Satisfies the biconditional CHECK (posted ⇔ comment id). Tenant-scoped.
   */
  async recordCommentPosted(
    reviewId: string,
    owner: string,
    commentId: number,
    scope: TenantScope,
  ): Promise<void> {
    await sql`
      UPDATE core.fix_prompts
         SET comment_posted_at        = now(),
             github_comment_id        = ${commentId},
             comment_claim_owner      = NULL,
             comment_claim_expires_at = NULL
       WHERE review_id = ${reviewId}
         AND installation_id = ${scope.installationId}
         AND comment_claim_owner = ${owner}
    `.execute(this.db);
  }

  /**
   * True iff the review's fix-prompt comment is already posted (`comment_posted_at IS NOT NULL`), scoped
   * to its tenant. The activity's idempotency short-circuit — a second run on a posted review skips the
   * claim + post entirely. Absent / wrong-tenant / not-yet-posted → false.
   */
  async isCommentPosted(reviewId: string, scope: TenantScope): Promise<boolean> {
    const row = await this.db
      .selectFrom("core.fix_prompts")
      .select([sql<boolean>`comment_posted_at IS NOT NULL`.as("posted")])
      .where("review_id", "=", reviewId)
      .where("installation_id", "=", scope.installationId)
      .executeTakeFirst();
    return row?.posted === true;
  }
}
