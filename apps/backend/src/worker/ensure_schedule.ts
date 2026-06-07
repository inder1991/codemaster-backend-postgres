/**
 * Shared Temporal Schedule-bootstrap seam (ADR-0074).
 *
 * The TS port's analogue of the Python `ensure_<name>_schedule(client)` helpers (e.g.
 * vendor/codemaster-py/codemaster/workflows/mutex_janitor.py::ensure_mutex_janitor_schedule). It
 * idempotently creates a cron-driven Temporal Schedule that starts a workflow on a task queue, with
 * `overlap=SKIP` so a slow sweep never fans out, and **swallows `ScheduleAlreadyRunning`** so a
 * concurrent pod / redeploy never clobbers operator tuning (e.g. a schedule paused for an incident).
 *
 * ## Boot-time, OUTSIDE the workflow sandbox
 * `@temporalio/client` is sandbox-illegal (ADR-0065), so this module is imported ONLY by the worker
 * boot path (`outbox_dispatcher_main.ts`), never by a `*.workflow.ts` module bundled into the V8
 * isolate. Mirrors `ensureOutboxDispatcherSingleton`'s placement.
 *
 * 13 of the 20 unported Python workflows are cron-driven and reuse this seam (ADR-0074); Wave 1 lands
 * the mutex-janitor + review-run-reaper liveness backstops on it.
 */

import { ScheduleAlreadyRunning, ScheduleOverlapPolicy } from "@temporalio/client";
import type { ScheduleOptions } from "@temporalio/client";

/** The literal config a single cron schedule needs. Cadence + ids are byte-faithful with the Python. */
export type EnsureCronScheduleArgs = {
  /** Stable Temporal schedule id, e.g. "codemaster-mutex-janitor" (never recreated once it exists). */
  readonly scheduleId: string;
  /** The registered workflow TYPE to start = the exported TS workflow fn name (e.g. "mutexJanitorWorkflow"). */
  readonly workflowType: string;
  /** The started-workflow id (Python uses `${scheduleId}-workflow`). */
  readonly workflowId: string;
  /** The task queue the workflow is registered on (Wave 1: "review-default"). */
  readonly taskQueue: string;
  /** A 5-field cron expression (e.g. the every-5-minutes form used by the mutex janitor). */
  readonly cronExpression: string;
};

/**
 * The literal config a single INTERVAL schedule needs (the Confluence Wave-4 analogue of
 * {@link EnsureCronScheduleArgs}). The Python Confluence workflows use
 * `ScheduleIntervalSpec(every=timedelta(hours=6|24))` — an interval cadence, NOT a cron expression —
 * so the Temporal `spec` is `{ intervals: [{ every }] }` instead of `{ cronExpressions: [...] }`.
 * Everything else (overlap=SKIP, startWorkflow action, the swallow-`ScheduleAlreadyRunning` idempotency)
 * is identical to the cron seam.
 */
export type EnsureIntervalScheduleArgs = {
  /** Stable Temporal schedule id, e.g. "refresh-confluence-corpus" (never recreated once it exists). */
  readonly scheduleId: string;
  /** The registered workflow TYPE to start = the exported TS workflow fn name (e.g. "confluenceIngestWorkflow"). */
  readonly workflowType: string;
  /** The started-workflow id (Python uses `${scheduleId}-workflow`). */
  readonly workflowId: string;
  /** The task queue the workflow is registered on (Wave 4 combined-pod: "review-default"). */
  readonly taskQueue: string;
  /** The interval cadence, in SECONDS (e.g. 21600 = 6h, 86400 = 24h). */
  readonly intervalSeconds: number;
  /**
   * The single positional input the started workflow receives. The Python schedule actions pass a
   * DEFAULT-CONSTRUCTED input object (`args=[RefreshConfluenceInputV1()]` / `[MarkStaleChunksInputV1()]`),
   * NOT an empty list — a fired schedule that started the workflow with no arg would hand the activity
   * `undefined`, and `MarkStaleChunksInputV1.parse(undefined)` THROWS (a Zod `.default()` only fills a
   * missing KEY in a PRESENT object, not `undefined`), retrying forever. So this MUST carry the default
   * input (e.g. `{ schema_version: 1 }`).
   */
  readonly actionInput: Record<string, unknown>;
};

/**
 * The narrow slice of `@temporalio/client` `Client` this seam needs — `client.schedule.create(...)`.
 * Structural (not the full `Client`) so the helper is unit-testable with a mock and does NOT widen the
 * `RealTemporalClient` port surface. The real `Client` satisfies it (its `schedule.create` returns a
 * `ScheduleHandle`, which has a `scheduleId: string`).
 */
export type ScheduleCreatingClient = {
  readonly schedule: {
    create(options: ScheduleOptions): Promise<{ scheduleId: string }>;
  };
};

/**
 * Idempotently create a cron Temporal Schedule. No-op (returns) if it already exists; any OTHER error
 * propagates to the fail-open boot caller (which logs + continues so the worker still comes up).
 */
export async function ensureCronSchedule(
  client: ScheduleCreatingClient,
  args: EnsureCronScheduleArgs,
): Promise<void> {
  try {
    await client.schedule.create({
      scheduleId: args.scheduleId,
      spec: { cronExpressions: [args.cronExpression] },
      action: {
        type: "startWorkflow",
        workflowType: args.workflowType,
        taskQueue: args.taskQueue,
        workflowId: args.workflowId,
        args: [],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
    });
  } catch (err) {
    if (err instanceof ScheduleAlreadyRunning) {
      // Idempotent: another pod already created this schedule. Don't overwrite — operator tuning would
      // be clobbered. If the cadence needs to change, an operator runs `tctl schedule update`. (Python:
      // ensure_mutex_janitor_schedule swallows ScheduleAlreadyRunningError identically.)
      return;
    }
    throw err;
  }
}

/**
 * Idempotently create an INTERVAL Temporal Schedule (the Confluence Wave-4 analogue of
 * {@link ensureCronSchedule}). No-op (returns) if it already exists; any OTHER error propagates to the
 * fail-open boot caller (which logs + continues so the worker still comes up).
 *
 * The Python `ScheduleIntervalSpec(every=timedelta(hours=6))` maps to the SDK `IntervalSpec.every`, a
 * `Duration`. A numeric `Duration` is interpreted as MILLISECONDS by the SDK, so `intervalSeconds` is
 * converted to ms (`intervalSeconds * 1000`). `overlap=SKIP` mirrors the Python `overlap=SKIP` so a slow
 * 6h corpus sync that overruns its window never fans a second sync out concurrently.
 */
export async function ensureIntervalSchedule(
  client: ScheduleCreatingClient,
  args: EnsureIntervalScheduleArgs,
): Promise<void> {
  try {
    await client.schedule.create({
      scheduleId: args.scheduleId,
      spec: { intervals: [{ every: args.intervalSeconds * 1000 }] },
      action: {
        type: "startWorkflow",
        workflowType: args.workflowType,
        taskQueue: args.taskQueue,
        workflowId: args.workflowId,
        // Pass the default-constructed input (NOT [] — see EnsureIntervalScheduleArgs.actionInput). 1:1
        // with the Python `args=[RefreshConfluenceInputV1()]` / `[MarkStaleChunksInputV1()]`.
        args: [args.actionInput],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
    });
  } catch (err) {
    if (err instanceof ScheduleAlreadyRunning) {
      // Idempotent: another pod already created this schedule. Don't overwrite operator tuning (e.g. a
      // schedule paused for an incident). (Python: ensure_*_schedule swallows ScheduleAlreadyRunningError.)
      return;
    }
    throw err;
  }
}
