/**
 * Workspace-retention dead-letter observability — W3.5 (OH5 + OH6). TS-NET-NEW metric names (no
 * Python predecessor: the frozen comment at workspace_retention.activity.ts promised an "operator
 * alert" for stuck FAILED_CLEANUP leases that never existed anywhere).
 *
 *   * codemaster_workspace_leases_failed_cleanup_stuck (observable gauge)
 *       — FAILED_CLEANUP leases at/over the cleanup-attempt ceiling: rows the reap will NEVER
 *         re-drive; each is a permanently leaked on-disk workspace until an operator acts (OH6).
 *   * codemaster_workspace_leases_orphaned_aged (observable gauge)
 *       — ORPHANED leases still un-reaped >24h after allocation: the reap path is not converging.
 *   * codemaster_workspace_orphan_sweep_no_heartbeats_total (counter)
 *       — the orphan sweep ran against an EMPTY core.worker_heartbeats (the heartbeat producer is
 *         unported — FOLLOW-UP-port-workspace-manager-heartbeat), so dead-worker reclamation is
 *         OFFLINE and the sweep's orphaned_count=0 is falsely green (OH5).
 *
 * Gauges follow the confluence_token_metrics idiom: the sweep writes the latest counts into module
 * state; lazily-registered observable-gauge callbacks surface them — no producer loop. Cardinality:
 * NO labels at all (fleet-wide counts; per-tenant labels are banned by the metrics seam discipline).
 */

import { type Counter, getMeter, type ObservableResult } from "#platform/observability/metrics.js";

const METER_NAME = "codemaster.workspace.retention";

export const FAILED_CLEANUP_STUCK_GAUGE_NAME = "codemaster_workspace_leases_failed_cleanup_stuck";
export const ORPHANED_AGED_GAUGE_NAME = "codemaster_workspace_leases_orphaned_aged";
export const ORPHAN_SWEEP_NO_HEARTBEATS_NAME =
  "codemaster_workspace_orphan_sweep_no_heartbeats_total";

let latestFailedCleanupStuck: number | null = null;
let latestOrphanedAged: number | null = null;
let gaugesRegistered = false;
let noHeartbeatsCounter: Counter | null = null;

/** Publish the latest dead-letter snapshot (OH6); the gauges observe it via callback. */
export function updateWorkspaceDeadLetterGauges(args: {
  failedCleanupStuck: number;
  orphanedAged: number;
}): void {
  latestFailedCleanupStuck = args.failedCleanupStuck;
  latestOrphanedAged = args.orphanedAged;
  ensureGaugesRegistered();
}

/** Count one orphan-sweep pass that found ZERO heartbeat rows (OH5 — reclamation offline). */
export function recordOrphanSweepNoHeartbeats(): void {
  if (noHeartbeatsCounter === null) {
    noHeartbeatsCounter = getMeter(METER_NAME).createCounter(ORPHAN_SWEEP_NO_HEARTBEATS_NAME, {
      description:
        "Orphan-sweep passes that ran against an empty core.worker_heartbeats — the heartbeat " +
        "producer is offline, so dead-worker workspace reclamation cannot fire and orphaned_count=0 " +
        "is falsely green.",
    });
  }
  noHeartbeatsCounter.add(1, {});
}

/** Lazy-register the observable gauges (the confluence_token_metrics idiom). Idempotent. */
function ensureGaugesRegistered(): void {
  if (gaugesRegistered) return;
  const meter = getMeter(METER_NAME);
  meter
    .createObservableGauge(FAILED_CLEANUP_STUCK_GAUGE_NAME, {
      description:
        "FAILED_CLEANUP workspace leases at/over the cleanup-attempt ceiling — permanently leaked " +
        "disk the reap will never re-drive; operator dead-letter queue.",
    })
    .addCallback((result: ObservableResult) => {
      if (latestFailedCleanupStuck !== null) result.observe(latestFailedCleanupStuck, {});
    });
  meter
    .createObservableGauge(ORPHANED_AGED_GAUGE_NAME, {
      description:
        "ORPHANED workspace leases still un-reaped >24h after allocation — the reap path is not " +
        "converging.",
    })
    .addCallback((result: ObservableResult) => {
      if (latestOrphanedAged !== null) result.observe(latestOrphanedAged, {});
    });
  gaugesRegistered = true;
}

/** Test-only — reset module state between tests. */
export function resetWorkspaceRetentionMetricsForTests(): void {
  latestFailedCleanupStuck = null;
  latestOrphanedAged = null;
  gaugesRegistered = false;
  noHeartbeatsCounter = null;
}
