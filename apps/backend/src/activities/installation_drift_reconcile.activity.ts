/**
 * `installation_drift_reconcile` sweep — W3.6 (master-hardening-plan; audit RH12). The periodic
 * drift-reconcile cron that makes webhook loss SELF-CORRECTING.
 *
 * ADR-0054 / invariant 16 treat GitHub webhooks as cache-invalidation HINTS with
 * `GET /installation/repositories` as the canonical reconciler — but the only triggers for that
 * canonical fetch were event-driven: the PR-webhook drift path (known installation + unknown repo)
 * and, since RH13, `installation_created`. GitHub explicitly does NOT guarantee webhook delivery:
 * a dropped `installation_repositories.added` with no follow-up PR left `core.repositories`
 * permanently stale — the repo silently received zero reviews forever; a dropped
 * `removed`/`suspended` left orphan-enabled rows.
 *
 * The sweep walks ACTIVE (non-suspended) installations and pushes EACH through the SAME
 * cooldown/blocked-gated {@link maybeEnqueueRepair} dispatcher every other repair producer uses
 * (`trigger_source='drift_sweep'`): the repair envelope rides the `installation_reconcile` outbox
 * sink → the cutover port → the `repair_installation_repositories` background job, whose hydrate
 * body upserts the canonical repo set idempotently. The cooldown table throttles per-installation
 * repair spam; blocked installations stay suppressed (the blocked_skips metric fires inside the
 * dispatcher).
 *
 * ## Discipline (mirrors the job_retention janitor idiom)
 *   - Shared ADR-0062 pool via {@link tenantKysely} — no per-run pool construction.
 *   - Per-installation ATOMIC unit: each `maybeEnqueueRepair` runs in its own transaction (the
 *     dispatcher's outbox append + markAttempted commit together — its documented contract).
 *   - Per-installation fail-OPEN: one broken row logs a WARN + continues; the sweep never aborts.
 *   - Bounded walk: {@link DEFAULT_MAX_INSTALLATIONS_PER_RUN} caps a single run (generous at the
 *     ~60-org scale; the next daily tick continues — partial progress is safe because the
 *     dispatcher is idempotent + cooldown-gated).
 */

import { type Kysely, sql } from "kysely";

import { tenantKysely } from "#platform/db/database.js";

import { maybeEnqueueRepair } from "#backend/ingest/_repair_dispatcher.js";

/** Walk bound per run — defensive; today's fleet is ~60 installations. */
export const DEFAULT_MAX_INSTALLATIONS_PER_RUN = 2000;

export type InstallationDriftReconcileDeps = {
  /** DSN override; default `CODEMASTER_PG_CORE_DSN`. */
  dsn?: string;
  /** Test seam: walk bound (default {@link DEFAULT_MAX_INSTALLATIONS_PER_RUN}). */
  maxInstallationsPerRun?: number;
};

export type InstallationDriftReconcileResult = {
  /** Active installations the walk visited this run. */
  readonly scanned: number;
  /** Repairs actually enqueued (cooldown/blocked suppressions are NOT failures). */
  readonly enqueued: number;
  /** Suppressed by the dispatcher's cooldown/blocked gate. */
  readonly suppressed: number;
  /** Per-installation faults (logged + skipped — fail-open). */
  readonly failed: number;
};

function resolveDsn(deps: InstallationDriftReconcileDeps): string {
  const dsn = deps.dsn ?? process.env["CODEMASTER_PG_CORE_DSN"];
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "installation_drift_reconcile: no DSN (set CODEMASTER_PG_CORE_DSN or inject deps.dsn)",
    );
  }
  return dsn;
}

/**
 * Run one drift-reconcile sweep. Idempotent + safely re-drivable: every per-installation unit is
 * the cooldown-gated repair dispatcher (a re-run inside the cooldown window suppresses itself).
 */
export async function installationDriftReconcileActivity(
  deps: InstallationDriftReconcileDeps,
): Promise<InstallationDriftReconcileResult> {
  const dsn = resolveDsn(deps);
  const cap = deps.maxInstallationsPerRun ?? DEFAULT_MAX_INSTALLATIONS_PER_RUN;
  const db: Kysely<unknown> = tenantKysely(dsn);

  // The walk: every non-suspended installation, deterministic order, bounded. Suspended
  // installations are skipped at the SELECT — repairing a revoked App's repo set is wasted egress
  // (and the hydrate would classify it blocked anyway). Non-positive ids are platform sentinels /
  // synthetic rows, never real GitHub installations (the repair payload contract requires >= 1) —
  // excluded rather than burned as per-row failures.
  // tenant:exempt reason=platform-self-heal-sweep-walks-all-active-installations follow_up=PERMANENT-EXEMPTION-drift-reconcile-sweep
  const active = await sql<{ github_installation_id: string }>`
    SELECT github_installation_id FROM core.installations
     WHERE suspended_at IS NULL AND github_installation_id >= 1
     ORDER BY github_installation_id
     LIMIT ${cap}`.execute(db);

  let enqueued = 0;
  let suppressed = 0;
  let failed = 0;
  for (const row of active.rows) {
    const gid = Number(row.github_installation_id);
    try {
      // Each installation is its own transaction so the dispatcher's documented atomic unit
      // (cooldown check → outbox append → markAttempted) commits/rolls back as one.
      const didEnqueue = await db.transaction().execute((tx) =>
        maybeEnqueueRepair(tx, {
          githubInstallationId: gid,
          triggerSource: "drift_sweep",
          deliveryId: null,
        }),
      );
      if (didEnqueue) {
        enqueued += 1;
      } else {
        suppressed += 1;
      }
    } catch (e) {
      // Per-installation fail-OPEN: one broken row (FK surprise, constraint drift) must never
      // abort the fleet-wide self-heal — log + continue; the next tick retries it.
      failed += 1;
      console.warn(
        JSON.stringify({
          event: "installation_drift_reconcile.installation_failed",
          github_installation_id: gid,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  const result: InstallationDriftReconcileResult = {
    scanned: active.rows.length,
    enqueued,
    suppressed,
    failed,
  };
  console.info(
    `installation_drift_reconcile swept: scanned=${result.scanned} enqueued=${result.enqueued} ` +
      `suppressed=${result.suppressed} failed=${result.failed} capped=${active.rows.length >= cap}`,
  );
  return result;
}
