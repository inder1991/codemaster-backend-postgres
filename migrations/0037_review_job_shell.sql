-- 0037_review_job_shell.sql — Phase 2: durable workflow-argument store (D1), mutex subordination (D3),
-- comment_ids recovery (D4), RECOVERABLE fix-prompt post claim. ADR-0077.

-- D1 / F1: job-ENVELOPE version. DISTINCT from the review payload's OWN schema_version (=2, a Phase-4
--   hard-cut: review_pull_request.v1.ts:41 `z.literal(2)`). This column versions how the ROW stores the
--   payload (the storage envelope), NOT the review contract — so it is named job_payload_schema_version.
ALTER TABLE core.review_jobs
  ADD COLUMN job_payload_schema_version int NOT NULL DEFAULT 1,
  ADD COLUMN payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN payload_sha256 text  NOT NULL DEFAULT '',
  ADD COLUMN mutex_id       uuid REFERENCES core.pr_review_mutex(mutex_id) ON DELETE SET NULL;  -- D3/F6: FK safe — janitor only sets released_at, nothing DELETEs pr_review_mutex
ALTER TABLE core.review_jobs ALTER COLUMN payload DROP DEFAULT;
ALTER TABLE core.review_jobs ALTER COLUMN payload_sha256 DROP DEFAULT;

-- F2: pre-Phase-2 rows carry no payload and would fail verifyPayload AFTER being claimed (real work not
--   started). Dead-letter them in the SAME migration (recoverable — row retained; production has zero rows;
--   dev/test/smoke rows are disposable). This + the claim's `state IN ('ready','leased')` filter means an
--   un-payloaded row can never be claimed by the shell.
UPDATE core.review_jobs
   SET state = 'dead', dead_reason = 'pre-phase2: no payload (migration 0037)', finished_at = now(),
       leased_until = NULL, lease_owner = NULL, attempt_token = NULL, timeout_at = NULL, heartbeat_at = NULL
 WHERE state IN ('ready','leased');

-- D4 / F8: durable per-comment ids (array-typed) so a crash re-run can finalize findings inline
ALTER TABLE core.posted_reviews
  ADD COLUMN comment_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE core.posted_reviews
  ADD CONSTRAINT ck_posted_reviews_comment_ids_array CHECK (jsonb_typeof(comment_ids) = 'array');

-- D4 / F3: RECOVERABLE fix-prompt GitHub-comment claim — claim ≠ success, so a crash between claim and
--   post can NEVER permanently suppress the comment. `comment_posted_at`+`github_comment_id` are set ONLY
--   after GitHub success (biconditional); the in-flight claim is a reclaimable LEASE
--   (comment_claim_owner/comment_claim_expires_at) that a re-run takes over once it expires.
ALTER TABLE core.fix_prompts
  ADD COLUMN github_comment_id        bigint,
  ADD COLUMN comment_posted_at        timestamptz,
  ADD COLUMN comment_claim_owner      text,
  ADD COLUMN comment_claim_expires_at timestamptz;
ALTER TABLE core.fix_prompts
  ADD CONSTRAINT ck_fix_prompts_comment_id_positive
    CHECK (github_comment_id IS NULL OR github_comment_id > 0),
  ADD CONSTRAINT ck_fix_prompts_posted_iff_comment_id      -- F8: posted ⇔ comment id (biconditional)
    CHECK ((comment_posted_at IS NULL     AND github_comment_id IS NULL)
        OR (comment_posted_at IS NOT NULL AND github_comment_id IS NOT NULL));
