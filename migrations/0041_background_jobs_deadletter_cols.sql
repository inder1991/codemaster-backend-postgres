-- 0041_background_jobs_deadletter_cols.sql — Phase 3a W2a.1 (de-Temporal full-removal program):
-- close the dead-letter-columns PARITY GAP between core.background_jobs (0039) and core.review_jobs
-- (0036 lines 26-29 declare finished_at/dead_reason/last_error; 0039 omitted them). The repo wiring
-- mirrors review_jobs_repo 1:1: markDone stamps finished_at; markFailed persists last_error on EVERY
-- failure (and dead_reason+finished_at on the terminal one); terminalSettle/reap stamp
-- dead_reason+finished_at. Replaces the prior pass's console.warn-only diagnostics.
--
-- Nullable ADD COLUMNs on a brand-new (cold, low-traffic) table — metadata-only, no table rewrite,
-- no expand-contract ceremony needed (that discipline applies to populated/hot tables).
ALTER TABLE core.background_jobs
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN dead_reason text,
  ADD COLUMN last_error  text;
