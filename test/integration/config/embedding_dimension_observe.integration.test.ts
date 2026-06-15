import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { INTEGRATION_DSN, describeDb } from "../_db.js";
import { makeEmbeddingDimensionObserveDeps } from "#backend/deploy_preflight_io.js";
import { evaluateEmbeddingDimension } from "#backend/deploy_preflight.js";

describeDb("embedding-dimension observation reads the real DB widths", () => {
  let db: Kysely<unknown>;
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: INTEGRATION_DSN, max: 2 });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it("observes the active generation dim, active_embedding_dimension, and the four column widths", async () => {
    const obs = await makeEmbeddingDimensionObserveDeps({ db }).observeEmbeddingDimension();
    expect(obs.activeGenerationDim).toBe(1024);
    expect(obs.activeEmbeddingDimension).toBe(1024);
    expect(obs.columnDims).toHaveLength(4);
    for (const c of obs.columnDims) {
      expect(c.dim).toBe(1024);
    }
    // configuredDim defaults to EMBEDDING_DIM (1024 in CI) — everything agrees → no failures.
    expect(evaluateEmbeddingDimension(obs)).toEqual([]);
  });
});
