import { z } from "zod";

import { MarkStaleChunksActivity } from "#backend/activities/mark_stale_chunks.activity.js";
import { mutexJanitorActivity } from "#backend/activities/mutex_janitor.activity.js";
import { runPgPartmanMaintenanceActivity } from "#backend/activities/partition_maintenance.activity.js";
import { reviewRunReaperActivity } from "#backend/activities/review_run_reaper.activity.js";

import { MarkStaleChunksInputV1 } from "#contracts/confluence_sync_stale.v1.js";

import type { HandlerRegistry } from "../handler_registry.js";

// Phase 3b W3b.1 + W3b.2: job_type → handler ADAPTERS for the 4 crons migrated off Temporal
// Schedules — the 2 INTERVAL crons (mutex_janitor every 5min + review_run_reaper every 10min) and
// the 2 DAILY crons (mark_stale_chunks + partition_maintenance, both 02:00 UTC). Each adapter is a
// thin JobHandler shim over the EXISTING, tested activity body (apps/backend/src/activities/*) —
// the activity logic is NOT rewritten here; this is the de-Temporal analogue of the workflow
// pass-through bodies (mutex_janitor.workflow.ts / review_run_reaper.workflow.ts /
// mark_stale_chunks.workflow.ts / partition_maintenance.workflow.ts), which stay in place until
// Phase 4 deletes the Temporal side.
//
// ## Input contracts (handler-owned parsing — the W2b opaque-payload posture)
// The Temporal workflows dispatch their activities zero-arg or with the empty marker input (the
// activities resolve DSN / thresholds / clock at the activity boundary), so every scheduled `input`
// is `{}` and each cron input contract is STRICT: the interval pair + partition_maintenance parse a
// strict empty object; mark_stale_chunks parses the REAL `MarkStaleChunksInputV1` (the ADR-0047
// single-typed-input marker — `.strict()` with only the defaulted `schema_version`), exactly what
// the Temporal workflow threads through. Strict-fail-loud over silently-ignore: an operator who
// edits core.scheduled_jobs.input expecting an effect gets a parse error surfaced through the job's
// last_error/dead_reason (taxonomy-governance posture) instead of a no-op. Widening an input
// (e.g. a reaper stale-threshold override) is a deliberate contract change here, not payload drift.
//
// ## Result handling
// The handlers return void — the platform persists job OUTCOME (done/failed/dead), not activity
// results. Each sweep's tally is logged (the Temporal-side analogue was the workflow result payload,
// equally consumed by nobody but observability).
//
// ## Cancellation (`signal`) posture
// All four sweeps are single-transaction, idempotent (FOR UPDATE SKIP LOCKED / CTE UPDATE
// WHERE-guarded / pg_partman's own re-runnable maintenance), with NO internal await seam to abort
// between — so the adapters deliberately do not thread `signal`. A lease-lost duplicate dispatch
// re-sweeping is harmless by construction.

/** mutex_janitor scheduled input — zero-config, 1:1 with the Temporal zero-arg dispatch. */
const MutexJanitorCronInputV1 = z.object({}).strict();

/** review_run_reaper scheduled input — zero-config; the stale threshold stays env-resolved
 *  (`CODEMASTER_REVIEW_RUN_REAPER_STALE_AFTER_SECONDS`, ADR-0074) at the activity boundary. */
const ReviewRunReaperCronInputV1 = z.object({}).strict();

/** partition_maintenance scheduled input — zero-config, 1:1 with the Temporal zero-arg dispatch
 *  (the activity's only parameter is its DSN deps, a composition concern — not caller input). */
const PartitionMaintenanceCronInputV1 = z.object({}).strict();

/**
 * Composition-root collaborators the cron adapters close over (the buildActivities idiom). The W3b.2
 * daily pair landed needing only the same dsn seam (MarkStaleChunksActivity is constructed over it at
 * registration; runPgPartmanMaintenanceActivity threads it as deps); grows as later Phase 3b waves
 * land handlers that need richer constructed services.
 */
export type CronHandlersDeps = {
  /** OPTIONAL DSN override threaded into each activity (integration tests inject the disposable
   *  :5434 DSN explicitly). Omitted in prod — each activity self-resolves `CODEMASTER_PG_CORE_DSN`
   *  exactly as it does under its Temporal zero-arg dispatch. */
  readonly dsn?: string;
};

/**
 * Register the W3b.1 + W3b.2 cron handlers on the runner's registry. Called ONCE at the composition root
 * ({@link import("../background_runner_main.js").buildBackgroundRunner}); HandlerRegistry.register
 * throws on duplicates, so double-wiring fails loud at boot.
 *
 * Each adapter: parse the verified payload with its OWN contract → run the existing activity body
 * (clock threaded from the runner's HandlerDeps — the Clock seam; DSN from `deps.dsn` or the
 * activity's env resolution) → log the sweep tally. A parse/activity throw propagates to the runner,
 * which settles the attempt failed (markFailed: backoff re-enqueue, then dead at exhaustion) — the
 * platform's analogue of the Temporal retry curve those workflows carried.
 */
export function registerCronHandlers(registry: HandlerRegistry, deps: CronHandlersDeps = {}): void {
  registry.register("mutex_janitor", async (payload, _signal, handlerDeps) => {
    MutexJanitorCronInputV1.parse(payload);
    const result = await mutexJanitorActivity({
      ...(deps.dsn !== undefined ? { dsn: deps.dsn } : {}),
      clock: handlerDeps.clock,
    });
    console.info(
      `mutex_janitor swept: scanned=${result.scanned} swept=${result.swept} job_id=${handlerDeps.job.job_id}`,
    );
  });

  registry.register("review_run_reaper", async (payload, _signal, handlerDeps) => {
    ReviewRunReaperCronInputV1.parse(payload);
    const result = await reviewRunReaperActivity({
      ...(deps.dsn !== undefined ? { dsn: deps.dsn } : {}),
      clock: handlerDeps.clock,
    });
    console.info(
      `review_run_reaper swept: scanned=${result.scanned} reaped=${result.reaped} job_id=${handlerDeps.job.job_id}`,
    );
  });

  // W3b.2: the 2 daily crons. MarkStaleChunksActivity is a CLASS (bound-method holder) — construct
  // it ONCE at registration over the same optional dsn override, exactly as build_activities.ts does
  // for the Temporal worker (`new MarkStaleChunksActivity({ dsn })` + `.markStaleChunks.bind(...)`);
  // neither daily activity takes a clock (both stamp via the DB `now()`, 1:1 with the frozen Python).
  const markStaleChunksActivity = new MarkStaleChunksActivity(
    deps.dsn !== undefined ? { dsn: deps.dsn } : {},
  );
  registry.register("mark_stale_chunks", async (payload, _signal, handlerDeps) => {
    const input = MarkStaleChunksInputV1.parse(payload);
    const result = await markStaleChunksActivity.markStaleChunks(input);
    console.info(
      `mark_stale_chunks swept: default=${result.chunks_marked_stale_default} ` +
        `security_policy=${result.chunks_marked_stale_security_policy} job_id=${handlerDeps.job.job_id}`,
    );
  });

  registry.register("partition_maintenance", async (payload, _signal, handlerDeps) => {
    PartitionMaintenanceCronInputV1.parse(payload);
    // dsn resolution order inside the activity: injected → CODEMASTER_PG_MAINT_DSN → CODEMASTER_PG_CORE_DSN.
    const result = await runPgPartmanMaintenanceActivity(
      deps.dsn !== undefined ? { dsn: deps.dsn } : {},
    );
    console.info(
      `partition_maintenance ran: tables_processed=${result.tables_processed} ` +
        `partitions_created=${result.partitions_created} job_id=${handlerDeps.job.job_id}`,
    );
  });
}
