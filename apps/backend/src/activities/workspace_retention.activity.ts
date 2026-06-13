/**
 * Workspace-retention janitor activities — three sweeps the {@link workspaceRetentionWorkflow} composes
 * (orphan → reap → purge), registered as `run_workspace_orphan_sweep_activity` /
 * `run_workspace_reap_activity` / `run_workspace_released_retention_activity` (Phase 6 spec §10).
 *
 * ── worker_heartbeats CAVEAT — orphan branch is DEAD in production ──
 *
 * The orphan-sweep SQL JOINs `core.worker_heartbeats`, whose producer is the live WorkspaceManager
 * heartbeat loop. That producer is UNPORTED — NO TS code WRITES `core.worker_heartbeats` (the table
 * exists in the squashed baseline + is seeded EMPTY). Consequently the orphan-sweep is a STRUCTURAL
 * NO-OP today (`orphaned_count = 0` always). We deliberately do NOT re-base onto
 * `workspace_leases.heartbeat_at`: that would change the liveness semantics (per-lease last-touch vs
 * per-WORKER last-seen). The TTL-expiry reap + released-row purge (the main janitor paths) work
 * regardless. Tracked: FOLLOW-UP-port-workspace-manager-heartbeat.
 *
 * ── Config thresholds (TS constants, not WorkspaceManager._config) ──
 *
 * Timing thresholds are module constants holding the exact `WorkspaceConfig` defaults, overridable via
 * the injected {@link WorkspaceRetentionDeps} for tests. Re-basing onto a ported `WorkspaceConfig` is
 * FOLLOW-UP-port-workspace-config.
 *
 * ## Cross-tenant by design (sweeps carry NO installation_id filter)
 *
 * All three sweeps are cross-tenant liveness/retention scans. The raw-SQL tenancy gate accepts the
 * inline `// tenant:exempt reason=… follow_up=…` marker on each touching query.
 *
 * ## Clock authority
 *
 * Every cutoff comes from the INJECTED {@link Clock} (default {@link WallClock}). Both cutoffs are
 * computed in TS and bound as timestamptz parameters (never SQL `now() - interval`).
 *
 * ## Runtime context / shared-wiring boundary
 *
 * Runs in the NORMAL Node runtime (DB access sanctioned). The Integrate/Workflow phase binds the
 * registered functions under their snake_case Temporal names + owns the worker registry.
 */

import { CompiledQuery, type Transaction } from "kysely";

import {
  recordOrphanSweepNoHeartbeats,
  updateWorkspaceDeadLetterGauges,
} from "#backend/observability/workspace_retention_metrics.js";
import { StateDrift } from "#backend/workspace/errors.js";
import { transitionLease } from "#backend/workspace/transition.js";

import { getPool, tenantKysely, withPgTransaction } from "#platform/db/database.js";
import { type Clock, WallClock } from "#platform/clock.js";

import {
  WorkspaceOrphanSweepResultV1,
  WorkspaceReapEligibleResultV1,
  WorkspaceRetentionPurgeResultV1,
} from "#contracts/workspace_retention_result.v1.js";

// ─── WorkspaceConfig defaults ────────────────────────────────────────────────────────────────────────

/** worker_dead_after default — 5 minutes. A worker whose heartbeat is older than this is dead. */
const WORKER_DEAD_AFTER_MS = 5 * 60 * 1000;
/** release_grace default — 5 minutes. A RELEASE_REQUESTED lease older than this is reap-eligible. */
const RELEASE_GRACE_MS = 5 * 60 * 1000;
/** cleanup_max_attempts default — 5. FAILED_CLEANUP rows at/over this are NOT reaped (operator alert). */
const CLEANUP_MAX_ATTEMPTS = 5;
/** cleanup_backoff_schedule default — 1m, 5m, 30m, 2h, 12h (per-attempt backoff before the next retry). */
const CLEANUP_BACKOFF_SCHEDULE_MS: ReadonlyArray<number> = [
  1 * 60 * 1000,
  5 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
];
/** released_lease_retention default — 7 days. RELEASED rows older than this are hard-deleted. */
const RELEASED_LEASE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Shared deps ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Injected collaborators shared by all three sweeps. All OPTIONAL — production resolves the shared pool
 * from `CODEMASTER_PG_CORE_DSN` (the ADR-0062 pool) + stamps every cutoff from a {@link WallClock};
 * tests inject a disposable-PG `dsn` + a {@link FakeClock}.
 */
export type WorkspaceRetentionDeps = {
  /** DSN for the shared pool; default `CODEMASTER_PG_CORE_DSN`. */
  dsn?: string;
  /** Time seam for every cutoff; default {@link WallClock}. */
  clock?: Clock;
};

/** Resolve the DSN for the shared pool: the injected one, else `CODEMASTER_PG_CORE_DSN`. */
function resolveDsn(deps: WorkspaceRetentionDeps): string {
  if (deps.dsn !== undefined && deps.dsn !== "") {
    return deps.dsn;
  }
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set and no dsn injected; cannot run the workspace-retention sweep",
    );
  }
  return dsn;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
//  Activity 1 — orphan sweep
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/** A candidate the orphan-sweep SELECT returned. */
type OrphanCandidateRow = { workspace_id: string };

/**
 * `runWorkspaceOrphanSweepActivity` (registered `run_workspace_orphan_sweep_activity`). Sweeps ALLOCATED
 * leases whose owning worker is dead + whose orphan grace elapsed, flipping each to ORPHANED.
 *
 * The candidate SELECT (FOR UPDATE OF l SKIP LOCKED) + every per-row {@link transitionLease} run inside
 * ONE Kysely transaction so concurrent janitors / workflow cancellations don't double-transition. Both
 * timestamp cutoffs are computed in TS and bound as timestamptz parameters (avoids the asyncpg
 * numeric→interval coercion gotcha).
 *
 * Returns `WorkspaceOrphanSweepResultV1{orphaned_count}`. NOTE (see module header): in production the
 * `JOIN core.worker_heartbeats` matches zero rows (heartbeat producer unported), so this returns 0 —
 * the SQL fires once the producer is ported.
 */
export async function runWorkspaceOrphanSweepActivity(
  deps: WorkspaceRetentionDeps = {},
): Promise<WorkspaceOrphanSweepResultV1> {
  const dsn = resolveDsn(deps);
  const clock: Clock = deps.clock ?? new WallClock();
  const db = tenantKysely<unknown>(dsn);

  const now = clock.now();
  const workerDeadCutoff = new Date(now.getTime() - WORKER_DEAD_AFTER_MS);

  // W3.5 (OH5): the heartbeat PRODUCER is unported (FOLLOW-UP-port-workspace-manager-heartbeat).
  // With ZERO heartbeat rows the dead_workers CTE matches nothing and this sweep is a guaranteed
  // orphaned_count=0 no-op — dead-worker reclamation is OFFLINE, which must be SAID (structured
  // WARN + bounded counter), never reported as a falsely-green zero.
  // tenant:exempt reason=platform-liveness-probe-on-heartbeat-table follow_up=PERMANENT-EXEMPTION-workspace-retention
  const heartbeatProbe = await db.executeQuery<{ one: number }>(
    CompiledQuery.raw("SELECT 1 AS one FROM core.worker_heartbeats LIMIT 1", []),
  );
  if (heartbeatProbe.rows.length === 0) {
    recordOrphanSweepNoHeartbeats();
    console.warn(
      JSON.stringify({
        event: "workspace_orphan_sweep.no_heartbeat_producer",
        detail:
          "core.worker_heartbeats is empty — the heartbeat producer is unported, so dead-worker " +
          "lease reclamation cannot fire; orphaned_count=0 is OFFLINE, not healthy " +
          "(FOLLOW-UP-port-workspace-manager-heartbeat)",
      }),
    );
  }

  let orphaned = 0;
  await db.transaction().execute(async (tx: Transaction<unknown>) => {
    // Step 1 — find candidates under FOR UPDATE so concurrent janitors / cancellations don't
    // double-transition. INNER JOIN to core.worker_heartbeats (not LEFT): every active lease's worker_id
    // is registered at preflight; a missing row is itself an anomaly the platform should observe, NOT
    // silently treat as "worker dead".
    // tenant:exempt reason=cross-tenant-orphan-liveness-sweep follow_up=PERMANENT-EXEMPTION-workspace-retention
    const candidateResult = await tx.executeQuery<OrphanCandidateRow>(
      CompiledQuery.raw(
        "WITH dead_workers AS (" +
          "    SELECT worker_id" +
          "    FROM core.worker_heartbeats" +
          "    WHERE last_seen_at < $1" +
          ") " +
          "SELECT l.workspace_id " +
          "FROM core.workspace_leases l " +
          "JOIN dead_workers d ON l.worker_id = d.worker_id " +
          "WHERE l.state = 'ALLOCATED' " +
          "  AND l.orphan_check_after < $2 " +
          "FOR UPDATE OF l SKIP LOCKED",
        [workerDeadCutoff, now],
      ),
    );

    for (const row of candidateResult.rows) {
      const workspaceId = row.workspace_id;
      try {
        await transitionLease({
          tx,
          workspaceId,
          fromState: "ALLOCATED",
          toState: "ORPHANED",
          activity: "run_workspace_orphan_sweep_activity",
          reason: "worker_dead_after_threshold",
          clock,
        });
        orphaned += 1;
      } catch (e) {
        // A concurrent transition won the race (StateDrift) OR a DB-side race fired. Leave the row for
        // the next sweep — do NOT roll back the outer transaction (surviving candidates still flip
        // ORPHANED). The exception is logged so silent suppression is observable.
        if (e instanceof StateDrift) {
          console.info(`orphan sweep skipped workspace ${workspaceId}: ${e.message}`);
          continue;
        }
        // Non-StateDrift errors are unexpected here; surface the cause but keep sweeping — fail-open
        // per-row, a single bad row must not poison the sweep.
        console.info(`orphan sweep skipped workspace ${workspaceId}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
    }
  });

  return WorkspaceOrphanSweepResultV1.parse({ orphaned_count: orphaned });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
//  Activity 2 — reap-eligible
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/** A FAILED_CLEANUP row the reap activity applies the per-attempt backoff filter to. */
type FailedCleanupRow = {
  workspace_id: string;
  cleanup_attempts: number;
  last_cleanup_attempt_at: Date | null;
};

/**
 * `runWorkspaceReapActivity` (registered `run_workspace_reap_activity`). Returns the SORTED `workspace_id`
 * tuple of leases eligible for a release retry — NO side effects on the lease rows. Three SELECTs
 * (ORPHANED always; aged RELEASE_REQUESTED; FAILED_CLEANUP pulled then backoff-filtered in TS), unioned +
 * sorted.
 */
export async function runWorkspaceReapActivity(
  deps: WorkspaceRetentionDeps = {},
): Promise<WorkspaceReapEligibleResultV1> {
  const dsn = resolveDsn(deps);
  const clock: Clock = deps.clock ?? new WallClock();
  const pool = getPool(dsn);

  const now = clock.now();
  const releaseGraceCutoff = new Date(now.getTime() - RELEASE_GRACE_MS);

  const eligible: Array<string> = [];

  await withPgTransaction(pool, async (client) => {
    // ORPHANED → always eligible.
    // tenant:exempt reason=cross-tenant-reap-eligibility-scan follow_up=PERMANENT-EXEMPTION-workspace-retention
    const orphanedRows = await client.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM core.workspace_leases WHERE state = 'ORPHANED'",
    );
    for (const r of orphanedRows.rows) eligible.push(r.workspace_id);

    // RELEASE_REQUESTED past release_grace. Cutoff computed in TS + bound as timestamptz.
    // tenant:exempt reason=cross-tenant-reap-eligibility-scan follow_up=PERMANENT-EXEMPTION-workspace-retention
    const releaseRequestedRows = await client.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM core.workspace_leases " +
        "WHERE state = 'RELEASE_REQUESTED' AND release_requested_at < $1",
      [releaseGraceCutoff],
    );
    for (const r of releaseRequestedRows.rows) eligible.push(r.workspace_id);

    // FAILED_CLEANUP — pull the rows + apply the per-attempt backoff in TS (the backoff is a
    // tuple-indexed value; expressing it inline in SQL is more brittle for a sweep that touches at most
    // ~dozens of rows per cycle).
    // tenant:exempt reason=cross-tenant-reap-eligibility-scan follow_up=PERMANENT-EXEMPTION-workspace-retention
    const failedRows = await client.query<FailedCleanupRow>(
      "SELECT workspace_id, cleanup_attempts, last_cleanup_attempt_at " +
        "FROM core.workspace_leases " +
        "WHERE state = 'FAILED_CLEANUP' AND cleanup_attempts < $1",
      [CLEANUP_MAX_ATTEMPTS],
    );
    for (const r of failedRows.rows) {
      const attempts = r.cleanup_attempts ?? 0;
      const lastAttempt = r.last_cleanup_attempt_at;
      // Index clamp: attempts past the schedule length use the last entry. The cleanup_max_attempts
      // filter above bounds this.
      const backoffIdx = Math.min(attempts, CLEANUP_BACKOFF_SCHEDULE_MS.length - 1);
      // eslint-disable-next-line security/detect-object-injection -- backoffIdx is a clamped numeric index into a fixed module-level array, not external/object-key input
      const backoffMs = CLEANUP_BACKOFF_SCHEDULE_MS[backoffIdx]!;
      if (lastAttempt === null || new Date(lastAttempt).getTime() + backoffMs < now.getTime()) {
        eligible.push(r.workspace_id);
      }
    }
  });

  // Sort for deterministic test assertions + stable Temporal histories.
  const sorted = [...eligible].sort();
  return WorkspaceReapEligibleResultV1.parse({ workspace_ids: sorted });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
//  Activity 3 — released-row retention purge
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `runWorkspaceReleasedRetentionActivity` (registered `run_workspace_released_retention_activity`).
 * Hard-deletes RELEASED leases whose `released_at` is past `released_lease_retention` (default 7d).
 * Returns `WorkspaceRetentionPurgeResultV1{deleted_count}` (the DELETE rowcount). These are terminal
 * lifecycle rows; the audit trail lives in `audit.workflow_events`.
 */
export async function runWorkspaceReleasedRetentionActivity(
  deps: WorkspaceRetentionDeps = {},
): Promise<WorkspaceRetentionPurgeResultV1> {
  const dsn = resolveDsn(deps);
  const clock: Clock = deps.clock ?? new WallClock();
  const pool = getPool(dsn);

  const retentionCutoff = new Date(clock.now().getTime() - RELEASED_LEASE_RETENTION_MS);

  const deleted = await withPgTransaction(pool, async (client) => {
    // tenant:exempt reason=cross-tenant-released-row-retention-purge follow_up=PERMANENT-EXEMPTION-workspace-retention
    const result = await client.query(
      "DELETE FROM core.workspace_leases WHERE state = 'RELEASED' AND released_at < $1",
      [retentionCutoff],
    );
    return result.rowCount ?? 0;
  });

  return WorkspaceRetentionPurgeResultV1.parse({ deleted_count: deleted });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
//  Activity 4 — dead-letter visibility sweep (W3.5 / OH6 — TS-NET-NEW)
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/** An ORPHANED lease still un-reaped this long after allocation means the reap path is NOT
 *  converging (a healthy cycle reaps orphans within minutes; lease lifetimes are minutes). */
const ORPHANED_AGED_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** The OH6 snapshot: rows no sweep will ever recover (operator dead-letter queue). */
export type WorkspaceDeadLetterSweepResult = {
  /** FAILED_CLEANUP leases at/over {@link CLEANUP_MAX_ATTEMPTS} — reap permanently skips them;
   *  each is a leaked on-disk workspace until an operator intervenes. */
  readonly failed_cleanup_stuck: number;
  /** ORPHANED leases older than {@link ORPHANED_AGED_THRESHOLD_MS} since allocation. */
  readonly orphaned_aged: number;
};

/**
 * `runWorkspaceDeadLetterSweepActivity` — the dead-letter visibility the
 * "FAILED_CLEANUP rows at/over this are NOT reaped (operator alert)" comment PROMISED but never
 * delivered (OH6): a read-only count of the two permanently-stuck lease classes, published as
 * observable gauges (workspace_retention_metrics.ts) + a structured WARN whenever either is
 * non-zero. Runs as the workspace_retention handler's final step, fail-open (pure observability —
 * it must never fail the janitor chain).
 */
export async function runWorkspaceDeadLetterSweepActivity(
  deps: WorkspaceRetentionDeps = {},
): Promise<WorkspaceDeadLetterSweepResult> {
  const dsn = resolveDsn(deps);
  const clock: Clock = deps.clock ?? new WallClock();
  const pool = getPool(dsn);

  const agedCutoff = new Date(clock.now().getTime() - ORPHANED_AGED_THRESHOLD_MS);
  // tenant:exempt reason=cross-tenant-dead-letter-count-read-only follow_up=PERMANENT-EXEMPTION-workspace-retention
  const r = await pool.query<{ failed_cleanup_stuck: string; orphaned_aged: string }>(
    "SELECT " +
      "  COUNT(*) FILTER (WHERE state = 'FAILED_CLEANUP' AND cleanup_attempts >= $1) AS failed_cleanup_stuck, " +
      "  COUNT(*) FILTER (WHERE state = 'ORPHANED' AND created_at < $2) AS orphaned_aged " +
      "FROM core.workspace_leases",
    [CLEANUP_MAX_ATTEMPTS, agedCutoff],
  );
  const result: WorkspaceDeadLetterSweepResult = {
    failed_cleanup_stuck: Number(r.rows[0]?.failed_cleanup_stuck ?? 0),
    orphaned_aged: Number(r.rows[0]?.orphaned_aged ?? 0),
  };

  updateWorkspaceDeadLetterGauges({
    failedCleanupStuck: result.failed_cleanup_stuck,
    orphanedAged: result.orphaned_aged,
  });
  if (result.failed_cleanup_stuck > 0 || result.orphaned_aged > 0) {
    console.warn(
      JSON.stringify({
        event: "workspace_retention.dead_letter_leases",
        failed_cleanup_stuck: result.failed_cleanup_stuck,
        orphaned_aged: result.orphaned_aged,
        detail:
          "leases NO sweep will recover (FAILED_CLEANUP at the attempt ceiling / ORPHANED aged " +
          ">24h) — leaked disk until an operator clears them",
      }),
    );
  }
  return result;
}
