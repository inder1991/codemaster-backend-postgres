/**
 * `markStaleChunksWorkflow` — FAITHFUL 1:1 port of the frozen Python workflow body
 * `MarkStaleChunksWorkflow.run` + the schedule constants / helper
 * (vendor/codemaster-py/codemaster/workflows/mark_stale_chunks_workflow.py).
 *
 * A 24h Temporal Schedule (`overlap=SKIP`) flips page_status active → stale when chunks age past the
 * operator-tunable thresholds (spec §3.6). The body is a PURE PASS-THROUGH: it proxies the single
 * `mark_stale_chunks_activity` and returns its result verbatim. The thresholds + SQL live in the activity
 * (replay-safe).
 *
 * ── REGISTERED-NAME DECISION (combined-pod worker, matching mutex_janitor.workflow.ts) ──
 * The EXPORTED FUNCTION NAME is the registered Temporal workflow TYPE string — camelCase
 * `markStaleChunksWorkflow` (NOT the Python PascalCase class name; that string is preserved as
 * `MARK_STALE_CHUNKS_WORKFLOW_TYPE` for the Stage-8 schedule action). The `proxyActivities` METHOD KEY is
 * the REGISTERED snake_case Temporal activity name `mark_stale_chunks_activity`.
 *
 * ── SANDBOX SAFETY (ADR-0065 / ADR-0066) ──
 * Bundled into the Temporal V8-isolate workflow sandbox. Imports ONLY `proxyActivities` from
 * `@temporalio/workflow` + a TYPE-ONLY contract shape (erased at emit). No clock / random / uuid / crypto
 * / DB / network / node:* work. The schedule CONSTANTS are exported as plain string / number values so the
 * Stage-8 boot file builds the Schedule WITHOUT this sandbox module importing the Temporal client package.
 */

import { proxyActivities } from "@temporalio/workflow";

import type {
  MarkStaleChunksInputV1,
  MarkStaleChunksOutputV1,
} from "#contracts/confluence_sync_stale.v1.js";

// ── Schedule constants (Stage-8 boot file imports these; NO Temporal-client edge here) ──
export const MARK_STALE_CHUNKS_SCHEDULE_ID = "mark-stale-confluence-chunks";
export const MARK_STALE_CHUNKS_TASK_QUEUE = "confluence-sync";
export const MARK_STALE_CHUNKS_WORKFLOW_TYPE = "MarkStaleChunksWorkflow";
/** Schedule fires every 24 hours (Python: ScheduleIntervalSpec(every=timedelta(hours=24))). Seconds. */
export const MARK_STALE_CHUNKS_INTERVAL_SECONDS = 24 * 60 * 60;

/**
 * Proxy for `mark_stale_chunks_activity`. Retry curve 1:1 with mark_stale_chunks_workflow.py:42-47:
 * start_to_close 10min. The Python call passes NO explicit retry_policy → Temporal's default retry
 * policy applies (unbounded retries with exponential backoff); the TS proxy likewise omits `retry` so the
 * SDK default policy is used — a faithful 1:1 of the Python (which also relied on the SDK default).
 */
const { mark_stale_chunks_activity } = proxyActivities<{
  mark_stale_chunks_activity(input: MarkStaleChunksInputV1): Promise<MarkStaleChunksOutputV1>;
}>({
  startToCloseTimeout: "10 minutes",
});

/**
 * `markStaleChunksWorkflow` workflow body. Single-activity pass-through; returns the activity result
 * verbatim. 1:1 with MarkStaleChunksWorkflow.run (the input is threaded straight to the activity).
 */
export async function markStaleChunksWorkflow(
  input: MarkStaleChunksInputV1,
): Promise<MarkStaleChunksOutputV1> {
  return mark_stale_chunks_activity(input);
}
