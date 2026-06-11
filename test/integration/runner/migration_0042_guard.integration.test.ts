// CS5 (XH7/L16/RT6 — minimal cutover slice, part B): migration-0042 cold-only guard. 0042 DROPs a
// CHECK constraint and CREATEs indexes NON-concurrently on the explicit assumption that
// core.background_jobs is empty ("cold/dev-phase ... no production rows" — its own header). That
// assumption is enforced nowhere: replayed against a POPULATED table (a stale environment migrated
// late, a restored snapshot) it would take blocking locks and rewrite index state under live rows.
// The guard makes the assumption executable: a DO block at the top of 0042 RAISEs (aborting the
// migration transaction) when the table has rows, so 0042 can only ever apply to the cold table it
// was written for.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5439 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 2 }); }
afterAll(async () => { await pool?.end(); });

const MIGRATION_PATH = join(import.meta.dirname, "../../../migrations/0042_background_jobs_state_and_indexes.sql");

/** The guard DO block — the FIRST statement of 0042 (everything else assumes it already ran). */
function guardBlock(): string {
  const sqlText = readFileSync(MIGRATION_PATH, "utf-8");
  const m = /DO \$\$[\s\S]*?END;?\s*\$\$;/.exec(sqlText);
  expect(m, "0042 must open with a cold-only guard DO block").not.toBeNull();
  // The guard must precede every DDL statement in the file.
  expect(sqlText.indexOf("ALTER TABLE")).toBeGreaterThan(sqlText.indexOf(m![0]));
  return m![0];
}

it("(1) 0042 carries a cold-only guard DO block ahead of all DDL", () => {
  expect(guardBlock()).toContain("core.background_jobs");
});

describeDb("migration 0042 cold-only guard (CS5)", () => {
  it("(2) the guard ABORTS against a populated core.background_jobs (loud, self-describing)", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO core.background_jobs (job_id, job_type, payload, payload_sha256)
         VALUES ($1, 'cs5-guard-test', '{}', repeat('0', 64))`,
        [randomUUID()],
      );
      await expect(client.query(guardBlock())).rejects.toThrow(/cold/i);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("(3) the guard PASSES against an empty core.background_jobs", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM core.background_jobs`);
      await client.query(guardBlock()); // resolves — no throw
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
