-- 0004_partman_register — register the 7 pre-partitioned parents with pg_partman (P0-1).
--
-- 0001 pre-created each parent + its *_default partition + a STATIC runway of date-range children, but
-- never registered them in partman.part_config. So partman.run_maintenance() (the daily job) was a no-op:
-- it only premakes/drops for REGISTERED parents. Once a parent's static runway lapsed (webhook_events as
-- soon as 2026-06-24) rows would silently fall into the *_default partition, retention/drop would never
-- run, and a populated default partition would later BLOCK any create_parent for the overlapping range.
--
-- create_parent ADOPTS the baseline's existing children rather than creating fresh ones:
--   p_default_table   := false  -- each parent ALREADY has a *_default partition (0001); recreating it
--                                  errors with "<parent>_default is already a partition".
--   p_start_partition := <earliest existing child lower bound>  -- anchors pg_partman's interval grid to
--                                  the pre-created partitions. REQUIRED for the weekly parents
--                                  (webhook_events, llm_calls): pg_partman's default 7-day grid is anchored
--                                  elsewhere and would otherwise try to create a partition that OVERLAPS an
--                                  existing one ("partition … would overlap partition …").
--   p_premake         := 4      -- keep 4 future partitions ahead of now() on every maintenance sweep.
--
-- Guarded on part_config so the migration is safe to re-run on a partially-applied DB (create_parent on an
-- already-registered parent errors). RETENTION (auto-drop of aged partitions) is intentionally NOT set:
-- it is a data-retention / compliance policy decision for these audit + LLM-telemetry tables. This
-- migration fixes the acute PREMAKE blocker only; configure partman.part_config.retention per table under
-- an explicit policy. FOLLOW-UP-partition-retention-policy.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('audit.audit_events',     'created_at',  '1 month', '2026-02-01 00:00:00+00'),
      ('audit.webhook_events',   'received_at', '7 days',  '2026-05-20 00:00:00+00'),
      ('audit.workflow_events',  'received_at', '1 month', '2026-04-01 00:00:00+00'),
      ('core.diff_snapshots',    'created_at',  '1 month', '2026-04-01 00:00:00+00'),
      ('core.feedback_events',   'created_at',  '1 month', '2026-04-01 00:00:00+00'),
      ('telemetry.llm_calls',    'created_at',  '7 days',  '2026-05-06 00:00:00+00'),
      ('telemetry.llm_payloads', 'created_at',  '1 month', '2026-04-01 00:00:00+00')
    ) AS t(parent, control, intv, start_at)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM partman.part_config WHERE parent_table = r.parent) THEN
      PERFORM partman.create_parent(
        p_parent_table    := r.parent,
        p_control         := r.control,
        p_interval        := r.intv,
        p_type            := 'range',
        p_premake         := 4,
        p_default_table   := false,
        p_start_partition := r.start_at
      );
    END IF;
  END LOOP;
END $$;
