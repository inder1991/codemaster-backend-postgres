// Real-DB integration test for `mark_stale_chunks_activity` — the 1:1 TS port of the frozen Python
// vendor/codemaster-py/codemaster/activities/mark_stale_chunks.py.
//
// Runs ONLY when CODEMASTER_PG_CORE_DSN is set (the shared describeDb gate) — pointing at the DISPOSABLE
// Postgres (postgresql://postgres:postgres@localhost:5434/codemaster). SKIPS otherwise. NEVER touches
// the in-cluster DB; every seeded core.confluence_chunks row is scoped to a unique space_key + cleaned
// up.
//
// Coverage: the 2-pass UPDATE flips active → stale at the two thresholds inlined per ADR-0075 (security
// at 90d FIRST, then default at 180d EXCLUDING security_policy). A fresh chunk stays active; a soft-
// deleted chunk is never touched.

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { MarkStaleChunksActivity } from "#backend/activities/mark_stale_chunks.activity.js";

import { disposeAllPools, getPool } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const TEST_SPACE = `ZZINTTEST_STALE_${process.pid}`;

function vec1024(seed: number): string {
  return `[${Array.from({ length: 1024 }, (_, i) => (seed + i) / 100000).join(",")}]`;
}

describeDb("mark_stale_chunks_activity (integration)", () => {
  const dsn = INTEGRATION_DSN as string;
  const pool = getPool(dsn);
  const activity = new MarkStaleChunksActivity({ dsn });

  let pageCounter = 0;

  const cleanup = async (): Promise<void> => {
    await pool.query("DELETE FROM core.confluence_chunks WHERE space_key = $1", [TEST_SPACE]);
  };

  // Seed one chunk with a chosen age + label set + status.
  const seedChunk = async (args: {
    daysOld: number;
    labels: ReadonlyArray<string>;
    status?: string;
    deleted?: boolean;
  }): Promise<string> => {
    pageCounter += 1;
    const pageId = `p${pageCounter}`;
    await pool.query(
      `INSERT INTO core.confluence_chunks
         (space_key, page_id, page_title, version, chunk_index, chunk_text, content_sha256,
          embedding, labels, page_status, last_modified_at, deleted_at, token_count)
       VALUES ($1, $2, 'T', 1, 0, 'body', $3,
          CAST($4 AS vector), $5::text[], $6, now() - make_interval(days => $7),
          ${args.deleted ? "now()" : "NULL"}, 10)`,
      [
        TEST_SPACE,
        pageId,
        `${pageCounter}`.padEnd(64, "0"),
        vec1024(1),
        args.labels as Array<string>,
        args.status ?? "active",
        args.daysOld,
      ],
    );
    return pageId;
  };

  const statusOf = async (pageId: string): Promise<{ page_status: string; stale_at: Date | null }> => {
    const r = await pool.query(
      "SELECT page_status, stale_at FROM core.confluence_chunks WHERE space_key = $1 AND page_id = $2",
      [TEST_SPACE, pageId],
    );
    return r.rows[0];
  };

  beforeAll(async () => {
    await pool.query("SELECT 1 FROM core.confluence_chunks WHERE false");
    await cleanup();
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await disposeAllPools();
  });

  it("flips a security_policy chunk older than 90d to stale (security threshold)", async () => {
    const stale = await seedChunk({ daysOld: 100, labels: ["topic:security_policy"] });
    const fresh = await seedChunk({ daysOld: 30, labels: ["topic:security_policy"] });

    const out = await activity.markStaleChunks({ schema_version: 1 });
    expect(out.threshold_days_security_policy).toBe(90);
    expect(out.threshold_days_default).toBe(180);
    expect(out.chunks_marked_stale_security_policy).toBeGreaterThanOrEqual(1);

    expect((await statusOf(stale)).page_status).toBe("stale");
    expect((await statusOf(stale)).stale_at).not.toBeNull();
    expect((await statusOf(fresh)).page_status).toBe("active");
  });

  it("flips a non-security chunk older than 180d to stale (default threshold) but NOT a 100d one", async () => {
    const old = await seedChunk({ daysOld: 200, labels: ["lang:python"] });
    const mid = await seedChunk({ daysOld: 100, labels: ["lang:python"] });

    const out = await activity.markStaleChunks({ schema_version: 1 });
    expect(out.chunks_marked_stale_default).toBeGreaterThanOrEqual(1);

    expect((await statusOf(old)).page_status).toBe("stale");
    // 100d < 180d default threshold → stays active.
    expect((await statusOf(mid)).page_status).toBe("active");
  });

  it("a security_policy chunk between 90d and 180d is marked by the SECURITY pass, not double-counted by default", async () => {
    // 120d: > 90 (security) but it carries topic:security_policy so the default pass EXCLUDES it.
    const sec = await seedChunk({ daysOld: 120, labels: ["topic:security_policy"] });

    const out = await activity.markStaleChunks({ schema_version: 1 });
    expect(out.chunks_marked_stale_security_policy).toBe(1);
    // The default pass filters out security_policy chunks, so it should not have counted this one.
    expect(out.chunks_marked_stale_default).toBe(0);
    expect((await statusOf(sec)).page_status).toBe("stale");
  });

  it("never touches a soft-deleted chunk", async () => {
    const deleted = await seedChunk({ daysOld: 500, labels: ["lang:python"], deleted: true });
    await activity.markStaleChunks({ schema_version: 1 });
    // deleted rows keep their original page_status (active) — the UPDATE filters deleted_at IS NULL.
    expect((await statusOf(deleted)).page_status).toBe("active");
  });
});
