-- 0042_background_jobs_state_and_indexes.sql — Phase 4c W4c.1 (de-Temporal full-removal program):
-- three data-layer review fixes on core.background_jobs (#7 state vocabulary, #8 claim indexes).
--
-- (#7) DROP 'failed' from the state vocabulary. 0039 reserved 'failed' as a persisted resting state
--      ("operators can distinguish retry-scheduled from exhausted by state"), but the W2a repo
--      shipped review_jobs semantics instead: BackgroundJobsRepo.markFailed settles a failed attempt
--      as 'ready' (retry scheduled, last_error persisted) or 'dead' (attempts exhausted) — NOTHING
--      writes or reads 'failed' (grep-confirmed across repo/runner/scheduler/contracts/handlers).
--      Operators already distinguish the two cases by state ready+last_error vs dead+dead_reason
--      (the 0041 dead-letter triple). Keeping the value invites monitoring a state that structurally
--      cannot occur, so the CHECK shrinks to the 4 reachable values. The table is cold/dev-phase
--      (brand-new platform table, no production rows): the CHECK swap is a plain metadata-only
--      DROP+ADD — expand-contract discipline applies to populated/hot tables, not this one.
ALTER TABLE core.background_jobs DROP CONSTRAINT ck_background_jobs_state;
ALTER TABLE core.background_jobs ADD CONSTRAINT ck_background_jobs_state
  CHECK (state IN ('ready','leased','done','dead'));

-- (#8) Claim-path indexes. The claim's inner SELECT is an OR of two arms:
--        arm 1: state = 'ready'  AND run_after <= now()
--        arm 2: state = 'leased' AND leased_until < now() AND attempts < max_attempts
--      ordered by (priority DESC, run_after, created_at, job_id). The single composite
--      ix_background_jobs_claimable (state, run_after, priority) serves neither well: its column
--      order cannot satisfy the ORDER BY (priority leads there), and arm 2 filters on leased_until,
--      which it does not cover. Two PARTIAL indexes serve the arms directly (BitmapOr-able; the
--      'ready' index's key order is a strict prefix of the claim's ORDER BY, so the hot path —
--      pick the highest-priority oldest due job — is an ordered index scan; job_id, the final
--      tie-break, is deterministic via the PK). The 'leased' index also serves reapStuckRuns'
--      `state='leased' AND leased_until < now()` scan.
CREATE INDEX ix_background_jobs_ready_claim
  ON core.background_jobs (priority DESC, run_after, created_at)
  WHERE state = 'ready';
CREATE INDEX ix_background_jobs_leased_expiry
  ON core.background_jobs (leased_until)
  WHERE state = 'leased';

-- The superseded composite is dropped: after this migration the repo (the table's ONLY SQL surface
-- — enqueue/claim/heartbeat/settle/reap; everything else goes through it) has no query the old
-- index serves that the partial pair + the PK don't serve better, and keeping it would only tax
-- every state transition with a third index write.
DROP INDEX core.ix_background_jobs_claimable;
