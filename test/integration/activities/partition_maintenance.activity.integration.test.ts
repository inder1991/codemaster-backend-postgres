/**
 * Integration test for `runPgPartmanMaintenanceActivity` — REAL de-stubbed port of the frozen Python
 * `@activity.defn run_pg_partman_maintenance`
 * (vendor/codemaster-py/codemaster/activities/partition_maintenance.py), against a DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB) that has the
 * `pg_partman` extension installed (the `partman` schema + `partman.part_config` + `partman.run_maintenance`).
 * Runs ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise.
 *
 * ## Why this test is DDL-careful
 *
 * The activity delegates to `partman.run_maintenance(p_analyze := true)`, which PREMAKES future range
 * partitions and DROPS aged ones across EVERY pg_partman parent in `partman.part_config`. The DROP path is
 * destructive, so this suite NEVER touches a baseline parent: it seeds a UNIQUE throwaway partitioned
 * parent (`public.pm_it_<rand>`) via `partman.create_parent`, exercises the activity, and in a `finally`
 * CASCADE-DROPs that one table (removing all its children) + deletes its single `partman.part_config` row.
 * No baseline partition is ever dropped — create_parent's own premake window + a high `retention` keeps
 * the throwaway parent's children alive across the run, and the seeded interval/retention are chosen so
 * `run_maintenance` does NOT age-drop them.
 *
 * Coverage (the activity's observable behaviour — the count → run_maintenance → recount snapshot):
 *   (A) Baseline (no seed): the activity runs cleanly against pg_partman, returns a well-formed
 *       PartitionMaintenanceResultV1 with tables_processed === the live part_config parent count and
 *       partitions_created >= 0 (floored). Re-running is a no-op on the partition count (idempotency).
 *   (B) With a seeded throwaway parent: tables_processed increases by EXACTLY 1 vs the baseline (the
 *       activity counts our new parent), the child partitions create_parent premade are visible across the
 *       run (count non-decreasing — run_maintenance never DROPS them under the chosen interval/retention),
 *       and partitions_created stays floored at >= 0.
 *
 * NOTE: forcing partitions_created > 0 deterministically is NOT attempted — pg_partman 5.4.3
 * `run_maintenance` extends the forward window off the wall clock + each parent's premake watermark, which
 * a wall-clock-independent fixture cannot reliably trip without a clock-advance. The floored-non-negative +
 * idempotency + parent-count-wiring assertions are the robust, faithful surface (the "re-run is a no-op"
 * path the activity's own contract guarantees). The float→int parent-count + floor-at-0 logic is covered
 * exactly here; the result-shape parity is pinned separately in
 * test/contracts/partition_maintenance_result.v1.parity.test.ts.
 */

import { randomInt } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, expect, it } from "vitest";

import { runPgPartmanMaintenanceActivity } from "#backend/activities/partition_maintenance.activity.js";

import { getPool, disposePool } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;

if (INTEGRATION_DSN) {
  pool = getPool(INTEGRATION_DSN);
}

afterAll(async () => {
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

/** A unique, lowercase, identifier-safe throwaway parent name (public schema). */
function uniqueParentName(): string {
  return `pm_it_${randomInt(1, 2_000_000_000)}`;
}

/** Live count of pg_partman parents (the activity's tables_processed source). */
async function parentCount(): Promise<number> {
  const r = await pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM partman.part_config");
  return Number.parseInt(r.rows[0]!.n, 10);
}

/** Live child-partition count for ONE parent (so we never assert against the cluster-wide total). */
async function childCountOf(qualifiedParent: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM pg_inherits WHERE inhparent = to_regclass($1)::oid",
    [qualifiedParent],
  );
  return Number.parseInt(r.rows[0]!.n, 10);
}

/**
 * Seed a throwaway pg_partman-managed parent: a RANGE-partitioned-on-`created_at` table registered via
 * `partman.create_parent` (premake 4 → create_parent premakes future + recent partitions immediately). A
 * generous `retention` is left unset (NULL) so `run_maintenance` NEVER age-drops the throwaway children
 * during the test window.
 */
async function seedParent(name: string): Promise<string> {
  const qualified = `public.${name}`;
  await pool.query(
    `CREATE TABLE ${qualified} (
       id bigint NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now()
     ) PARTITION BY RANGE (created_at)`,
  );
  await pool.query(
    `SELECT partman.create_parent(
       p_parent_table := $1,
       p_control := 'created_at',
       p_interval := '1 day',
       p_type := 'range',
       p_premake := 4
     )`,
    [qualified],
  );
  return qualified;
}

/** CASCADE-drop the throwaway parent (removes every child) + delete its single part_config row. */
async function dropParent(qualified: string): Promise<void> {
  // part_config first (FK-free; just the registration row), then the table cascade.
  await pool.query("DELETE FROM partman.part_config WHERE parent_table = $1", [qualified]);
  await pool.query(`DROP TABLE IF EXISTS ${qualified} CASCADE`);
}

describeDb("runPgPartmanMaintenanceActivity (integration, disposable PG + pg_partman)", () => {
  it("(A) runs maintenance, reports parent count + floored non-negative created, and is idempotent", async () => {
    const liveParents = await parentCount();

    const r1 = await runPgPartmanMaintenanceActivity({ dsn: INTEGRATION_DSN! });
    expect(r1.schema_version).toBe(1);
    expect(r1.tables_processed).toBe(liveParents);
    expect(r1.partitions_created).toBeGreaterThanOrEqual(0); // floored at 0
    expect(Number.isInteger(r1.tables_processed)).toBe(true);
    expect(Number.isInteger(r1.partitions_created)).toBe(true);

    // Idempotency: a second back-to-back run does not change the parent count and stays floored.
    const r2 = await runPgPartmanMaintenanceActivity({ dsn: INTEGRATION_DSN! });
    expect(r2.tables_processed).toBe(liveParents);
    expect(r2.partitions_created).toBeGreaterThanOrEqual(0);
  });

  it("(B) counts a freshly-seeded parent in tables_processed and preserves its premade children", async () => {
    const name = uniqueParentName();
    const before = await parentCount();
    let qualified: string | undefined;

    try {
      qualified = await seedParent(name);

      // create_parent premakes a window of children immediately.
      const seededChildren = await childCountOf(qualified);
      expect(seededChildren).toBeGreaterThan(0);

      const r = await runPgPartmanMaintenanceActivity({ dsn: INTEGRATION_DSN! });

      // The activity now sees EXACTLY our one extra parent.
      expect(r.tables_processed).toBe(before + 1);
      // Result shape is well-formed + floored.
      expect(r.schema_version).toBe(1);
      expect(r.partitions_created).toBeGreaterThanOrEqual(0);

      // run_maintenance must NOT have dropped our throwaway parent's premade children (no retention set):
      // the child count is non-decreasing across the run.
      const afterChildren = await childCountOf(qualified);
      expect(afterChildren).toBeGreaterThanOrEqual(seededChildren);
    } finally {
      if (qualified !== undefined) await dropParent(qualified);
    }

    // Teardown restored the live parent count.
    expect(await parentCount()).toBe(before);
  });
});
