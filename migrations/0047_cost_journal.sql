-- 0047_cost_journal.sql — de-Temporal Phase 0 (build-gate, 2026-06-11): telemetry.cost_journal, the
-- compensating SIGNED per-call cost journal that runs ALONGSIDE the telemetry.cost_daily aggregate
-- (shadow-write / dual-read until the Phase-4 cutover). The ADR fork is resolved as "additive
-- journal": orphaned reservations are healed by APPENDING a release row — never a destructive
-- subtract against the shared aggregate, and no Pattern-D rewrite of the parity-critical
-- PostgresCostCapEnforcer (which stays the sole production cap authority, untouched).
--
--   * One row per cost EVENT, three kinds:
--       'reserve' — +estimated cents, beside checkOrRaise's optimistic reservation;
--       'settle'  — actual − estimated (refund negative / top-up positive / zero ALLOWED and
--                   always written: the settle row is the reconciler's proof the call completed);
--       'release' — reconciler-authored compensation, −reserve_amount, APPEND-only.
--   * INVARIANT (dual-read): global(day) = SUM(amount_cents) over the day — platform-scope
--     zero-UUID rows count only here; per-org(day, org) = SUM where installation_id = org. When
--     journal and aggregate see the same event sequence these SUMs equal
--     cost_daily.daily_total_cents per (today, scope[, scope_id]); the cap is checked against the
--     SUM on the journal's (not-yet-production) deciding path.
--   * call_id = the ADR-0068 LLM-invocation-ledger idempotency_key (sha256 hex over the
--     deterministic activity inputs; PR-level calls use the purpose-keyed uuid5 chunkId
--     surrogate) — text, NOT uuid, because the key is a 64-hex digest. The client's per-call
--     requestId uuid4 is the fallback for un-ledgered paid calls (platform jobs). The SAME call_id
--     legitimately recurs across attempt pairs (a runner retry re-reserves under the same key, and
--     the aggregate counts both reservations too) — hence the surrogate journal_id PK and
--     count-based reserve/settle pairing in the reconciler.
--   * closes_journal_id: a release row REFERENCES the orphaned reserve it compensates; the partial
--     UNIQUE index below makes healing idempotent (at most ONE release per reserve) and is the
--     ON CONFLICT arbiter for racing reconcile passes.
--
-- Tenancy: scope-discriminated like telemetry.cost_daily — NOT registered in TENANT_SCOPED_TABLES
-- (the installation_id column is the (scope, scope_id) discriminator, zero-UUID = platform scope).
--
-- Brand-new (empty, cold) table — plain CREATE TABLE, no expand-contract needed. Purely additive:
-- no existing table/column/index is touched; cost_daily semantics are unchanged.
CREATE TABLE telemetry.cost_journal (
  journal_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id           text NOT NULL,
  installation_id   uuid NOT NULL,    -- zero-UUID sentinel = platform scope (global-only spend)
  today             date NOT NULL,    -- the accounting day — the SAME value the aggregate keys on
  entry_kind        text NOT NULL
                    CONSTRAINT ck_cost_journal_entry_kind
                    CHECK (entry_kind IN ('reserve','settle','release')),
  amount_cents      bigint NOT NULL,  -- SIGNED integer cents — no float, no division (cost-spine rule)
  closes_journal_id uuid REFERENCES telemetry.cost_journal(journal_id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Sign invariants per kind, enforced at the DB (raw inserts bypass app validation): a destructive
  -- negative 'reserve' or a headroom-stealing positive 'release' is unrepresentable.
  CONSTRAINT ck_cost_journal_reserve_sign CHECK (entry_kind <> 'reserve' OR amount_cents >= 0),
  CONSTRAINT ck_cost_journal_release_sign CHECK (entry_kind <> 'release' OR amount_cents <= 0),
  -- Only reconciler-authored release rows pair back to the reserve they compensate.
  CONSTRAINT ck_cost_journal_closes_release_only CHECK (closes_journal_id IS NULL OR entry_kind = 'release')
);

-- Index consumers (schema-with-consumer discipline — no speculative indexes):
--   (today, installation_id) — the SUM reads: the journal cap check + the dual-read divergence seam.
CREATE INDEX ix_cost_journal_today_installation ON telemetry.cost_journal (today, installation_id);
--   (call_id) — the reconciler's reserve/settle/release pairing GROUP BY.
CREATE INDEX ix_cost_journal_call_id ON telemetry.cost_journal (call_id);
--   partial UNIQUE on closes_journal_id — at most one release per reserve row (idempotent heal);
--   doubles as the ON CONFLICT arbiter when concurrent reconcile passes race.
CREATE UNIQUE INDEX uq_cost_journal_closes ON telemetry.cost_journal (closes_journal_id)
  WHERE closes_journal_id IS NOT NULL;
