/**
 * `workspaceRetentionWorkflow` — FAITHFUL 1:1 port of the frozen Python `WorkspaceRetentionWorkflow.run`
 * (vendor/codemaster-py/codemaster/workflows/workspace_retention.py:66-153). Phase 6 spec §10 janitor.
 *
 * A Temporal Schedule fires this every 5 minutes (`overlap=SKIP`, registered at boot via the
 * `ensure_schedule` / `ensureIntervalSchedule` seam the integrator owns — NOT this module). Unlike the
 * single-activity pass-through cron workflows (partition_maintenance / review_run_reaper), this body
 * COMPOSES three activities in sequence per spec §10.1, with a per-id reap loop in the middle:
 *
 *   1. ORPHAN SWEEP — `run_workspace_orphan_sweep_activity`: ALLOCATED leases whose worker is dead
 *      transition to ORPHANED.
 *   2. REAP — `run_workspace_reap_activity` returns the workspace_ids eligible for a release retry; the
 *      body iterates that list and invokes `releaseWorkspace` per id (each retry takes its OWN Temporal
 *      RetryPolicy so one bad reap doesn't poison the whole sweep). Per spec §10.2 the release activity
 *      is the UNIVERSAL cleanup mechanism — this workflow does NOT duplicate cleanup logic.
 *   3. RETENTION PURGE — `run_workspace_released_retention_activity`: hard-delete RELEASED rows past the
 *      retention window.
 *
 * The body returns the three integer counters `{ orphaned, reaped, retention_deleted }` (1:1 with the
 * Python `dict[str, int]` return).
 *
 * ── SCHEDULE CADENCE (for the integrator) ──
 * INTERVAL every 5 minutes (`overlap=SKIP`). The frozen Python pins this in its Schedule helper
 * (`ensure_workspace_retention_schedule`: `ScheduleIntervalSpec(every=timedelta(minutes=5))`,
 * `WORKSPACE_RETENTION_SCHEDULE_ID = "codemaster-workspace-retention"`, task queue "review-default").
 * The integrator wires the Schedule via `ensureIntervalSchedule` in `ensure_schedule.ts` — this module
 * only supplies the workflow body + retry curves.
 *
 * ── EXPORTED NAME ──
 * The exported FUNCTION NAME is the registered Temporal workflow TYPE string — camelCase
 * `workspaceRetentionWorkflow` — because `RealTemporalClient.startWorkflow` dispatches by the registered
 * TS function name (the same convention the reaper / partition-maintenance paths use: camelCase function
 * = workflow type). This diverges from the frozen Python's `@workflow.defn(name="WorkspaceRetentionWorkflow")`
 * PascalCase type string only in casing/topology; the retry curves + activity composition are byte-faithful.
 *
 * ── PROXY METHOD KEYS = REGISTERED ACTIVITY NAMES ──
 * The `proxyActivities<{ ... }>` METHOD KEYS are the REGISTERED Temporal activity names (the keys under
 * which the worker's `activities` map exposes each activity — see worker/build_activities.ts). A key that
 * does not match a registered name dispatches `ActivityNotRegistered`. Two naming families here:
 *
 *   • The three retention activities are keyed by their snake_case Temporal names
 *     (`run_workspace_orphan_sweep_activity` / `run_workspace_reap_activity` /
 *     `run_workspace_released_retention_activity`) — mirroring the Wave-1 cron sweeps
 *     (mutex_janitor_activity / review_run_reaper_activity), which the integrator registers under their
 *     snake_case Temporal names because their workflows proxy them by those exact names.
 *
 *   • The release activity is keyed `releaseWorkspace` (camelCase) — TOPOLOGY DIVERGENCE from the frozen
 *     Python, which dispatches `"release_workspace_activity"` (string name). In this TS port the existing
 *     release activity is registered under the camelCase key `releaseWorkspace` (build_activities.ts:702),
 *     the same key the review_pull_request workflow proxies it by. Keying it `release_workspace_activity`
 *     here would dispatch `ActivityNotRegistered`. The retry curve + per-id fail-open semantics are
 *     byte-faithful; only the dispatch KEY differs (camelCase vs the Python string). Surfaced as a
 *     divergence in the port report.
 *
 * ── SANDBOX SAFETY (ADR-0065 / ADR-0066) ──
 * This module is bundled into the Temporal V8-isolate workflow sandbox. It imports ONLY
 * `@temporalio/workflow` (the sandbox-safe surface) + TYPE-ONLY contract shapes (erased at emit under
 * verbatimModuleSyntax, so NO runtime edge to the crypto-importing contracts module is created). It does
 * NO clock / random / uuid / network / DB work — all non-deterministic work lives behind the typed
 * activity ports. The reap loop is replay-deterministic: it iterates the SORTED workspace_ids the reap
 * activity returned (a stable, content-addressed order), and each `releaseWorkspace` call is idempotent
 * (the activity is globally safe + a re-run reaps only what is still eligible).
 */

import { proxyActivities, log } from "@temporalio/workflow";

import type { ReleaseWorkspaceInput } from "#contracts/release_workspace_input.v1.js";
import type {
  WorkspaceOrphanSweepResultV1,
  WorkspaceReapEligibleResultV1,
  WorkspaceRetentionPurgeResultV1,
} from "#contracts/workspace_retention_result.v1.js";

/**
 * Proxies for the three scheduled retention activities. Retry curve 1:1 with workspace_retention.py:50-54
 * (`_DEFAULT_RETRY`): initial_interval 5 s, maximum_interval 30 s, maximum_attempts 3. The Python also
 * pins start_to_close_timeout 2 min + heartbeat_timeout 30 s per the BF-11 heartbeat window (the
 * activities emit `activity.heartbeat(...)` per query phase / per loop iteration). The TS activity ports
 * are pure-DB sweeps; the heartbeatTimeout is retained 1:1 so a wedged FOR-UPDATE lock / DELETE is
 * redriven within 30 s rather than waiting out the full 2-minute start_to_close.
 */
const {
  run_workspace_orphan_sweep_activity,
  run_workspace_reap_activity,
  run_workspace_released_retention_activity,
} = proxyActivities<{
  run_workspace_orphan_sweep_activity(): Promise<WorkspaceOrphanSweepResultV1>;
  run_workspace_reap_activity(): Promise<WorkspaceReapEligibleResultV1>;
  run_workspace_released_retention_activity(): Promise<WorkspaceRetentionPurgeResultV1>;
}>({
  startToCloseTimeout: "2 minutes",
  heartbeatTimeout: "30 seconds",
  retry: {
    initialInterval: "5 seconds",
    maximumInterval: "30 seconds",
    maximumAttempts: 3,
  },
});

/**
 * Proxy for the universal cleanup activity, invoked per reaped id. Retry curve 1:1 with
 * workspace_retention.py:118-123 (the per-id `workflow.execute_activity("release_workspace_activity", …,
 * retry_policy=_DEFAULT_RETRY)`): start_to_close 2 min, initial_interval 5 s, maximum_interval 30 s,
 * maximum_attempts 3. NOTE (BF-11): NO heartbeatTimeout here on purpose — the Python explicitly EXCLUDES
 * release_workspace_activity from the heartbeat window (single rmtree + state transition; no batched
 * loop), so adding one would force a heartbeat the activity does not emit.
 *
 * KEYED `releaseWorkspace` (camelCase) — the registered key in build_activities.ts — NOT the Python
 * string `"release_workspace_activity"`. See the module header TOPOLOGY DIVERGENCE note.
 */
const { releaseWorkspace } = proxyActivities<{
  releaseWorkspace(input: ReleaseWorkspaceInput): Promise<void>;
}>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "5 seconds",
    maximumInterval: "30 seconds",
    maximumAttempts: 3,
  },
});

/**
 * `workspaceRetentionWorkflow` body. Composes orphan-sweep → reap (per-id release loop) → retention-purge
 * and returns the three integer counters. 1:1 with the frozen Python `WorkspaceRetentionWorkflow.run`.
 */
export async function workspaceRetentionWorkflow(): Promise<{
  orphaned: number;
  reaped: number;
  retention_deleted: number;
}> {
  // Phase 1 — orphan sweep.
  const orphanResult = await run_workspace_orphan_sweep_activity();

  // Phase 2 — reap. The reap activity returns the SORTED workspace_ids; iterate + release each. Each
  // release takes its own RetryPolicy so an individual reap failure doesn't poison the whole sweep.
  const reapResult = await run_workspace_reap_activity();
  let reaped = 0;
  for (const workspaceId of reapResult.workspace_ids) {
    try {
      await releaseWorkspace({ schema_version: 1, workspace_id: workspaceId });
      reaped += 1;
    } catch {
      // Per spec §10.2 the release activity is idempotent + globally safe; a failure here means the lease
      // ended in FAILED_CLEANUP and will be picked up by the next sweep within the cleanup-backoff
      // window. The workflow logs + continues so one bad lease doesn't poison the whole sweep (1:1 with
      // the Python per-id fail-open + workflow.logger.warning).
      log.warn(
        `release_workspace_activity failed for ${workspaceId}; lease left in FAILED_CLEANUP for next sweep`,
      );
      continue;
    }
  }

  // Phase 3 — retention purge.
  const retentionResult = await run_workspace_released_retention_activity();

  return {
    orphaned: orphanResult.orphaned_count,
    reaped,
    retention_deleted: retentionResult.deleted_count,
  };
}
