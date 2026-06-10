import { type Kysely, sql } from "kysely";

import type { Clock } from "#platform/clock.js";
import type { CadenceKind } from "#contracts/scheduled_job.v1.js";

// Phase 3b W3b.1: the cron-migration seed registry — the Postgres analogue of the Temporal
// `ensureCronSchedule` boot seam (worker/ensure_schedule.ts + outbox_dispatcher_main.ts's
// WAVE1_LIVENESS_SCHEDULES). Each entry seeds ONE core.scheduled_jobs row (migration 0040) that the
// W3 SchedulerLoop polls and turns into a core.background_jobs row per tick; the W3b handler
// adapters (handlers/cron_handlers.ts) carry the job_type → activity dispatch.
//
// ## Cadence parity with the Temporal schedules (deliberate cron → interval translation)
// The Python/Temporal Wave-1 schedules use 5-field crons ("*/5 * * * *" / "*/10 * * * *"). The
// Postgres scheduler's cron vocabulary is DAILY-ONLY ("M H * * *" — scheduler.ts::computeNextRun
// throws on step expressions BY DESIGN), so the every-N-minutes cadences land as
// cadence_kind 'interval' (cadence_spec = seconds): 300 = every 5min, 600 = every 10min. The only
// semantic drift is wall-alignment (interval ticks run N seconds after the previous enqueue rather
// than at :00/:05 boundaries) — irrelevant for liveness backstops. overlap=SKIP falls out of the
// platform's dedup_key = schedule_id (at most one ACTIVE job per schedule), 1:1 with the Temporal
// `ScheduleOverlapPolicy.SKIP` these schedules carried.
//
// ## schedule_id continuity
// The schedule_ids are byte-identical to the Temporal schedule ids ("codemaster-mutex-janitor" /
// "codemaster-review-run-reaper") so operators correlate the migrated cadence with the Temporal
// schedule it replaces (Phase 4 deletes the Temporal side; until then BOTH fire — safe, because both
// sweeps are idempotent + FOR UPDATE SKIP LOCKED, and the platform side stays COLD until the
// background-runner process is actually booted).

/** One seeded schedule row. snake_case mirrors the core.scheduled_jobs columns (migration 0040). */
export type CronScheduleSeed = {
  readonly schedule_id: string;
  readonly job_type: string;
  readonly cadence_kind: CadenceKind;
  readonly cadence_spec: string;
  /** The stored `input` JSONB the scheduler copies into each tick's job payload. The Wave-1 interval
   *  crons are ZERO-CONFIG (`{}`) — 1:1 with their Temporal workflows' zero-arg activity dispatch. */
  readonly input: Record<string, unknown>;
};

/**
 * The cron-migration registry. Phase 3b waves append entries here as workflows migrate off Temporal
 * Schedules; every entry's `job_type` MUST have a matching `registerCronHandlers` registration
 * (handlers/cron_handlers.ts) or a fired tick dead-letters as `no handler for <job_type>`.
 */
export const CRON_SCHEDULES: ReadonlyArray<CronScheduleSeed> = [
  {
    schedule_id: "codemaster-mutex-janitor",
    job_type: "mutex_janitor",
    cadence_kind: "interval",
    cadence_spec: "300", // every 5 minutes — parity with the Temporal "*/5 * * * *" schedule
    input: {},
  },
  {
    schedule_id: "codemaster-review-run-reaper",
    job_type: "review_run_reaper",
    cadence_kind: "interval",
    cadence_spec: "600", // every 10 minutes — parity with the Temporal "*/10 * * * *" schedule
    input: {},
  },
];

/**
 * Idempotently seed every {@link CRON_SCHEDULES} row into core.scheduled_jobs. `ON CONFLICT
 * (schedule_id) DO NOTHING` mirrors `ensureCronSchedule`'s swallow-`ScheduleAlreadyRunning`
 * idempotency: an existing row — possibly operator-paused (`enabled = false`) or re-cadenced — is
 * NEVER clobbered, and its `next_run_at` is never reset. A first insert stamps
 * `next_run_at = clock.now()` so the new schedule fires on the scheduler's next poll rather than
 * waiting out a full cadence interval. Cadence changes to an EXISTING row are an operator edit
 * (UPDATE core.scheduled_jobs), the same posture as `tctl schedule update` on the Temporal side.
 *
 * core.scheduled_jobs is PLATFORM-GLOBAL (no installation_id column — schedules are operator-owned
 * platform cadences, not tenant data), so no tenancy filter applies — same as scheduler.ts.
 */
export async function ensureScheduledJobs(db: Kysely<unknown>, clock: Clock): Promise<void> {
  for (const s of CRON_SCHEDULES) {
    await sql`INSERT INTO core.scheduled_jobs
        (schedule_id, job_type, cadence_kind, cadence_spec, input, next_run_at)
      VALUES (${s.schedule_id}, ${s.job_type}, ${s.cadence_kind}, ${s.cadence_spec},
              CAST(${JSON.stringify(s.input)} AS jsonb), ${clock.now()})
      ON CONFLICT (schedule_id) DO NOTHING`.execute(db);
  }
}
