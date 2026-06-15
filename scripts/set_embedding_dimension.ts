/*
 * One-shot (GREENFIELD, pre-ingest): resize the EMPTY pgvector columns + recreate their HNSW indexes to a
 * target embedding dimension, and record it on the seed generation + the runtime-state singleton. Refuses
 * to run against a non-empty corpus (a dimension change on live data is the day-2 re-embed path).
 *
 * Run with the OWNER/migration DSN (this runs DDL):
 *   CODEMASTER_PG_CORE_DSN=postgresql://owner:...@host:5432/db tsx scripts/set_embedding_dimension.ts 768
 * The dimension also comes from CODEMASTER_EMBEDDING_DIMENSION when no CLI arg is given, so it matches the
 * runtime EMBEDDING_DIM the app reads from the same env.
 */
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { MAX_HNSW_VECTOR_DIM } from "#backend/adapters/embeddings_port.js";

type VectorTarget = { table: string; col: string; index: string | null; indexWhere: string };

/** The pgvector columns + their HNSW indexes (verified against migrations 0001/0005). */
const VECTOR_TARGETS: ReadonlyArray<VectorTarget> = [
  { table: "core.chunk_embeddings", col: "embedding", index: "chunk_embeddings_hnsw_idx", indexWhere: "" },
  { table: "core.knowledge_chunks", col: "vector", index: "idx_knowledge_chunks_vector_hnsw", indexWhere: "" },
  {
    table: "core.confluence_chunks",
    col: "embedding",
    index: "confluence_chunks_embedding_hnsw_live",
    indexWhere: "WHERE superseded_at IS NULL AND deleted_at IS NULL AND quarantined = false",
  },
  { table: "cache.cache_embeddings", col: "embedding", index: null, indexWhere: "" },
];

export function validateDim(raw: string | number | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_HNSW_VECTOR_DIM) {
    throw new Error(
      `embedding dimension must be an integer in 1..${MAX_HNSW_VECTOR_DIM} ` +
        `(pgvector HNSW cap; Matryoshka-truncate a larger model). Got: ${String(raw)}`,
    );
  }
  return n;
}

/** Refuse to resize unless the DB is a fresh greenfield BASELINE — only the seed generation (id 1),
 *  active, with no pending generation. (Empty vector tables alone are not enough: a pending generation
 *  can exist before any chunk is ingested.) */
export function assertGreenfieldBaseline(state: {
  activeGeneration: number;
  pendingGeneration: number | null;
  generationCount: number;
}): void {
  if (state.activeGeneration !== 1 || state.pendingGeneration !== null || state.generationCount !== 1) {
    throw new Error(
      `refusing to resize: not a greenfield baseline ` +
        `(active_generation=${state.activeGeneration}, pending_generation=${String(state.pendingGeneration)}, ` +
        `generations=${state.generationCount}) — a dimension change once generations exist is the day-2 ` +
        `re-embed path, not this one-shot.`,
    );
  }
}

/** Pure: the ordered DDL/DML to resize the corpus to `dim`. */
export function buildResizeStatements(dim: number): ReadonlyArray<string> {
  const out: Array<string> = [];
  for (const t of VECTOR_TARGETS) {
    const schema = t.table.split(".")[0];
    if (t.index !== null) {
      out.push(`DROP INDEX IF EXISTS ${schema}.${t.index}`);
    }
    out.push(`ALTER TABLE ${t.table} ALTER COLUMN ${t.col} TYPE public.vector(${dim})`);
    if (t.index !== null) {
      const where = t.indexWhere === "" ? "" : ` ${t.indexWhere}`;
      out.push(
        `CREATE INDEX ${t.index} ON ${t.table} USING hnsw (${t.col} public.vector_cosine_ops) ` +
          `WITH (m='16', ef_construction='64')${where}`,
      );
    }
  }
  out.push(`UPDATE core.embedding_generations SET embedding_dimension = ${dim} WHERE generation_id = 1`);
  out.push(`UPDATE core.embedder_runtime_state SET active_embedding_dimension = ${dim} WHERE singleton = true`);
  return out;
}

/** Resize after asserting every vector table is EMPTY (greenfield guard); one transaction. */
export async function setEmbeddingDimension(deps: { pool: Pool; dim: number }): Promise<void> {
  const { pool, dim } = deps;
  for (const t of VECTOR_TARGETS) {
    const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t.table}`);
    const rows = r.rows[0]?.n ?? 0;
    if (rows > 0) {
      throw new Error(
        `refusing to resize non-empty ${t.table} (${rows} rows) — a dimension change on a live corpus ` +
          `is the day-2 re-embed path, not this one-shot.`,
      );
    }
  }
  const st = await pool.query<{ active_generation: number; pending_generation: number | null }>(
    // active_generation/pending_generation are bigint — pg returns those as strings; cast to int.
    `SELECT active_generation::int AS active_generation, pending_generation::int AS pending_generation
       FROM core.embedder_runtime_state WHERE singleton = true`,
  );
  const gc = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM core.embedding_generations`);
  assertGreenfieldBaseline({
    activeGeneration: st.rows[0]?.active_generation ?? -1,
    pendingGeneration: st.rows[0]?.pending_generation ?? null,
    generationCount: gc.rows[0]?.n ?? -1,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const stmt of buildResizeStatements(dim)) {
      await client.query(stmt);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const dim = validateDim(process.argv[2] ?? process.env.CODEMASTER_EMBEDDING_DIMENSION);
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error("CODEMASTER_PG_CORE_DSN is required (use the OWNER/migration DSN — this runs DDL).");
  }
  const pool = new Pool({ connectionString: dsn });
  try {
    await setEmbeddingDimension({ pool, dim });
    process.stdout.write(`embedding dimension set to ${dim} (empty pgvector columns resized)\n`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
