/**
 * ReviewToolRunsRepo — one row per `(run_id, tool_name)` over `core.review_tool_runs` (migration 0084,
 * Phase D Task D.7), carrying the Tier-1 static-analysis tool's execution outcome.
 *
 *
 *  - **Single public method `insertToolRun`** — no SELECT path lives in this repo; the
 *    arbitration-apply caller writes, downstream observability reads via its own queries.
 *
 *  - **Idempotency via `ON CONFLICT (run_id, tool_name) DO NOTHING`.** The UNIQUE
 *    `(run_id, tool_name)` constraint (`uq_review_tool_runs_run_tool`) absorbs Temporal retries of
 *    the same `record_tool_runs` activity invocation — the same workflow replay re-firing the
 *    activity produces ZERO row drift.
 *
 *  - **Tenancy.** `installation_id` is in the INSERT column/VALUES list directly. INSERT carries no
 *    WHERE clause, so the {@link TenancyPlugin} (which gates only SELECT/UPDATE/DELETE) does not fire
 *    on the write; the plugin is nonetheless installed centrally by {@link tenantKysely} on the
 *    shared-pool Kysely this repo is handed, so any future SELECT/UPDATE/DELETE added here is gated
 *    automatically.
 *
 * ADR-0062 (Postgres connection-pool lifecycle): this repo NO LONGER owns a `pg.Pool`, constructs a
 * `new Kysely(...)`, or memoizes either. It is handed a `Kysely<ReviewToolRunsDB>` over the
 * process-wide single pool from {@link tenantKysely} (`#platform/db/database.js`) — the structural fix
 * that replaces the old per-repo WeakMap-keyed Kysely cache so a worker no longer fans out to
 * `N × max` connections. {@link ReviewToolRunsRepo.fromDsn} is the default entry point; it routes
 * through {@link tenantKysely} so every repo over the same DSN shares ONE pool. Tests / composition
 * roots that already hold a `Kysely` inject it directly via the constructor. Pool teardown is the
 * shared `disposeAllPools` / `disposePool` seam, NOT a per-repo `close()` — a Kysely from
 * {@link tenantKysely} must NOT be `destroy()`-ed by a repo, because doing so would end the shared
 * pool out from under every other repo bound to the same DSN.
 */

import { type Generated, type Kysely } from "kysely";

import { tenantKysely } from "#platform/db/database.js";

// ── Kysely table typing for core.review_tool_runs (confirmed against the live disposable DB) ──

/**
 * Column types for `core.review_tool_runs`. `review_tool_run_id` / `created_at` are DB-defaulted
 * (`gen_random_uuid()` / `now()`) — {@link Generated} so they need not be supplied on insert.
 * `k8s_job_name` / `k8s_namespace` are present on the table but NOT written by this repo (the Python
 * repo omits them too; `k8s_namespace` carries a DB default), so they are typed nullable-with-default
 * and left to the DB.
 */
type ReviewToolRunsTable = {
  review_tool_run_id: Generated<string>;
  installation_id: string;
  run_id: string;
  review_id: string;
  tool_name: string;
  status: string;
  files_scanned: number;
  files_total: number;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number;
  findings_produced: number;
  error_class: string | null;
  error_message: string | null;
  k8s_job_name: Generated<string | null>;
  k8s_namespace: Generated<string | null>;
  created_at: Generated<Date>;
};

/** The Kysely schema for this repo — schema-qualified table key so the TenancyPlugin can resolve it. */
type ReviewToolRunsDB = {
  "core.review_tool_runs": ReviewToolRunsTable;
};

// ── Public input shape ──

/**
 * Arguments to {@link ReviewToolRunsRepo.insertToolRun}. `installationId` / `runId` / `reviewId` are
 * UUID strings. `startedAt` is a required instant; `finishedAt` is required-but-nullable. Integer
 * fields are `number` (the table columns are `integer`).
 */
export type InsertToolRunInput = {
  installationId: string;
  runId: string;
  reviewId: string;
  toolName: string;
  status: string;
  filesScanned: number;
  filesTotal: number;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number;
  findingsProduced: number;
  errorClass: string | null;
  errorMessage: string | null;
};

/** Repo port consumed by the Phase D arbitration-apply path. */
export type ReviewToolRunsRepoPort = {
  /**
   * Insert one `core.review_tool_runs` row. Idempotent via `ON CONFLICT (run_id, tool_name)
   * DO NOTHING` — Temporal retries of the same activity invocation are absorbed without row
   * duplication.
   */
  insertToolRun(input: InsertToolRunInput): Promise<void>;
};

/**
 * Implements {@link ReviewToolRunsRepoPort} against `core.review_tool_runs` via Kysely.
 *
 * ADR-0062: the injected `Kysely<ReviewToolRunsDB>` is the tenant-scoped, shared-pool instance from
 * {@link tenantKysely}. This repo owns NO pool and NO Kysely cache — many `ReviewToolRunsRepo`
 * instances over the same DSN share the ONE process-wide pool. The {@link TenancyPlugin} is already
 * installed by {@link tenantKysely}; do NOT re-install it here.
 */
export class ReviewToolRunsRepo implements ReviewToolRunsRepoPort {
  // The injected, shared-pool Kysely (ADR-0062). NOT owned by this repo — never `destroy()`-ed here.
  readonly #db: Kysely<ReviewToolRunsDB>;

  /**
   * Construct from an injected `Kysely<ReviewToolRunsDB>` — the tenant-scoped, shared-pool instance
   * from {@link tenantKysely}. Tests / composition roots that already hold a `Kysely` inject it here.
   */
  constructor(args: { db: Kysely<ReviewToolRunsDB> }) {
    this.#db = args.db;
  }

  /**
   * Default entry point (ADR-0062): build a repo over the process-wide single pool for `dsn` via
   * {@link tenantKysely}. Every repo over the same DSN shares ONE pool — no per-repo pool cache.
   */
  static fromDsn(dsn: string): ReviewToolRunsRepo {
    return new ReviewToolRunsRepo({ db: tenantKysely<ReviewToolRunsDB>(dsn) });
  }

  async insertToolRun(input: InsertToolRunInput): Promise<void> {
    // ON CONFLICT (run_id, tool_name) DO NOTHING — 13 columns; installation_id is in the VALUES list
    // (tenancy satisfied at the literal-SQL level).
    await this.#db
      .insertInto("core.review_tool_runs")
      .values({
        installation_id: input.installationId,
        run_id: input.runId,
        review_id: input.reviewId,
        tool_name: input.toolName,
        status: input.status,
        files_scanned: input.filesScanned,
        files_total: input.filesTotal,
        started_at: input.startedAt,
        finished_at: input.finishedAt,
        duration_ms: input.durationMs,
        findings_produced: input.findingsProduced,
        error_class: input.errorClass,
        error_message: input.errorMessage,
      })
      .onConflict((oc) => oc.columns(["run_id", "tool_name"]).doNothing())
      .execute();
  }
}
