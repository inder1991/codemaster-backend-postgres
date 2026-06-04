/**
 * ReviewToolRunsRepo — 1:1 TypeScript/Kysely port of the frozen Python repo
 * `vendor/codemaster-py/codemaster/domain/repos/review_tool_runs_repo.py`
 * (`PostgresReviewToolRunsRepo`, Phase D Task D.7).
 *
 * One row per `(run_id, tool_name)` over `core.review_tool_runs` (migration 0084), carrying the
 * Tier-1 static-analysis tool's execution outcome (sourced from
 * `contracts.tool_status.v1::ToolStatusV1`).
 *
 * Faithful to the Python source:
 *
 *  - **Single public method `insertToolRun`** — exactly the method set of the Python port
 *    (`insert_tool_run`). No SELECT path lives in this repo (the Python repo has none either); the
 *    arbitration-apply caller writes, downstream observability reads via its own queries.
 *
 *  - **Idempotency via `ON CONFLICT (run_id, tool_name) DO NOTHING`.** The UNIQUE
 *    `(run_id, tool_name)` constraint (`uq_review_tool_runs_run_tool`) absorbs Temporal retries of
 *    the same `record_tool_runs` activity invocation — the same workflow replay re-firing the
 *    activity produces ZERO row drift. Mirrors the Python `ON CONFLICT (run_id, tool_name)
 *    DO NOTHING`.
 *
 *  - **Tenancy.** `installation_id` is in the INSERT column/VALUES list directly, exactly as the
 *    Python SQL. INSERT carries no WHERE clause, so the {@link TenancyPlugin} (which gates only
 *    SELECT/UPDATE/DELETE — INSERT is out of scope, mirroring the Python `do_orm_execute` hook) does
 *    not fire on the write; the plugin is nonetheless installed on this repo's Kysely instance per
 *    the data-layer convention, so any future SELECT/UPDATE/DELETE added here is gated automatically.
 *
 * Per ADR-0062, the `pg.Pool` and the `Kysely` instance are MEMOIZED — created once and reused — so a
 * worker does not leak a connection pool per call. The pool is injected by the caller (the production
 * composition root memoizes it); the `Kysely` wrapper around it is memoized inside this module keyed
 * by pool identity.
 */

import { type Generated, Kysely, PostgresDialect } from "kysely";
import type { Pool } from "pg";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";

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

// ── Memoized Kysely instance (ADR-0062: never per-call) ──

const KYSELY_BY_POOL = new WeakMap<Pool, Kysely<ReviewToolRunsDB>>();

/**
 * Return the memoized {@link Kysely} instance wrapping `pool`, creating it once on first use. Keyed by
 * pool identity via a {@link WeakMap} so distinct pools (tests, multiple environments) get distinct
 * instances without leaking. The {@link TenancyPlugin} is installed so any future tenant-scoped
 * SELECT/UPDATE/DELETE on this schema is gated.
 */
function kyselyFor(pool: Pool): Kysely<ReviewToolRunsDB> {
  const existing = KYSELY_BY_POOL.get(pool);
  if (existing !== undefined) {
    return existing;
  }
  const db = new Kysely<ReviewToolRunsDB>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new TenancyPlugin()],
  });
  KYSELY_BY_POOL.set(pool, db);
  return db;
}

// ── Public input shape (mirrors the Python keyword-only signature) ──

/**
 * Arguments to {@link ReviewToolRunsRepo.insertToolRun}, mirroring the Python `insert_tool_run`
 * keyword-only signature 1:1. `installationId` / `runId` / `reviewId` are UUID strings (the
 * TypeScript analogue of `uuid.UUID`). `startedAt` is a required instant; `finishedAt` is
 * required-but-nullable (`datetime | None`). Integer fields are `number` (the table columns are
 * `integer`).
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

/** Repo port consumed by the Phase D arbitration-apply path (analogue of `ReviewToolRunsRepoPort`). */
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
 * The injected `pool` is memoized by the caller (ADR-0062); the `Kysely` wrapper is memoized inside
 * this module keyed by pool identity, so constructing many `ReviewToolRunsRepo` instances over the
 * same pool does NOT create many Kysely instances.
 */
export class ReviewToolRunsRepo implements ReviewToolRunsRepoPort {
  readonly #db: Kysely<ReviewToolRunsDB>;

  constructor(args: { pool: Pool }) {
    this.#db = kyselyFor(args.pool);
  }

  async insertToolRun(input: InsertToolRunInput): Promise<void> {
    // 1:1 with the Python INSERT: same 13 columns in the same order, ON CONFLICT (run_id, tool_name)
    // DO NOTHING. installation_id is in the VALUES list (tenancy satisfied at the literal-SQL level).
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
