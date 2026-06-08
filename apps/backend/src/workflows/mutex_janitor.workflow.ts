/**
 * `mutexJanitorWorkflow` — FAITHFUL 1:1 port of the frozen Python workflow body
 * `MutexJanitorWorkflow.run` (vendor/codemaster-py/codemaster/workflows/mutex_janitor.py:31-42).
 *
 * A Temporal Schedule fires this every 5 minutes (`overlap=SKIP`); it is a LIVENESS BACKSTOP that reclaims
 * `core.pr_review_mutex` rows whose review process died before release could run (worker OOM / pod
 * eviction / terminate). Pre-2026-06-03 no schedule was ever created — the workflow was registered but
 * never fired, so 37 rows leaked unreclaimed in 9 days (ADR-0064). The body is a PURE PASS-THROUGH: it
 * proxies the single `mutex_janitor_activity` and returns its result verbatim.
 *
 * The retry curve is transcribed EXACTLY from the Python `RetryPolicy`: start_to_close 10min,
 * initial_interval 15s, maximum_attempts 3.
 *
 * ── REGISTERED-NAME DECISION (combined-pod worker, matching reconcile.workflow.ts) ──
 * `RealTemporalClient.startWorkflow` / the schedule action dispatch by the registered TS function name, so
 * the EXPORTED FUNCTION NAME is the registered Temporal workflow TYPE string — camelCase `mutexJanitorWorkflow`
 * (NOT the Python PascalCase `MutexJanitorWorkflow` class name). The `proxyActivities` METHOD KEY is the
 * REGISTERED Temporal activity name `mutex_janitor_activity` (the key the worker exposes the activity under).
 *
 * ── SANDBOX SAFETY (ADR-0065 / ADR-0066) ──
 * This module is bundled into the Temporal V8-isolate workflow sandbox. It imports ONLY `proxyActivities`
 * from `@temporalio/workflow` (the sandbox-safe surface) + a TYPE-ONLY contract shape (erased at emit under
 * verbatimModuleSyntax, so NO runtime edge to the crypto-importing contracts is created). It does NO clock /
 * random / uuid / network / DB work — all non-deterministic work lives behind the typed activity port.
 */

import { proxyActivities } from "@temporalio/workflow";

import type { MutexJanitorResultV1 } from "#contracts/mutex_janitor_result.v1.js";

/**
 * Proxy for `mutex_janitor_activity`. Retry curve 1:1 with mutex_janitor.py:35-42:
 * start_to_close 10min, initial_interval 15s, maximum_attempts 3.
 */
const { mutex_janitor_activity } = proxyActivities<{
  mutex_janitor_activity(): Promise<MutexJanitorResultV1>;
}>({
  startToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "15 seconds",
    maximumAttempts: 3,
  },
});

/**
 * `mutexJanitorWorkflow` workflow body. Single-activity pass-through; returns the activity result verbatim.
 */
export async function mutexJanitorWorkflow(): Promise<MutexJanitorResultV1> {
  return mutex_janitor_activity();
}
