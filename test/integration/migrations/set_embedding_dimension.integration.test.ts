import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";

import { INTEGRATION_DSN, describeDb } from "../_db.js";
import { setEmbeddingDimension, validateDim } from "../../../scripts/set_embedding_dimension.js";

const TEST_DIM = 512;
const VECTOR_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["core.chunk_embeddings", "embedding"],
  ["core.knowledge_chunks", "vector"],
  ["core.confluence_chunks", "embedding"],
  ["cache.cache_embeddings", "embedding"],
];

describeDb("set_embedding_dimension resizes the EMPTY pgvector columns", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: INTEGRATION_DSN, max: 2 });
  });
  afterAll(async () => {
    // Restore the shared disposable DB to the 1024 default so later runs see the baseline width.
    await setEmbeddingDimension({ pool, dim: 1024 });
    await pool?.end();
  });

  async function dim(table: string, col: string): Promise<number> {
    const r = await pool.query<{ d: number }>(
      `SELECT atttypmod AS d FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2`,
      [table, col],
    );
    return r.rows[0]!.d;
  }

  it("validateDim rejects a dimension above the pgvector HNSW cap", () => {
    expect(() => validateDim(4096)).toThrow(/2000/);
    expect(() => validateDim(0)).toThrow();
    expect(validateDim(768)).toBe(768);
  });

  it("resizes all four vector columns + the seed generation + the runtime-state record", async () => {
    await setEmbeddingDimension({ pool, dim: TEST_DIM });
    for (const [t, c] of VECTOR_COLUMNS) {
      expect(await dim(t, c)).toBe(TEST_DIM);
    }
    const g = await pool.query<{ embedding_dimension: number }>(
      `SELECT embedding_dimension FROM core.embedding_generations WHERE generation_id = 1`,
    );
    expect(g.rows[0]!.embedding_dimension).toBe(TEST_DIM);
    const s = await pool.query<{ active_embedding_dimension: number }>(
      `SELECT active_embedding_dimension FROM core.embedder_runtime_state WHERE singleton = true`,
    );
    expect(s.rows[0]!.active_embedding_dimension).toBe(TEST_DIM);
  });
});
