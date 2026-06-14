// Real-DB integration test for the Confluence chunks data-layer repo — the 1:1 TS port of the frozen
// Python vendor/codemaster-py/codemaster/domain/repos/confluence_chunks_repo.py.
//
// Runs ONLY when CODEMASTER_PG_CORE_DSN is set (the shared describeDb gate) — pointing at the
// DISPOSABLE Postgres (postgresql://postgres:postgres@localhost:5434/codemaster) with migrations
// applied. SKIPS otherwise so validate-fast stays green without a DB. NEVER hard-defaults the DSN and
// NEVER touches the in-cluster DB. Every seeded row is scoped to a unique test space_key and cleaned
// up in afterEach/afterAll.
//
// Coverage (the task test plan):
//  - makeChunkId determinism + Python-cross-checked canonical UUIDs (the 4 values computed by running
//    the frozen Python make_chunk_id — see the repo doc + the agent report).
//  - upsertChunks: NEW rows insert; re-upsert SAME (page_id, version, chunk_index) UPDATES not
//    duplicates (ON CONFLICT on confluence_chunks_natural_key path via the chunk_id PK); stale_at reset
//    to NULL on an active write (audit P1-1); quarantined-chunk path; default_approval JSONB round-trip.
//  - findExistingChunkEmbedding: returns the prior embedding (idempotency skip) for (chunk_id, sha) and
//    null when sha mismatches or the row is soft-deleted.
//  - reconcileDeletions: soft-deletes (deleted_at) chunks for pages absent from the live set.

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import {
  PostgresConfluenceChunksRepo,
  makeChunkId,
  type UpsertChunkRow,
} from "#backend/domain/repos/confluence_chunks_repo.js";

import { WallClock } from "#platform/clock.js";
import { disposeAllPools, getPool, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// A unique space_key per file run so concurrent suites never collide and cleanup is surgical.
const TEST_SPACE = `ZZINTTEST_CHUNKS_${process.pid}`;

// Build a 1024-dim embedding deterministically (the column is vector(1024)).
function vec1024(seed: number): Array<number> {
  return Array.from({ length: 1024 }, (_, i) => (seed + i) / 10000);
}

function makeRow(overrides: Partial<UpsertChunkRow> & Pick<UpsertChunkRow, "pageId" | "version" | "chunkIndex">): UpsertChunkRow {
  const chunkId = makeChunkId({
    spaceKey: TEST_SPACE,
    pageId: overrides.pageId,
    version: overrides.version,
    chunkIndex: overrides.chunkIndex,
  });
  return {
    chunkId,
    spaceKey: TEST_SPACE,
    pageTitle: "Test Page",
    body: '<doc trust="untrusted">hello</doc>',
    contentSha256: "a".repeat(64),
    embedding: vec1024(1),
    rawLabels: [],
    quarantined: false,
    quarantineReasons: [],
    pageStatus: "active",
    lastModifiedAt: new Date("2026-05-01T00:00:00.000Z"),
    tokenCount: 10,
    defaultApproval: null,
    redactionApplied: true,
    // `...overrides` last: it carries the required pageId/version/chunkIndex (the Pick) plus any
    // per-test column overrides, and overwrites the defaults above.
    ...overrides,
  };
}

describeDb("PostgresConfluenceChunksRepo (integration)", () => {
  const db = tenantKysely<unknown>(INTEGRATION_DSN as string);
  const repo = new PostgresConfluenceChunksRepo({ db, clock: new WallClock() });
  const pool = getPool(INTEGRATION_DSN as string);

  const cleanup = async (): Promise<void> => {
    await pool.query("DELETE FROM core.chunk_embeddings WHERE chunk_table = 'confluence_chunks' AND chunk_id IN (SELECT chunk_id FROM core.confluence_chunks WHERE space_key = $1)", [TEST_SPACE]);
    await pool.query("DELETE FROM core.confluence_chunks WHERE space_key = $1", [TEST_SPACE]);
  };

  beforeAll(async () => {
    await pool.query("SELECT 1 FROM core.confluence_chunks WHERE false");
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await disposeAllPools();
  });

  it("makeChunkId is deterministic and matches the frozen Python make_chunk_id (uuid5 NAMESPACE_URL)", () => {
    // Cross-checked by running the frozen Python make_chunk_id on the SAME 4 inputs (agent report).
    expect(makeChunkId({ spaceKey: "ENG", pageId: "12345", version: 3, chunkIndex: 0 })).toBe(
      "987f2e77-33cd-5198-aa6e-cf41925e4d37",
    );
    expect(makeChunkId({ spaceKey: "ENG", pageId: "12345", version: 3, chunkIndex: 1 })).toBe(
      "495320be-deeb-5187-97b7-fb5b8b6e7b5e",
    );
    // version is part of the seed (F-36): bumping the version yields a fresh chunk_id.
    expect(makeChunkId({ spaceKey: "ENG", pageId: "12345", version: 4, chunkIndex: 0 })).toBe(
      "bbcfdf9c-f3d1-5719-97dc-fb8f801495d9",
    );
    expect(makeChunkId({ spaceKey: "SEC", pageId: "page-9", version: 1, chunkIndex: 0 })).toBe(
      "d4886993-d14e-5350-a8cd-de5fbee32ee7",
    );
    // Determinism: same inputs → same id.
    expect(makeChunkId({ spaceKey: "ENG", pageId: "12345", version: 3, chunkIndex: 0 })).toBe(
      makeChunkId({ spaceKey: "ENG", pageId: "12345", version: 3, chunkIndex: 0 }),
    );
  });

  it("upsertChunks inserts NEW rows and canonicalizes raw labels", async () => {
    const n = await repo.upsertChunks([
      makeRow({ pageId: "p1", version: 1, chunkIndex: 0, rawLabels: ["python", "security"] }),
      makeRow({ pageId: "p1", version: 1, chunkIndex: 1 }),
    ]);
    expect(n).toBe(2);

    const r = await pool.query(
      "SELECT page_id, version, chunk_index, labels, stale_at, token_count, redaction_applied FROM core.confluence_chunks WHERE space_key = $1 ORDER BY chunk_index",
      [TEST_SPACE],
    );
    expect(r.rowCount).toBe(2);
    // canonicalize('python') = 'lang:python'; canonicalize('security') = 'topic:security'.
    expect(r.rows[0].labels).toEqual(["lang:python", "topic:security"]);
    expect(r.rows[0].stale_at).toBeNull();
    expect(r.rows[0].token_count).toBe(10);
    expect(r.rows[0].redaction_applied).toBe(true);
  });

  it("re-upsert of the SAME (page_id, version, chunk_index) UPDATES in place (no duplicate)", async () => {
    await repo.upsertChunks([makeRow({ pageId: "p2", version: 1, chunkIndex: 0, pageTitle: "Original" })]);
    await repo.upsertChunks([makeRow({ pageId: "p2", version: 1, chunkIndex: 0, pageTitle: "Updated" })]);

    const r = await pool.query(
      "SELECT page_title FROM core.confluence_chunks WHERE space_key = $1 AND page_id = 'p2'",
      [TEST_SPACE],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].page_title).toBe("Updated");
  });

  it("an active write resets stale_at to NULL (audit P1-1)", async () => {
    const row = makeRow({ pageId: "p3", version: 1, chunkIndex: 0 });
    await repo.upsertChunks([row]);
    // Simulate mark_stale: set stale_at to a non-null value out of band.
    await pool.query(
      "UPDATE core.confluence_chunks SET stale_at = now() WHERE chunk_id = $1",
      [row.chunkId],
    );
    const before = await pool.query("SELECT stale_at FROM core.confluence_chunks WHERE chunk_id = $1", [row.chunkId]);
    expect(before.rows[0].stale_at).not.toBeNull();

    // Re-sync (active write) MUST clear stale_at.
    await repo.upsertChunks([row]);
    const after = await pool.query("SELECT stale_at FROM core.confluence_chunks WHERE chunk_id = $1", [row.chunkId]);
    expect(after.rows[0].stale_at).toBeNull();
  });

  it("quarantined chunk path persists quarantined=true + reasons (biconditional satisfied)", async () => {
    await repo.upsertChunks([
      makeRow({
        pageId: "p4",
        version: 1,
        chunkIndex: 0,
        quarantined: true,
        quarantineReasons: ["prompt_injection", "secret"],
      }),
    ]);
    const r = await pool.query(
      "SELECT quarantined, quarantine_reasons FROM core.confluence_chunks WHERE space_key = $1 AND page_id = 'p4'",
      [TEST_SPACE],
    );
    expect(r.rows[0].quarantined).toBe(true);
    expect(r.rows[0].quarantine_reasons).toEqual(["prompt_injection", "secret"]);
  });

  it("default_approval JSONB round-trips for a 'default'-labeled chunk", async () => {
    const defaultApproval = {
      schema_version: 1 as const,
      approver_email: "approver@example.com",
      approved_at_utc: "2026-05-01T00:00:00+00:00",
      approval_artifact_url: "https://wiki.example.com/approval/1",
      scope_justification: "Approved for universal default scope by the platform team.",
      default_scope: "universal" as const,
    };
    await repo.upsertChunks([
      makeRow({
        pageId: "p5",
        version: 1,
        chunkIndex: 0,
        rawLabels: ["default"],
        defaultApproval,
      }),
    ]);
    const r = await pool.query(
      "SELECT labels, default_approval FROM core.confluence_chunks WHERE space_key = $1 AND page_id = 'p5'",
      [TEST_SPACE],
    );
    expect(r.rows[0].labels).toEqual(["default"]);
    expect(r.rows[0].default_approval).toEqual(defaultApproval);
  });

  it("upsertChunks rejects a 'default'-labeled chunk that arrives without default_approval", async () => {
    await expect(
      repo.upsertChunks([
        makeRow({ pageId: "p6", version: 1, chunkIndex: 0, rawLabels: ["default"], defaultApproval: null }),
      ]),
    ).rejects.toThrow(/default-tagged chunk without default_approval/);
  });

  it("findExistingChunkEmbedding returns the prior embedding for (chunk_id, sha) [idempotency skip]", async () => {
    const emb = vec1024(7);
    const row = makeRow({ pageId: "p7", version: 1, chunkIndex: 0, embedding: emb, contentSha256: "b".repeat(64) });
    await repo.upsertChunks([row]);

    const got = await repo.findExistingChunkEmbedding({ chunkId: row.chunkId, contentSha256: "b".repeat(64) });
    expect(got).not.toBeNull();
    expect(got).toHaveLength(1024);
    // The stored vector round-trips to the same values (pgvector text round-trip). vec1024(7) is
    // (7 + i) / 10000, so element 0 = 0.0007 and element 1023 = 0.103.
    const gotArr = [...(got ?? [])];
    expect(gotArr[0]).toBeCloseTo((7 + 0) / 10000, 6);
    expect(gotArr[1023]).toBeCloseTo((7 + 1023) / 10000, 6);

    // sha mismatch → null (a content change must NOT reuse the stale vector).
    expect(await repo.findExistingChunkEmbedding({ chunkId: row.chunkId, contentSha256: "c".repeat(64) })).toBeNull();
  });

  it("findExistingChunkEmbedding returns null for a soft-deleted (deleted_at) chunk", async () => {
    const row = makeRow({ pageId: "p8", version: 1, chunkIndex: 0, contentSha256: "d".repeat(64) });
    await repo.upsertChunks([row]);
    await pool.query("UPDATE core.confluence_chunks SET deleted_at = now() WHERE chunk_id = $1", [row.chunkId]);
    expect(await repo.findExistingChunkEmbedding({ chunkId: row.chunkId, contentSha256: "d".repeat(64) })).toBeNull();
  });

  it("reconcileDeletions soft-deletes chunks for pages absent from the live set", async () => {
    await repo.upsertChunks([
      makeRow({ pageId: "live1", version: 1, chunkIndex: 0 }),
      makeRow({ pageId: "gone1", version: 1, chunkIndex: 0 }),
      makeRow({ pageId: "gone2", version: 1, chunkIndex: 0 }),
    ]);

    const softDeleted = await repo.reconcileDeletions({ spaceKey: TEST_SPACE, livePageIds: ["live1"] });
    expect(softDeleted).toBe(2);

    const live = await pool.query(
      "SELECT page_id, deleted_at FROM core.confluence_chunks WHERE space_key = $1 ORDER BY page_id",
      [TEST_SPACE],
    );
    const byPage = Object.fromEntries(live.rows.map((row: { page_id: string; deleted_at: Date | null }) => [row.page_id, row.deleted_at]));
    expect(byPage["live1"]).toBeNull();
    expect(byPage["gone1"]).not.toBeNull();
    expect(byPage["gone2"]).not.toBeNull();

    // Idempotent: a second reconcile finds nothing new to soft-delete (already deleted_at).
    expect(await repo.reconcileDeletions({ spaceKey: TEST_SPACE, livePageIds: ["live1"] })).toBe(0);
  });

  it("dual-write to core.chunk_embeddings when active_generation + active_model_name are supplied", async () => {
    const emb = vec1024(3);
    const row = makeRow({ pageId: "p9", version: 1, chunkIndex: 0, embedding: emb, contentSha256: "e".repeat(64) });
    // Seed an embedding generation row this generation_id FK can reference, if the FK exists.
    await repo.upsertChunks([row], { activeGeneration: 1, activeModelName: "qwen3-test" });

    const r = await pool.query(
      "SELECT embedding_model_name, content_sha256 FROM core.chunk_embeddings WHERE chunk_table = 'confluence_chunks' AND chunk_id = $1 AND generation_id = 1",
      [row.chunkId],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].embedding_model_name).toBe("qwen3-test");
    expect(r.rows[0].content_sha256).toBe("e".repeat(64));
  });

  // F12 / P1-G + P1-H: a page version bump must SUPERSEDE the prior-version rows (so the existing
  // `superseded_at IS NULL` retrieval filter stops returning stale text) AND GC their dual-written
  // chunk_embeddings (no FK/cascade → otherwise the HNSW index keeps dead vectors).
  it("a version bump supersedes prior-version rows AND GCs their chunk_embeddings", async () => {
    const v1 = makeRow({ pageId: "p-sup", version: 1, chunkIndex: 0, contentSha256: "1".repeat(64) });
    await repo.upsertChunks([v1], { activeGeneration: 1, activeModelName: "qwen3-test" });
    const before = await pool.query(
      "SELECT 1 FROM core.chunk_embeddings WHERE chunk_table='confluence_chunks' AND chunk_id=$1",
      [v1.chunkId],
    );
    expect(before.rowCount).toBe(1); // v1's embedding exists

    const v2 = makeRow({ pageId: "p-sup", version: 2, chunkIndex: 0, contentSha256: "2".repeat(64) });
    await repo.upsertChunks([v2], { activeGeneration: 1, activeModelName: "qwen3-test" });

    const rows = await pool.query<{ version: number; superseded_at: Date | null }>(
      "SELECT version, superseded_at FROM core.confluence_chunks WHERE page_id='p-sup' AND space_key=$1",
      [TEST_SPACE],
    );
    const supBy = new Map(rows.rows.map((x) => [Number(x.version), x.superseded_at]));
    expect(supBy.get(1)).not.toBeNull(); // v1 superseded
    expect(supBy.get(2)).toBeNull(); // v2 current
    const after = await pool.query(
      "SELECT 1 FROM core.chunk_embeddings WHERE chunk_table='confluence_chunks' AND chunk_id=$1",
      [v1.chunkId],
    );
    expect(after.rowCount).toBe(0); // v1's embedding GC'd
  });

  it("reconcileDeletions GCs the chunk_embeddings of soft-deleted (non-live) pages", async () => {
    const row = makeRow({ pageId: "p-rec", version: 1, chunkIndex: 0, contentSha256: "3".repeat(64) });
    await repo.upsertChunks([row], { activeGeneration: 1, activeModelName: "qwen3-test" });
    await repo.reconcileDeletions({ spaceKey: TEST_SPACE, livePageIds: ["some-other-live-page"] });

    const d = await pool.query<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM core.confluence_chunks WHERE chunk_id=$1",
      [row.chunkId],
    );
    expect(d.rows[0]?.deleted_at).not.toBeNull(); // p-rec soft-deleted
    const e = await pool.query(
      "SELECT 1 FROM core.chunk_embeddings WHERE chunk_table='confluence_chunks' AND chunk_id=$1",
      [row.chunkId],
    );
    expect(e.rowCount).toBe(0); // its embedding GC'd
  });
});
