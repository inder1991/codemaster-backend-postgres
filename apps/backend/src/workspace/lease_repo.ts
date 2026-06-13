/**
 * LeaseRepo — thin CRUD-only adapter over `core.workspace_leases` (Phase 6 / Task 7). Methods:
 *
 *   - insert            — INSERT a new ALLOCATED lease row.
 *                         `ON CONFLICT (run_id) WHERE state IN ('ALLOCATED','RELEASE_REQUESTED')
 *                         DO NOTHING` makes the insert idempotent under Temporal retry (the
 *                         conflict target matches the partial-unique index `ux_workspace_active_run`).
 *                         `state`/`created_at`/`heartbeat_at` default via the column DEFAULTs.
 *   - getById           — SELECT * by primary key; returns the row or `undefined`.
 *   - findActiveByRun   — SELECT * by `run_id` with state in the active set
 *                         ('ALLOCATED','RELEASE_REQUESTED'); scans the partial index so it returns
 *                         at most one row (AD-11). Used by allocate for idempotency.
 *   - touchHeartbeat    — `UPDATE heartbeat_at = clock_timestamp() WHERE workspace_id = :id AND
 *                         state = 'ALLOCATED'`; returns `true` iff a row was updated (`false` when
 *                         the row is missing or no longer ALLOCATED — caller logs, does NOT raise).
 *                         Uses Postgres `clock_timestamp()` (statement-time) so two touches within a
 *                         long transaction still advance `heartbeat_at` monotonically — there is no
 *                         TS clock seam here (the wall-clock value is the DB's, NOT an injected clock).
 *
 * ## Transaction discipline
 *
 * Every method takes an injected `Kysely`/`Transaction` and runs raw `sql` against it; the repo
 * NEVER commits. The caller owns the transaction boundary so the lease row commits or rolls back
 * together with downstream side effects (state-machine transitions emit a `workflow_events` row in
 * the SAME transaction — see {@link transitionLease}). State transitions live in `./transition.ts`.
 *
 * ## ADR-0062 (shared pool) + tenancy
 *
 * The repo holds NO pool — it is handed a `Kysely`/`Transaction` over the shared ADR-0062 pool
 * (`#platform/db/database.js::tenantKysely`). `core.workspace_leases` is tenant-scoped
 * (`installation_id` NOT NULL); every method here keys by the PRIMARY key (`workspace_id`) or the
 * partial-unique `run_id` — PK/unique-key lookups, not tenant scans — so each raw `sql` carries a
 * `// tenant:exempt reason=PK/unique-lookup follow_up=...` marker (the idiom the gate's escape-hatch
 * sanctions for PK lookups).
 */

import { type Kysely, sql, type Transaction } from "kysely";

/**
 * Full `core.workspace_leases` row shape (the columns a `SELECT *` returns). `snake_case` keys
 * because they are the literal DB column names Kysely returns; not renamed to camelCase.
 */
export type WorkspaceLeaseRow = {
  workspace_id: string;
  run_id: string;
  review_id: string;
  installation_id: string;
  state: string;
  pod_name: string;
  pod_namespace: string;
  node_name: string | null;
  worker_id: string;
  created_at: Date;
  heartbeat_at: Date;
  orphan_check_after: Date;
  release_requested_at: Date | null;
  release_requested_by: string | null;
  released_at: Date | null;
  cleanup_failed_at: Date | null;
  last_cleanup_attempt_at: Date | null;
  cleanup_attempts: number;
  last_cleanup_error: string | null;
};

/** Arguments for {@link LeaseRepo.insert}. */
export type InsertLeaseArgs = {
  workspaceId: string;
  runId: string;
  reviewId: string;
  installationId: string;
  podName: string;
  podNamespace: string;
  nodeName: string | null;
  workerId: string;
  orphanCheckAfter: Date;
};

/**
 * Thin async wrapper around `core.workspace_leases`. Construct with an injected `Kysely`/`Transaction`
 * (over the shared ADR-0062 pool). NO clock is held — the heartbeat path uses the DB `clock_timestamp()`
 * (statement-time) rather than any injected clock (see {@link touchHeartbeat}).
 */
export class LeaseRepo {
  private readonly db: Kysely<unknown> | Transaction<unknown>;

  public constructor({ db }: { db: Kysely<unknown> | Transaction<unknown> }) {
    this.db = db;
  }

  /**
   * Insert a new ALLOCATED lease row.
   *
   * `ON CONFLICT (run_id) WHERE state IN ('ALLOCATED','RELEASE_REQUESTED') DO NOTHING` makes the
   * insert idempotent under Temporal retry. The caller checks via {@link findActiveByRun} whether an
   * existing lease was reused. `state` / `created_at` / `heartbeat_at` are left to their column
   * DEFAULTs (`'ALLOCATED'` / `now()` / `now()`).
   */
  public async insert(args: InsertLeaseArgs): Promise<void> {
    // tenant:exempt reason=INSERT-carries-installation_id-in-VALUES follow_up=PERMANENT-EXEMPTION-workspace-lease-pk
    await sql`
      INSERT INTO core.workspace_leases
        (workspace_id, run_id, review_id, installation_id,
         pod_name, pod_namespace, node_name, worker_id,
         orphan_check_after)
      VALUES (${args.workspaceId}, ${args.runId}, ${args.reviewId}, ${args.installationId},
              ${args.podName}, ${args.podNamespace}, ${args.nodeName}, ${args.workerId},
              ${args.orphanCheckAfter})
      ON CONFLICT (run_id)
      WHERE state IN ('ALLOCATED', 'RELEASE_REQUESTED')
      DO NOTHING
    `.execute(this.db);
  }

  /**
   * SELECT * by primary key. Returns the full row, or `undefined` when the row does not exist.
   */
  public async getById(workspaceId: string): Promise<WorkspaceLeaseRow | undefined> {
    // tenant:exempt reason=PK-lookup-by-workspace_id follow_up=PERMANENT-EXEMPTION-workspace-lease-pk
    const result = await sql<WorkspaceLeaseRow>`
      SELECT * FROM core.workspace_leases WHERE workspace_id = ${workspaceId}
    `.execute(this.db);
    return result.rows[0];
  }

  /**
   * SELECT * by `run_id` with state in the active set.
   *
   * The active set ('ALLOCATED','RELEASE_REQUESTED') matches the predicate of `ux_workspace_active_run`
   * so this scans the partial-unique index and returns at most one row (AD-11). Used by
   * `allocate_workspace_activity` for idempotency: if a row already exists for `run_id`, the activity
   * returns the existing handle instead of creating a new one. Returns the row or `undefined`.
   */
  public async findActiveByRun(runId: string): Promise<WorkspaceLeaseRow | undefined> {
    // tenant:exempt reason=unique-key-lookup-by-run_id follow_up=PERMANENT-EXEMPTION-workspace-lease-pk
    const result = await sql<WorkspaceLeaseRow>`
      SELECT * FROM core.workspace_leases
       WHERE run_id = ${runId}
         AND state IN ('ALLOCATED', 'RELEASE_REQUESTED')
    `.execute(this.db);
    return result.rows[0];
  }

  /**
   * Bump `heartbeat_at` for an ALLOCATED lease.
   *
   * `UPDATE heartbeat_at = clock_timestamp() WHERE workspace_id = :id AND state = 'ALLOCATED'`.
   * Returns `true` if a row was updated, `false` otherwise (row missing or no longer ALLOCATED). The
   * caller logs but does NOT raise on `false` — a release-in-flight legitimately drops a heartbeat
   * between the manager's tick and the UPDATE.
   *
   * Uses `clock_timestamp()` (statement-time), NOT the injected TS clock and NOT `now()`
   * (transaction-start), so two heartbeat touches within a long transaction still advance
   * `heartbeat_at` monotonically — matching the janitor's wall-clock AD-14 liveness reasoning. This is
   * a DB-side clock, outside the TS clock seam's scope.
   */
  public async touchHeartbeat(workspaceId: string): Promise<boolean> {
    // tenant:exempt reason=PK-lookup-by-workspace_id follow_up=PERMANENT-EXEMPTION-workspace-lease-pk
    const result = await sql`
      UPDATE core.workspace_leases
         SET heartbeat_at = clock_timestamp()
       WHERE workspace_id = ${workspaceId}
         AND state = 'ALLOCATED'
    `.execute(this.db);
    // Kysely surfaces affected-row count on `numAffectedRows` (a bigint), compared to 0n.
    const affected = result.numAffectedRows ?? 0n;
    return affected > 0n;
  }
}
