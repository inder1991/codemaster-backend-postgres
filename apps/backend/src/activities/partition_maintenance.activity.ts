/**
 * `runPgPartmanMaintenanceActivity` — REAL de-stubbed port of the frozen Python
 * `@activity.defn run_pg_partman_maintenance`
 * (vendor/codemaster-py/codemaster/activities/partition_maintenance.py). Sprint 3 / S3.1.7.
 *
 * Drives pg_partman's `partman.run_maintenance(p_analyze := true)` once per day (the daily Temporal
 * Schedule fires {@link partitionMaintenanceWorkflow} at 02:00 UTC). `run_maintenance` premakes the
 * upcoming FUTURE range partitions and drops aged ones on every pg_partman-managed parent (the hot
 * partitioned tables registered in `partman.part_config` — e.g. `audit.audit_events` /
 * `audit.workflow_events`). The retention/premake WINDOW and the table list are NOT hardcoded here: they
 * live in each parent's `partman.part_config` row (premake / retention columns), exactly as in the frozen
 * Python — this activity issues NO `CREATE TABLE … PARTITION OF …` / `DROP TABLE` DDL of its own. It
 * delegates 100% to pg_partman and merely COUNTS the effect.
 *
 * ## What it reports (byte-faithful with the Python)
 *
 * Inside ONE transaction (the Python `engine.begin()` bracket):
 *   1. `tables_processed` = `SELECT COUNT(*) FROM partman.part_config` — how many pg_partman parents exist
 *      (the count is reported verbatim, before/independent of the maintenance result).
 *   2. `partitions_before` = child-partition count across ALL parents, via
 *      `pg_inherits WHERE inhparent IN (SELECT to_regclass(parent_table)::oid FROM partman.part_config)`.
 *   3. `SELECT partman.run_maintenance(p_analyze := true)` — the actual premake-future + drop-aged sweep.
 *   4. `partitions_after` = the same child-partition count.
 *   5. `partitions_created` = `max(after - before, 0)` — floored at 0 (a sweep that NET-drops aged
 *      partitions must not report a negative "created" count). 1:1 with the Python
 *      `max(int(after) - int(before), 0)`.
 *
 * ## NO CREATE INDEX CONCURRENTLY / autocommit handling
 *
 * The frozen Python issues NO `CREATE INDEX CONCURRENTLY` and opens NO autocommit block — all four
 * statements run inside the single `engine.begin()` transaction. We mirror that EXACTLY: one
 * {@link withPgTransaction} bracket, no autocommit escape. (pg_partman's own internal DDL runs inside the
 * function call; the CLAUDE.md "CREATE INDEX CONCURRENTLY outside the txn" rule governs *our* migrations,
 * not pg_partman's internal partition-template index creation, and the Python does no such thing here.)
 *
 * ## Cross-tenant by design (the catalog queries carry no tenancy)
 *
 * `partman.part_config` / `pg_inherits` are Postgres CATALOG tables, NOT tenant-scoped `core.*` tables, so
 * the raw-SQL tenancy gate (which fires only on the `TENANT_SCOPED_TABLES` registry) does not match them.
 * The inline `// tenant:exempt …` markers are belt-and-suspenders documenting the by-design cross-tenant
 * (cluster-wide) nature of partition maintenance — it MUST see every parent regardless of tenant.
 *
 * ## DSN resolution (divergence from the Python — maint-pool env, with a core-pool fallback)
 *
 * The frozen Python reads `CODEMASTER_PG_MAINT_DSN` (the dedicated maintenance pool populated from Vault
 * Agent). Faithful 1:1: the injected `dsn` wins, else `CODEMASTER_PG_MAINT_DSN`, else
 * `CODEMASTER_PG_CORE_DSN` (the ADR-0062 shared pool) — the fallback lets the integration tier point the
 * activity at the disposable PG via the standard `CODEMASTER_PG_CORE_DSN` seam every other ported sweep
 * uses, without provisioning a separate maint DSN. Production still prefers the dedicated maint pool when
 * `CODEMASTER_PG_MAINT_DSN` is set. Re-basing onto a ported maintenance-pool config is
 * FOLLOW-UP-partition-maintenance-dedicated-pool.
 *
 * ## Clock authority
 *
 * NONE. This activity reads no wall clock and emits no `created_at` — pg_partman computes every partition
 * boundary from the DB `now()` internally. 1:1 with the Python (which injects no clock here).
 *
 * ## Runtime context / shared-wiring boundary
 *
 * Runs in the NORMAL Node runtime (DB access sanctioned), inside one {@link withPgTransaction} bracket so
 * the count → maintain → recount sequence is a single atomic snapshot (the Python `engine.begin()`).
 * Exports the registered activity function only; the Integrate/Workflow phase binds it under the Temporal
 * name `run_pg_partman_maintenance` and owns the worker registry — NOT this module.
 */

import { getPool, withPgTransaction } from "#platform/db/database.js";

import { PartitionMaintenanceResultV1 } from "#contracts/partition_maintenance_result.v1.js";

/**
 * Injected collaborators. `dsn` is OPTIONAL — production resolves the dedicated maintenance pool from
 * `CODEMASTER_PG_MAINT_DSN` (1:1 with the Python), falling back to the ADR-0062 `CODEMASTER_PG_CORE_DSN`
 * shared pool; tests inject a disposable-PG `dsn`.
 */
export type PartitionMaintenanceDeps = {
  /** DSN for the maintenance pool; default `CODEMASTER_PG_MAINT_DSN`, then `CODEMASTER_PG_CORE_DSN`. */
  dsn?: string;
};

/**
 * Resolve the DSN: the injected one, else `CODEMASTER_PG_MAINT_DSN` (the Python's
 * {@link https | PG_MAINT_DSN_ENV}), else `CODEMASTER_PG_CORE_DSN`. Throws if none is set — fail-closed,
 * 1:1 with the Python `RuntimeError(f"{PG_MAINT_DSN_ENV} unset; …")`.
 */
function resolveDsn(deps: PartitionMaintenanceDeps): string {
  if (deps.dsn !== undefined && deps.dsn !== "") {
    return deps.dsn;
  }
  const maint = process.env.CODEMASTER_PG_MAINT_DSN;
  if (maint !== undefined && maint !== "") {
    return maint;
  }
  const core = process.env.CODEMASTER_PG_CORE_DSN;
  if (core !== undefined && core !== "") {
    return core;
  }
  throw new Error(
    "CODEMASTER_PG_MAINT_DSN unset (and no CODEMASTER_PG_CORE_DSN fallback / injected dsn); " +
      "cannot run partition maintenance",
  );
}

/** The child-partition count across ALL pg_partman parents — the Python before/after `pg_inherits` query. */
const CHILD_PARTITION_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM pg_inherits " +
  "WHERE inhparent IN (" +
  "  SELECT to_regclass(parent_table)::oid " +
  "  FROM partman.part_config" +
  ")";

/** Read a single bigint COUNT(*) cell as a JS number. pg returns COUNT(*) as a numeric string. */
function countOf(rows: ReadonlyArray<{ n: string | number }>): number {
  const raw = rows[0]?.n ?? 0;
  return typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
}

/**
 * The registered activity — count parents + child partitions, run pg_partman maintenance, recount, and
 * return the typed envelope. 1:1 with the Python `run_pg_partman_maintenance`.
 */
export async function runPgPartmanMaintenanceActivity(
  deps: PartitionMaintenanceDeps = {},
): Promise<PartitionMaintenanceResultV1> {
  const dsn = resolveDsn(deps);
  const pool = getPool(dsn);

  const { tablesProcessed, partitionsBefore, partitionsAfter } = await withPgTransaction(
    pool,
    async (client) => {
      // Count parents pg_partman knows about — reported verbatim as tables_processed.
      // tenant:exempt reason=cluster-wide-partition-maintenance-catalog follow_up=PERMANENT-EXEMPTION-partition-maintenance
      const parents = await client.query<{ n: string | number }>(
        "SELECT COUNT(*) AS n FROM partman.part_config",
      );
      // Snapshot child partitions BEFORE the sweep.
      // tenant:exempt reason=cluster-wide-partition-maintenance-catalog follow_up=PERMANENT-EXEMPTION-partition-maintenance
      const before = await client.query<{ n: string | number }>(CHILD_PARTITION_COUNT_SQL);

      // The actual premake-future + drop-aged sweep across every parent (pg_partman owns the DDL).
      // tenant:exempt reason=cluster-wide-partition-maintenance-run follow_up=PERMANENT-EXEMPTION-partition-maintenance
      await client.query("SELECT partman.run_maintenance(p_analyze := true)");

      // Snapshot child partitions AFTER the sweep.
      // tenant:exempt reason=cluster-wide-partition-maintenance-catalog follow_up=PERMANENT-EXEMPTION-partition-maintenance
      const after = await client.query<{ n: string | number }>(CHILD_PARTITION_COUNT_SQL);

      return {
        tablesProcessed: countOf(parents.rows),
        partitionsBefore: countOf(before.rows),
        partitionsAfter: countOf(after.rows),
      };
    },
  );

  return PartitionMaintenanceResultV1.parse({
    tables_processed: tablesProcessed,
    // Floored at 0 — a net-drop sweep must not report negative "created". 1:1 with the Python max(…, 0).
    partitions_created: Math.max(partitionsAfter - partitionsBefore, 0),
  });
}
