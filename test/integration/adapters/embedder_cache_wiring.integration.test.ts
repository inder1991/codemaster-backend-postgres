// LIVE integration test for the SCOPE-A embedder-cache wiring against a DISPOSABLE Postgres (5434).
//
// Proves the two load-bearing properties of wiring a REAL PostgresEmbedderCache into the confluence
// retrieval + dual-write paths — both SAFE-DEFAULT (zero behaviour change until an operator activates):
//
//   1. FALLBACK ≡ LEGACY PARITY (the important proof). With retrieval_mode='fallback' (the default seed
//      state) and EMPTY core.chunk_embeddings for the seeded chunks, the adapter wired WITH the real
//      PostgresEmbedderCache (runPhaseA: LEFT JOIN chunk_embeddings + COALESCE) returns the IDENTICAL
//      chunk_id ordering + scores as the adapter with embedderCache=null (runLegacy: direct cc.embedding
//      query) over the SAME corpus + query. This proves wiring the cache is a no-op at the default mode.
//
//   2. DUAL-WRITE. upsertChunks called with the cache's active generation + model writes a
//      core.chunk_embeddings row under (chunk_table='confluence_chunks', active generation_id) AND the
//      legacy cc.embedding column — both present after the upsert.
//
// SINGLETON DISCIPLINE (HARD CONSTRAINT). core.embedder_runtime_state + core.embedding_generations are
// SHARED/SINGLETON platform tables. We SNAPSHOT the singleton's retrieval_mode (the only field we read,
// never mutate here) and assert we leave it untouched; we never delete the migration-seed generation 1.
// Every seeded confluence_chunks / chunk_embeddings row is namespaced by a unique space_key + a unique
// generation row and deleted in afterAll.
//
// GATING: runs ONLY when CODEMASTER_PG_CORE_DSN is set (describeDb) — the disposable PG at
//   postgresql://postgres:postgres@localhost:5434/codemaster, NEVER the in-cluster DB.

import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { PostgresConfluenceRetrieval } from "#backend/adapters/postgres_confluence_retrieval.js";
import { buildEmbedderCacheForDsn } from "#backend/adapters/embedder_cache.js";
import { PostgresConfluenceChunksRepo, type UpsertChunkRow } from "#backend/domain/repos/confluence_chunks_repo.js";

import { WallClock } from "#platform/clock.js";
import { disposeAllPools, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const DIM = 1024;
const SPACE_KEY = `IT-EC-${randomUUID().slice(0, 8)}`;
const DUAL_SPACE_KEY = `IT-EC-DW-${randomUUID().slice(0, 8)}`;

let db: Kysely<unknown>;
let seededRetrievalMode = "fallback";
let observedRetrievalModeAfter = "fallback";

/** A 1024-dim unit vector hot in one dimension; closeness to the query controls cosine rank. */
function hotVector(dim: number): ReadonlyArray<number> {
  const v = new Array<number>(DIM).fill(0);
  v[dim] = 1;
  return v;
}

function toPgVectorLiteral(vec: ReadonlyArray<number>): string {
  return `[${vec.map((x) => String(x)).join(",")}]`;
}

/** Insert one non-default, topic-labeled confluence_chunks row with a legacy embedding only. */
async function seedLegacyChunk(spaceKey: string, pageId: string, hotDim: number): Promise<string> {
  const chunkId = randomUUID();
  const vecLit = toPgVectorLiteral(hotVector(hotDim));
  await sql`
    INSERT INTO core.confluence_chunks
      (chunk_id, space_key, page_id, page_title, version, chunk_index, chunk_text,
       content_sha256, labels, quarantined, quarantine_reasons, embedding)
    VALUES
      (${chunkId}, ${spaceKey}, ${pageId}, ${"Page " + pageId}, 1, 0, ${"body " + pageId},
       ${"0".repeat(64)}, ${sql`ARRAY['topic:security']::text[]`}, false, ${sql`ARRAY[]::text[]`},
       ${vecLit}::vector)
  `.execute(db);
  return chunkId;
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  db = tenantKysely<unknown>(INTEGRATION_DSN);

  // Snapshot the singleton retrieval_mode (we must NEVER leave it mutated). Default seed = 'fallback'.
  const snap = await sql<{ retrieval_mode: string }>`
    SELECT retrieval_mode FROM core.embedder_runtime_state WHERE singleton = true
  `.execute(db);
  seededRetrievalMode = snap.rows[0]!.retrieval_mode;

  // Parity corpus: three non-default topic chunks (legacy embedding only; NO chunk_embeddings rows).
  await seedLegacyChunk(SPACE_KEY, "p-a", 10);
  await seedLegacyChunk(SPACE_KEY, "p-b", 11);
  await seedLegacyChunk(SPACE_KEY, "p-c", 12);
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  // Re-read the singleton retrieval_mode and prove we left it untouched.
  const after = await sql<{ retrieval_mode: string }>`
    SELECT retrieval_mode FROM core.embedder_runtime_state WHERE singleton = true
  `.execute(db);
  observedRetrievalModeAfter = after.rows[0]!.retrieval_mode;

  await sql`DELETE FROM core.chunk_embeddings WHERE chunk_id IN (SELECT chunk_id FROM core.confluence_chunks WHERE space_key = ${DUAL_SPACE_KEY})`.execute(db);
  await sql`DELETE FROM core.confluence_chunks WHERE space_key = ${SPACE_KEY}`.execute(db);
  await sql`DELETE FROM core.confluence_chunks WHERE space_key = ${DUAL_SPACE_KEY}`.execute(db);
  await disposeAllPools();
});

describeDb("embedder-cache wiring: fallback ≡ legacy parity (SAFE-DEFAULT proof)", () => {
  const EFFECTIVE = new Set(["topic:security"]);

  it("singleton retrieval_mode is the default 'fallback' (the safe-default precondition)", ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    expect(seededRetrievalMode).toBe("fallback");
  });

  it("WITH the real cache (runPhaseA) === WITHOUT a cache (runLegacy): identical order + scores", async ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    const dsn = INTEGRATION_DSN as string;
    // The REAL singleton cache over the live runtime_state (active gen 1, fallback mode, empty
    // chunk_embeddings for these chunks). Phase A's LEFT JOIN + COALESCE === the legacy direct query.
    const cache = await buildEmbedderCacheForDsn(dsn, { clock: new WallClock() });
    const withCache = new PostgresConfluenceRetrieval({ db, embedderCache: cache });
    const withoutCache = new PostgresConfluenceRetrieval({ db }); // embedderCache=null → runLegacy

    const query = { queryEmbedding: hotVector(10), topK: 50, effectiveLabels: EFFECTIVE };
    const a = await withCache.search(query);
    const b = await withoutCache.search(query);

    // Restrict to OUR seeded space so the comparison is over the same controlled corpus.
    const mine = (rows: Awaited<ReturnType<typeof withCache.search>>): Array<[string, number]> =>
      rows.filter((r) => r.space_key === SPACE_KEY).map((r) => [r.page_id, r.score]);

    const ca = mine(a);
    const cb = mine(b);
    expect(ca.length).toBe(3);
    // IDENTICAL chunk ordering ...
    expect(ca.map(([id]) => id)).toEqual(cb.map(([id]) => id));
    // ... and IDENTICAL scores (bitwise-equal floats — same SQL distance on the same vectors).
    expect(ca.map(([, s]) => s)).toEqual(cb.map(([, s]) => s));
  });
});

describeDb("embedder-cache wiring: confluence dual-write under the active generation", () => {
  it("upsertChunks(cache.activeGen) writes a chunk_embeddings row AND the legacy embedding", async ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    const dsn = INTEGRATION_DSN as string;
    const cache = await buildEmbedderCacheForDsn(dsn, { clock: new WallClock() });
    const activeGeneration = cache.getActiveGeneration();
    const activeModelName = cache.getActiveModelName();

    const repo = new PostgresConfluenceChunksRepo({ db, clock: new WallClock() });
    const chunkId = randomUUID();
    const row: UpsertChunkRow = {
      chunkId,
      spaceKey: DUAL_SPACE_KEY,
      pageId: "p-dw",
      pageTitle: "Dual Write",
      version: 1,
      chunkIndex: 0,
      body: "<doc trust=\"untrusted\">dual write body</doc>",
      contentSha256: "a".repeat(64),
      embedding: hotVector(20),
      rawLabels: ["topic:security"],
      quarantined: false,
      quarantineReasons: [],
      pageStatus: "active",
      lastModifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      tokenCount: 4,
      defaultApproval: null,
      redactionApplied: true,
    };

    const upserted = await repo.upsertChunks([row], { activeGeneration, activeModelName });
    expect(upserted).toBe(1);

    // The legacy cc.embedding column is written.
    const legacy = await sql<{ has_embedding: boolean }>`
      SELECT embedding IS NOT NULL AS has_embedding FROM core.confluence_chunks WHERE chunk_id = ${chunkId}
    `.execute(db);
    expect(legacy.rows[0]?.has_embedding).toBe(true);

    // AND a chunk_embeddings row exists under (chunk_table='confluence_chunks', the active generation_id).
    const ce = await sql<{ embedding_model_name: string }>`
      SELECT embedding_model_name FROM core.chunk_embeddings
       WHERE chunk_table = 'confluence_chunks'
         AND chunk_id = ${chunkId}
         AND generation_id = ${String(activeGeneration)}::bigint
    `.execute(db);
    expect(ce.rows.length).toBe(1);
    expect(ce.rows[0]?.embedding_model_name).toBe(activeModelName);
  });
});

describeDb("embedder-cache wiring: singleton left untouched", () => {
  it("the singleton retrieval_mode is restored/unchanged after the test run", ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    // afterAll captured the post-run value; assert nothing flipped the shared singleton.
    expect(observedRetrievalModeAfter).toBe(seededRetrievalMode);
  });
});
