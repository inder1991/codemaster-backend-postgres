-- 0035_outbox_delivery_id_index_verify
--
-- Verify core.outbox.delivery_id index exists (added in 0001_baseline as outbox_delivery_id_idx).
--
-- WHY: the review-timeline reader (GET /api/admin/review-timeline?delivery=...) looks up the outbox
-- row by delivery_id (apps/backend/src/domain/repos/review_timeline_repo.ts::getOutbox). That lookup
-- relies on outbox_delivery_id_idx for a non-sequential-scan plan. This migration is a no-op assertion:
-- it documents the dependency and fails loudly if a future schema change drops the index.

DO $$
DECLARE
  idx_exists BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'outbox' AND schemaname = 'core' AND indexname = 'outbox_delivery_id_idx'
  ) INTO idx_exists;

  IF NOT idx_exists THEN
    RAISE EXCEPTION 'Index outbox_delivery_id_idx not found on core.outbox. Review-timeline queries require this index.';
  END IF;

  RAISE NOTICE 'Verified: core.outbox.delivery_id index (outbox_delivery_id_idx) exists';
END $$;
