-- 0006_outbox_pending_created_at_index — F15 (P2-8): index the outbox drain's ORDER BY.
--
-- claimPending drains GLOBALLY: `WHERE state='pending' AND (leased_until IS NULL OR leased_until < now())
-- ORDER BY created_at LIMIT n FOR UPDATE SKIP LOCKED` — no equality on installation_id or sink. The two
-- existing partial-on-pending indexes LEAD with installation_id (ix_outbox_installation_state_created) and
-- sink (outbox_pending_by_sink), so neither supplies created_at ordering for this predicate → Postgres
-- sorts the whole PENDING set every claim tick (the drain busy-loops on a non-empty claim). Bounded to the
-- pending set by the partial predicate, so it bites under a wedged/black-holed sink, not at steady state.
-- A (created_at) partial index on the pending rows lets the claim read the head without a sort.
--
-- Plain CREATE INDEX (like the baseline): runs at deploy on a fresh/migrating DB; node-pg-migrate wraps the
-- migration in a txn (so no CONCURRENTLY).

CREATE INDEX IF NOT EXISTS ix_outbox_pending_created_at
  ON core.outbox (created_at)
  WHERE state = 'pending';
