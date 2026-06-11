// W4.6 [L3] — backport the 0042 split-partial-claim-index treatment to core.review_jobs. 0036
// shipped the same single composite this program already judged inadequate for background_jobs
// (ix_review_jobs_claimable: priority leads, cannot satisfy the claim ORDER BY; the leased-reclaim
// arm filters on leased_until, which it does not cover; the reapStuckRuns scan has no index at all).
// Migration 0044 replaces it with the two partial indexes 0042 proved out, and the claim ORDER BY
// gains the deterministic (created_at, job_id) tie-break the 0042 background claim already carries.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5439 DB, migrated to
// head) — never a shared cluster (skips when the DSN is absent, per test/integration/_db.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { minimalReviewPayload, seedRun } from "./_fixtures.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });

// Same authorized deviation as review_jobs_repo.integration.test.ts: claim() is a cross-tenant scan
// over ALL rows; per-test cleanup keeps shuffled neighbours from polluting the deterministic-order assert.
beforeEach(async () => { if (INTEGRATION_DSN) await sql`DELETE FROM core.review_jobs`.execute(db); });

const MIGRATION_PATH = join(import.meta.dirname, "../../../migrations/0044_review_jobs_claim_indexes.sql");

it("(1) 0044 carries a cold-only guard DO block ahead of all DDL (the 0042 pattern)", () => {
  const sqlText = readFileSync(MIGRATION_PATH, "utf-8");
  const m = /DO \$\$[\s\S]*?END;?\s*\$\$;/.exec(sqlText);
  expect(m, "0044 must open with a cold-only guard DO block").not.toBeNull();
  expect(m![0]).toContain("core.review_jobs");
  // The guard must precede every DDL statement in the file.
  expect(sqlText.indexOf("CREATE INDEX")).toBeGreaterThan(sqlText.indexOf(m![0]));
  expect(sqlText.indexOf("DROP INDEX")).toBeGreaterThan(sqlText.indexOf(m![0]));
});

/** sha256 over the repo's canonical key-sorted JSON (mirrors review_jobs_repo's canonicalJson). */
function shaFor(payload: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, sortKeys(val)]),
      );
    }
    return v;
  };
  return createHash("sha256").update(Buffer.from(JSON.stringify(sortKeys(payload)), "utf-8")).digest("hex");
}

describeDb("migration 0044 — review_jobs split partial claim indexes (L3)", () => {
  it("(2) the split partial pair exists and the superseded composite is gone", async () => {
    const r = await sql<{ indexname: string; indexdef: string }>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'core' AND tablename = 'review_jobs'
    `.execute(db);
    const byName = new Map(r.rows.map((row) => [row.indexname, row.indexdef]));

    const ready = byName.get("ix_review_jobs_ready_claim");
    expect(ready, "ix_review_jobs_ready_claim must exist").toBeDefined();
    expect(ready).toContain("priority DESC");
    expect(ready).toMatch(/WHERE \(?state = 'ready'/);

    const leased = byName.get("ix_review_jobs_leased_expiry");
    expect(leased, "ix_review_jobs_leased_expiry must exist").toBeDefined();
    expect(leased).toContain("leased_until");
    expect(leased).toMatch(/WHERE \(?state = 'leased'/);

    expect(byName.has("ix_review_jobs_claimable"), "superseded composite must be dropped").toBe(false);
  });

  it("(3) claim ORDER BY is deterministic: equal (priority, run_after, created_at) ties break by job_id", async () => {
    const repo = new ReviewJobsRepo(db);
    // Three ready jobs with IDENTICAL priority/run_after/created_at, inserted in DESCENDING job_id
    // order so physical insertion order DISAGREES with the deterministic tie-break — without the
    // ORDER BY extension the claim follows heap order and picks the highest job_id first.
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
    for (const jobId of ids) {
      const s = await seedRun(db);
      const payload = minimalReviewPayload(s);
      await sql`
        INSERT INTO core.review_jobs
          (job_id, run_id, review_id, installation_id, state, priority, run_after, created_at,
           payload, payload_sha256, job_payload_schema_version)
        VALUES (${jobId}, ${s.runId}, ${s.reviewId}, ${s.installationId}, 'ready', 0,
                '2026-01-01T00:00:00Z'::timestamptz, '2026-01-01T00:00:00Z'::timestamptz,
                ${JSON.stringify(payload)}::jsonb, ${shaFor(payload)}, 1)
      `.execute(db);
    }
    const claimedOrder: Array<string> = [];
    for (let i = 0; i < 3; i += 1) {
      const job = await repo.claim({ owner: `o-${i}`, leaseMs: 60_000, maxRuntimeMs: 60_000 });
      expect(job).not.toBeNull();
      claimedOrder.push(job!.job_id);
    }
    expect(claimedOrder).toEqual([...ids].sort()); // ascending job_id — NOT insertion order
  });
});
