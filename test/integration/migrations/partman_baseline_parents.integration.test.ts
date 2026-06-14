// F1 (P0-1) regression guard: migration 0004 must register all 7 pre-partitioned baseline parents with
// pg_partman, so partman.run_maintenance() actually premakes future partitions (it was a no-op while
// part_config was empty — webhook_events' static runway would have lapsed 2026-06-24). Runs ONLY when
// CODEMASTER_PG_CORE_DSN is set (the migrated disposable PG), via describeDb.

import { type Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { disposePool, getPool } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;
beforeAll(() => {
  if (INTEGRATION_DSN) pool = getPool(INTEGRATION_DSN);
});
afterAll(async () => {
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

// parent → [control column, partition interval] the migration registers.
const EXPECTED: ReadonlyArray<readonly [string, string, string]> = [
  ["audit.audit_events", "created_at", "1 mon"],
  ["audit.webhook_events", "received_at", "7 days"],
  ["audit.workflow_events", "received_at", "1 mon"],
  ["core.diff_snapshots", "created_at", "1 mon"],
  ["core.feedback_events", "created_at", "1 mon"],
  ["telemetry.llm_calls", "created_at", "7 days"],
  ["telemetry.llm_payloads", "created_at", "1 mon"],
];

describeDb("0004 partman registration (F1 / P0-1)", () => {
  it("registers all 7 baseline parents with the expected control + interval", async () => {
    const r = await pool.query<{ parent_table: string; control: string; partition_interval: string }>(
      `SELECT parent_table, control, partition_interval FROM partman.part_config
        WHERE parent_table = ANY($1::text[])`,
      [EXPECTED.map(([p]) => p)],
    );
    const byParent = new Map(r.rows.map((row) => [row.parent_table, row]));
    for (const [parent, control, interval] of EXPECTED) {
      const row = byParent.get(parent);
      expect(row, `${parent} must be registered in partman.part_config (migration 0004)`).toBeDefined();
      expect(row!.control).toBe(control);
      // pg_partman normalizes '7 days'→'7 days', '1 month'→'1 mon'; compare on the stored form.
      expect(row!.partition_interval).toBe(interval);
    }
  });

  it("each registered parent has a future partition runway (run_maintenance is premaking)", async () => {
    // The furthest upper bound across each parent's range children must be in the future — i.e. create_parent
    // + run_maintenance premade ahead of now(). (DEFAULT partitions excluded: their bound is the literal DEFAULT.)
    const r = await pool.query<{ parent: string; ok: boolean }>(
      `SELECT pc.parent_table AS parent,
              max(substring(pg_get_expr(k.relpartbound, k.oid) FROM 'TO \\(''([^'']+)''')::timestamptz) > now() AS ok
         FROM partman.part_config pc
         JOIN pg_class p ON p.oid = to_regclass(pc.parent_table)
         JOIN pg_inherits i ON i.inhparent = p.oid
         JOIN pg_class k ON k.oid = i.inhrelid
        WHERE pg_get_expr(k.relpartbound, k.oid) LIKE 'FOR VALUES FROM%'
          AND pc.parent_table = ANY($1::text[])
        GROUP BY pc.parent_table`,
      [EXPECTED.map(([p]) => p)],
    );
    expect(r.rows).toHaveLength(EXPECTED.length);
    for (const row of r.rows) {
      expect(row.ok, `${row.parent} must have a future partition (premade runway)`).toBe(true);
    }
  });
});
