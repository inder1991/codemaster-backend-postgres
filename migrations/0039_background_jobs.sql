-- 0039_background_jobs.sql — Phase 3a Wave 1 (de-Temporal full-removal program, 2026-06-10):
-- core.background_jobs, the GENERIC job platform table generalizing the PROVEN core.review_jobs
-- coarse runner (migrations 0036–0038, ADR-0077). Every de-Temporaled workflow (crons, outbox drain,
-- event-driven single-steps, multi-step orchestration handlers) lands on this one table; the Wave-2
-- repo lifts the review_jobs_repo primitives (FOR UPDATE SKIP LOCKED claim, lease/attempt_token
-- fencing, heartbeat, backoff, reap) verbatim.
--
-- Deliberate divergences from core.review_jobs:
--   * job_type discriminates the handler (review_jobs is single-purpose; this table is the platform).
--   * installation_id is NULLABLE — some job types are tenant-scoped, most (crons, retention,
--     outbox drain) are platform-scoped. NULL = platform-scoped row.
--   * 'failed' IS a persisted resting state (review_jobs maps it transiently to ready|dead inside
--     markFailed) so operators can distinguish "retry scheduled" from "attempts exhausted" by state.
--   * 'cancelled' does NOT exist — supersede semantics are review-pipeline-specific.
--   * dedup_key + the PARTIAL unique index are the scheduler's overlap=SKIP guard: while a row with
--     the same key is ACTIVE (ready|leased), a second enqueue conflicts at insert; terminal rows
--     (done|failed|dead) free the key.
--
-- This is a brand-new (empty, cold) table — plain CREATE TABLE + CREATE INDEX, no expand-contract
-- needed (that discipline applies to populated/hot tables).
CREATE TABLE core.background_jobs (
  job_id          uuid PRIMARY KEY,
  job_type        text NOT NULL,
  installation_id uuid,                              -- NULLABLE by design: NULL = platform-scoped job
  payload         jsonb NOT NULL,
  payload_sha256  text NOT NULL
                  CONSTRAINT ck_background_jobs_payload_sha256_hex
                  CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),  -- 64 lowercase hex: the sha256hex shape (0038 idiom)
  state           text NOT NULL DEFAULT 'ready'
                  CONSTRAINT ck_background_jobs_state
                  CHECK (state IN ('ready','leased','done','failed','dead')),
  -- attempt invariants the crash-loop cap RELIES ON — enforced at the DB, not just in app code
  -- (lifted verbatim from 0036's review_jobs):
  priority        int  NOT NULL DEFAULT 0  CHECK (priority >= 0),
  run_after       timestamptz NOT NULL DEFAULT now(),
  lease_owner     text,
  attempt_token   uuid,                              -- fencing: minted fresh on every claim; cleared on settle
  leased_until    timestamptz,
  timeout_at      timestamptz,                       -- job-level hard ceiling, set on claim
  heartbeat_at    timestamptz,
  attempts        int  NOT NULL DEFAULT 0  CHECK (attempts >= 0),
  max_attempts    int  NOT NULL DEFAULT 3  CHECK (max_attempts >= 1),
  dedup_key       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- overlap=SKIP guard: at most one ACTIVE row per dedup_key (scheduled enqueues use `${schedule_id}:${bucket}`):
CREATE UNIQUE INDEX uq_background_jobs_dedup_active ON core.background_jobs (dedup_key)
  WHERE dedup_key IS NOT NULL AND state IN ('ready','leased');
-- claim-supporting index (the Wave-2 claim scans state + due-time + priority):
CREATE INDEX ix_background_jobs_claimable ON core.background_jobs (state, run_after, priority);
