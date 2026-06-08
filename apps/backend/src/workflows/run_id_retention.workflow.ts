/**
 * `runIdRetentionWorkflow` — FAITHFUL 1:1 port of the frozen Python `RunIdRetentionWorkflow.run`
 * (vendor/codemaster-py/codemaster/workflows/run_id_retention.py). Phase 5 of the run_id
 * execution-causality refactor.
 *
 * A daily Temporal Schedule fires this at 03:00 UTC (`overlap=SKIP`). It composes THREE retention
 * sweeps SEQUENTIALLY (close → retire → delete) with bounded retries, returning the composite
 * {@link RunIdRetentionResultV1} so the Schedule operator dashboard can show per-sweep totals at a glance:
 *
 *   1. `run_id_close_stale_prs`   — close ephemeral smoke PRs older than `prTtlDays`   (20-min STC).
 *   2. `run_id_retire_old_runs`   — soft-delete terminal review_runs older than `runTtlDays`  (10-min STC).
 *   3. `run_id_delete_old_events` — hard-delete workflow_events older than `eventTtlDays`     (30-min STC).
 *
 * If any sweep fails after retries, the workflow surfaces the failure (Temporal's standard failure
 * semantics) — 1:1 with the Python (which lets the FAILED-terminal handler observe the workflow failure).
 *
 * ── TTL ARGS (workflow input, pinned at Schedule registration — 1:1 with Python `args=[7, 30, 90]`) ──
 * The Python `run(pr_ttl_days, run_ttl_days, event_ttl_days)` takes the three TTLs as positional args
 * injected at Schedule registration time. The TS body takes them as a single typed input object (the
 * Temporal-TS idiom — one positional workflow arg) and threads each into the matching activity proxy.
 * The integrator's `ensureCronSchedule` supplies `{ prTtlDays: 7, runTtlDays: 30, eventTtlDays: 90 }`.
 *
 * ── REGISTERED-NAME DECISION (combined-pod worker, matching mutex_janitor / review_run_reaper) ──
 * The EXPORTED FUNCTION NAME is the registered Temporal workflow TYPE string — camelCase
 * `runIdRetentionWorkflow` (NOT the Python PascalCase class name; that string is preserved as
 * {@link RUN_ID_RETENTION_WORKFLOW_TYPE} for the schedule action). Each `proxyActivities` METHOD KEY is
 * the REGISTERED snake_case Temporal activity name the worker registers the activity under — a key that
 * doesn't match a registered name dispatches `ActivityNotRegistered`.
 *
 * ── RETRY CURVE (1:1 with the Python `_DEFAULT_RETRY`) ──
 * initial_interval 15s, maximum_interval 2min, maximum_attempts 3 — applied to all three proxies.
 * Per-activity `startToCloseTimeout` transcribed from the Python (20 / 10 / 30 min). The Python's
 * `heartbeat_timeout=30s` is NOT transcribed: the TS activity ports run as single short transactions /
 * bounded batch loops and do NOT emit `activity.heartbeat(...)` (the batch-progress heartbeats were a
 * Python forensic affordance, not a correctness contract); omitting the heartbeat_timeout means a stall
 * is caught by the start_to_close_timeout instead. Divergence surfaced in the report.
 *
 * ── SANDBOX SAFETY (ADR-0065 / ADR-0066) ──
 * Bundled into the Temporal V8-isolate workflow sandbox. Imports ONLY `proxyActivities` from
 * `@temporalio/workflow` + a TYPE-ONLY contract shape (erased at emit under verbatimModuleSyntax, so NO
 * runtime edge to the crypto-importing contracts module). NO clock / random / uuid / network / DB work —
 * all non-deterministic work lives behind the typed activity ports.
 */

import { proxyActivities } from "@temporalio/workflow";

import type {
  EventsRetentionResultV1,
  RunIdRetentionResultV1,
  RunsRetentionResultV1,
  StalePrCloserResultV1,
} from "#contracts/retention.v1.js";

// ── Schedule constants (the integrator's boot file imports these; NO Temporal-client edge here) ──
/** Registered Temporal workflow TYPE string (Python `RUN_ID_RETENTION_WORKFLOW_TYPE`). */
export const RUN_ID_RETENTION_WORKFLOW_TYPE = "RunIdRetentionWorkflow";
/** Schedule id (Python `RUN_ID_RETENTION_SCHEDULE_ID`). */
export const RUN_ID_RETENTION_SCHEDULE_ID = "codemaster-run-id-retention";
/** Task queue the started workflow lands on (Python `RUN_ID_RETENTION_TASK_QUEUE`). */
export const RUN_ID_RETENTION_TASK_QUEUE = "review-default";
/** Cron cadence — daily at 03:00 UTC (Python `ScheduleSpec(cron_expressions=["0 3 * * *"])`). */
export const RUN_ID_RETENTION_CRON = "0 3 * * *";
/** Default TTL args pinned at Schedule registration (Python `args=[7, 30, 90]`). */
export const RUN_ID_RETENTION_DEFAULT_INPUT: RunIdRetentionInput = {
  prTtlDays: 7,
  runTtlDays: 30,
  eventTtlDays: 90,
};

/**
 * Workflow input — the three retention TTLs (in days), pinned at Schedule registration. 1:1 with the
 * Python positional args `(pr_ttl_days, run_ttl_days, event_ttl_days)`, packaged as one positional
 * object per the Temporal-TS one-arg idiom.
 */
export type RunIdRetentionInput = {
  /** Ephemeral-PR closer TTL (Python `pr_ttl_days`, default 7). */
  prTtlDays: number;
  /** Run-retire TTL (Python `run_ttl_days`, default 30). */
  runTtlDays: number;
  /** Event-delete TTL (Python `event_ttl_days`, default 90). */
  eventTtlDays: number;
};

/** Shared retry curve — 1:1 with the Python `_DEFAULT_RETRY`. */
const RETRY = {
  initialInterval: "15 seconds",
  maximumInterval: "2 minutes",
  maximumAttempts: 3,
} as const;

/** Proxy for `run_id_close_stale_prs` (20-min STC, 1:1 with the Python). */
const { run_id_close_stale_prs } = proxyActivities<{
  run_id_close_stale_prs(ttlDays: number): Promise<StalePrCloserResultV1>;
}>({ startToCloseTimeout: "20 minutes", retry: RETRY });

/** Proxy for `run_id_retire_old_runs` (10-min STC, 1:1 with the Python). */
const { run_id_retire_old_runs } = proxyActivities<{
  run_id_retire_old_runs(ttlDays: number): Promise<RunsRetentionResultV1>;
}>({ startToCloseTimeout: "10 minutes", retry: RETRY });

/** Proxy for `run_id_delete_old_events` (30-min STC, 1:1 with the Python). */
const { run_id_delete_old_events } = proxyActivities<{
  run_id_delete_old_events(ttlDays: number): Promise<EventsRetentionResultV1>;
}>({ startToCloseTimeout: "30 minutes", retry: RETRY });

/**
 * `runIdRetentionWorkflow` body. Executes the three sweeps SEQUENTIALLY (close → retire → delete) and
 * aggregates their results into the composite {@link RunIdRetentionResultV1}. 1:1 with the Python
 * `RunIdRetentionWorkflow.run`. Replay-deterministic by construction (each activity's sweep is
 * idempotent — a re-run touches only what is still aged/unretired).
 */
export async function runIdRetentionWorkflow(
  input: RunIdRetentionInput,
): Promise<RunIdRetentionResultV1> {
  const prCloser = await run_id_close_stale_prs(input.prTtlDays);
  const runs = await run_id_retire_old_runs(input.runTtlDays);
  const events = await run_id_delete_old_events(input.eventTtlDays);

  return {
    schema_version: 1,
    pr_closer: prCloser,
    runs,
    events,
  };
}
