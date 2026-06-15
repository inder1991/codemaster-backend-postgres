import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";

import { INTEGRATION_DSN, describeDb } from "../_db.js";

// pgvector vector(N) columns store their dimension directly in atttypmod (= N; -1 = unconstrained).
const VECTOR_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["core.chunk_embeddings", "embedding"],
  ["core.knowledge_chunks", "vector"],
  ["core.confluence_chunks", "embedding"],
  ["cache.cache_embeddings", "embedding"],
];

describeDb("migration 0007 — active_embedding_dimension + default-1024 column widths", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: INTEGRATION_DSN, max: 2 });
  });
  afterAll(async () => {
    await pool?.end();
  });

  async function dim(table: string, col: string): Promise<number> {
    const r = await pool.query<{ d: number }>(
      `SELECT atttypmod AS d FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2`,
      [table, col],
    );
    return r.rows[0]!.d;
  }

  it("embedder_runtime_state has active_embedding_dimension defaulting to 1024", async () => {
    const r = await pool.query<{ active_embedding_dimension: number }>(
      `SELECT active_embedding_dimension FROM core.embedder_runtime_state WHERE singleton = true`,
    );
    expect(r.rows[0]!.active_embedding_dimension).toBe(1024);
  });

  it("the four pgvector columns ship at 1024 on a default deploy", async () => {
    for (const [t, c] of VECTOR_COLUMNS) {
      expect(await dim(t, c)).toBe(1024);
    }
  });
});
