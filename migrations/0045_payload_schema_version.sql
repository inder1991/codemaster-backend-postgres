-- 0045_payload_schema_version.sql — W4.1 [L8 + OWNER-PAYLOAD-VERSIONING] (master-hardening-plan):
-- back the previously NOMINAL-ONLY `schema_version` contract fields (BackgroundJobV1 /
-- ScheduledJobV1 carried a Zod `.default(1)` that synthesized a constant — nothing was persisted)
-- with REAL columns, so a future payload-shape change has a queryable discriminator and the
-- enqueue/dispatch paths can enforce the cross-deploy compat window (older-or-equal envelopes run;
-- newer ones are deferred for a newer runner — see background_jobs_repo.ts / background_runner.ts).
--
-- core.review_jobs already carries the analogue (job_payload_schema_version, migration 0037) —
-- this closes the L8 parity gap for the two generic platform tables.
--
-- NOT NULL DEFAULT 1 ADD COLUMNs: metadata-only on PG11+ (no table rewrite, no scan — the default
-- is stored in the catalog and materialized lazily), so no cold-only guard / expand-contract
-- ceremony is needed even on populated tables. Existing rows (the PRIOR release's producers) read
-- back as version 1 — exactly the version their payload shape is.
ALTER TABLE core.background_jobs
  ADD COLUMN schema_version integer NOT NULL DEFAULT 1;

ALTER TABLE core.scheduled_jobs
  ADD COLUMN schema_version integer NOT NULL DEFAULT 1;
