-- 0044_review_jobs_claim_indexes.sql — W4.6 (master-hardening-plan, audit L3): backport the 0042
-- split-partial-claim-index treatment from core.background_jobs to core.review_jobs.
--
-- NUMBERING NOTE: 0043 is taken by telemetry.cost_journal on the parallel feat/phase0-cost-journal
-- branch; this migration deliberately starts at 0044 to avoid a collision at merge time.
--
-- COLD-ONLY GUARD (the 0042 pattern — CS5/XH7/L16/RT6): the index swap below builds
-- non-CONCURRENTLY and drops the live composite, which is only acceptable while core.review_jobs is
-- EMPTY (dev-phase table; the postgres-mode cutover has not flipped, so nothing durable lives here).
-- Replayed against a POPULATED table (a stale environment migrated late, a restored snapshot) the
-- migration aborts loudly here instead of taking blocking locks under live rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM core.review_jobs) THEN
    RAISE EXCEPTION '0044 requires a COLD core.review_jobs (it swaps claim indexes non-concurrently): the table has rows. Drain/clear core.review_jobs or apply the CONCURRENTLY expand-contract variant of this change instead.';
  END IF;
END $$;

-- (L3) Claim-path indexes. The claim's inner SELECT is an OR of two arms (review_jobs_repo.ts):
--        arm 1: state = 'ready'  AND run_after <= now()
--        arm 2: state = 'leased' AND leased_until < now() AND attempts < max_attempts
--      ordered by (priority DESC, run_after, created_at, job_id). The 0036 composite
--      ix_review_jobs_claimable (priority DESC, run_after) WHERE state IN ('ready','leased') serves
--      neither arm well: it cannot distinguish the arms' different time predicates, and the
--      leased-reclaim arm filters on leased_until, which it does not cover. Two PARTIAL indexes
--      serve the arms directly (BitmapOr-able; the 'ready' index's key order is a strict prefix of
--      the claim's ORDER BY, so the hot path — pick the highest-priority oldest due job — is an
--      ordered index scan; job_id, the final tie-break, is deterministic via the PK). The 'leased'
--      index also serves reapStuckRuns' `state='leased' AND leased_until < now()` scan, which 0036
--      left with no index at all.
CREATE INDEX ix_review_jobs_ready_claim
  ON core.review_jobs (priority DESC, run_after, created_at)
  WHERE state = 'ready';
CREATE INDEX ix_review_jobs_leased_expiry
  ON core.review_jobs (leased_until)
  WHERE state = 'leased';

-- The superseded composite is dropped (the 0042 precedent): the partial pair + the PK serve every
-- repo query better, and keeping it would tax every state transition with a third index write.
DROP INDEX core.ix_review_jobs_claimable;
