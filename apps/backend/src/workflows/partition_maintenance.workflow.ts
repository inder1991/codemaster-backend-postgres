/**
 * `partitionMaintenanceWorkflow` — FAITHFUL 1:1 port of the frozen Python `PartitionMaintenanceWorkflow.run`
 * (vendor/codemaster-py/codemaster/workflows/partition_maintenance.py:33-52). Sprint 3 / S3.1.7.
 *
 * A daily Temporal Schedule fires this at 02:00 UTC (registered at boot via the `ensureCronSchedule` /
 * `ensure_schedule` seam the integrator owns — NOT this module). It is a single-activity PASS-THROUGH:
 * it proxies the registered `run_pg_partman_maintenance` activity by name, applies the EXACT retry curve
 * transcribed from the Python `RetryPolicy(...)` (start_to_close 15 min, initial_interval 30 s,
 * maximum_attempts 3, no non-retryable types), and returns the activity result verbatim.
 *
 * ── SCHEDULE CADENCE (for the integrator) ──
 * Daily at 02:00 UTC — cron `0 2 * * *`. The frozen Python pins the cadence in its Schedule helper
 * (PARTITION_MAINTENANCE_SCHEDULE_ID = "codemaster-partition-maintenance", daily 02:00 UTC; task queue
 * "partition-maintenance"). The integrator wires the Schedule in `ensure_schedule.ts` — this module only
 * supplies the workflow body + retry curve.
 *
 * ── EXPORTED NAME ──
 * The exported FUNCTION NAME is the registered Temporal workflow TYPE string — camelCase
 * `partitionMaintenanceWorkflow` — because `RealTemporalClient.startWorkflow` dispatches by the registered
 * TS function name (the same convention the reaper/reconcile paths use: camelCase function = workflow
 * type). This diverges from the frozen Python's `@workflow.defn(name="PartitionMaintenanceWorkflow")`
 * PascalCase type string only in casing/topology; the retry curve + activity body are byte-faithful.
 *
 * ── PROXY METHOD KEY = REGISTERED ACTIVITY NAME ──
 * The `proxyActivities<{ run_pg_partman_maintenance(): … }>` METHOD KEY is the REGISTERED Temporal activity
 * name (the key under which the worker's `activities` map exposes the activity — see
 * worker/build_activities.ts). A key that does not match a registered name dispatches
 * `ActivityNotRegistered`. We therefore key the proxy by the snake_case `run_pg_partman_maintenance`
 * string the worker registers the activity under. The activity takes NO workflow-supplied input (it
 * resolves its DSN from the environment at the activity boundary), 1:1 with the Python
 * `workflow.execute_activity(run_pg_partman_maintenance, …)` zero-arg dispatch.
 *
 * ── SANDBOX SAFETY (ADR-0065 / ADR-0066) ──
 * This module is bundled into the Temporal V8-isolate workflow sandbox. It imports ONLY
 * `@temporalio/workflow` (the sandbox-safe surface) + a TYPE-ONLY contract shape (erased at emit under
 * verbatimModuleSyntax, so NO runtime edge to the crypto-importing contracts module is created). It does
 * NO clock / random / uuid / network / DB work — all non-deterministic work lives behind the typed
 * activity port.
 */

import { proxyActivities } from "@temporalio/workflow";

import type { PartitionMaintenanceResultV1 } from "#contracts/partition_maintenance_result.v1.js";

/**
 * Proxy for `run_pg_partman_maintenance`. Retry curve 1:1 with partition_maintenance.py:43-50:
 * start_to_close 15 min, initial_interval 30 s, maximum_attempts 3, non_retryable_error_types=[] (no
 * non-retryable set — a transient DB/pool fault SHOULD redrive within the 3-attempt envelope; a clean
 * return commits the maintenance result).
 */
const { run_pg_partman_maintenance } = proxyActivities<{
  run_pg_partman_maintenance(): Promise<PartitionMaintenanceResultV1>;
}>({
  startToCloseTimeout: "15 minutes",
  retry: {
    initialInterval: "30 seconds",
    maximumAttempts: 3,
  },
});

/**
 * `partitionMaintenanceWorkflow` body. Single-activity pass-through; returns the
 * PartitionMaintenanceResultV1 verbatim. Replay-deterministic by construction (the activity's
 * count → run_maintenance → recount is idempotent — pg_partman creates only the partitions still missing
 * from the premake window and drops only those past the retention window).
 */
export async function partitionMaintenanceWorkflow(): Promise<PartitionMaintenanceResultV1> {
  return run_pg_partman_maintenance();
}
