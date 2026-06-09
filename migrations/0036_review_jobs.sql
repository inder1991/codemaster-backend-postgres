-- 0036_review_jobs.sql — coarse-grained review runner: one row per whole review attempt (ADR-0077).
CREATE TABLE core.review_jobs (
  job_id          uuid PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES core.review_runs(run_id),  -- the ONLY integrity anchor
  review_id       uuid NOT NULL,                     -- grouping key (the Phase-2 shell loads context by review_id)
  installation_id uuid NOT NULL,                     -- DENORMALIZED at enqueue (review_runs does NOT carry it):
                                                     -- tenancy + future per-installation fairness. Not FK-anchored.
  delivery_id     text,                              -- WRITE-ONLY correlation metadata in Phase 1 (no reader yet):
                                                     -- the lookup index lands in Phase 4 cutover with its redelivery-dedup consumer.
  -- 'cancelled' is reachable only in Phase 2 (supersede gets the first writer); Phase 1 ships the vocabulary
  --   and exercises ready/leased/done/dead only.
  -- 'failed' is TRANSIENT (markFailed maps it to ready|dead); it is NOT a persisted resting state:
  state           text NOT NULL DEFAULT 'ready'
                  CHECK (state IN ('ready','leased','done','dead','cancelled')),
  -- attempt invariants the crash-loop cap RELIES ON (v3 #2 / v4 #2) — enforced at the DB, not just in app code:
  priority        int  NOT NULL DEFAULT 0  CHECK (priority >= 0),
  attempts        int  NOT NULL DEFAULT 0  CHECK (attempts >= 0),
  max_attempts    int  NOT NULL DEFAULT 3  CHECK (max_attempts >= 1),
  lease_owner     text,
  attempt_token   uuid,                              -- fencing: minted fresh on every claim; CLEARED on every terminal/ready transition
  leased_until    timestamptz,
  heartbeat_at    timestamptz,
  timeout_at      timestamptz,                       -- job-level hard ceiling, set on claim (§Task 1.4)
  run_after       timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  cancel_reason   text,
  dead_reason     text,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- at most one ACTIVE job per RUN (per-run only; review-level ownership is current_run_id + the PR mutex):
CREATE UNIQUE INDEX uq_review_jobs_active_run ON core.review_jobs (run_id) WHERE state IN ('ready','leased');
CREATE INDEX ix_review_jobs_claimable ON core.review_jobs (priority DESC, run_after) WHERE state IN ('ready','leased');
CREATE INDEX ix_review_jobs_installation ON core.review_jobs (installation_id);
