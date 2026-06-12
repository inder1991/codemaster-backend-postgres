-- 0040_scheduled_jobs.sql — Phase 3a Wave 1 (de-Temporal full-removal program, 2026-06-10):
-- core.scheduled_jobs, the Postgres scheduler rows replacing Temporal Schedules. One row per
-- schedule. The Wave-3 scheduler loop (a leased singleton) reads `enabled AND next_run_at <= now()`,
-- enqueues a core.background_jobs row (dedup_key = the BARE schedule_id for overlap=SKIP via
-- 0039's uq_background_jobs_dedup_active — L9/W4.1: comment corrected, no `bucket` concept exists;
-- a per-tick suffix would free the key every tick and defeat overlap=SKIP), stamps
-- last_enqueued_at, and advances next_run_at.
--
--   * schedule_id (text PK) is the idempotency anchor — mirrors ensureCronSchedule's
--     create-if-absent semantics; operators pause via `enabled = false`.
--   * cadence_kind 'cron' → cadence_spec is a cron expression; 'interval' → cadence_spec is seconds.
--   * overlap_policy has NO CHECK (per the Phase-3a Wave-1 spec): 'skip' is the only Wave-3
--     implemented policy; the column is text so a future policy lands without DDL.
--
-- Brand-new (empty, cold) table — plain CREATE TABLE, no expand-contract needed.
CREATE TABLE core.scheduled_jobs (
  schedule_id      text PRIMARY KEY,
  job_type         text NOT NULL,
  cadence_kind     text NOT NULL
                   CONSTRAINT ck_scheduled_jobs_cadence_kind
                   CHECK (cadence_kind IN ('cron','interval')),
  cadence_spec     text NOT NULL,
  input            jsonb NOT NULL DEFAULT '{}'::jsonb,
  overlap_policy   text NOT NULL DEFAULT 'skip',
  enabled          boolean NOT NULL DEFAULT true,
  next_run_at      timestamptz NOT NULL,
  last_enqueued_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
