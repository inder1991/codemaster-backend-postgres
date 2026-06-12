/**
 * Integration tests for the W1.3 RH9 Bedrock re-ranker admin config surface against the DISPOSABLE
 * Postgres (NEVER the cluster). Two layers, mirroring admin_llm_config.integration.test.ts:
 *
 *   1. storage — readRerankSettings / upsertRerankSettings over core.rerank_settings (migration
 *      0047): the platform-singleton row the admin PUT persists and the retrieval wiring reads.
 *   2. routes — GET/PUT /api/admin/rerank-config (added in the routes slice).
 *
 * Runs ONLY when CODEMASTER_PG_CORE_DSN is set; SKIPS otherwise (the _db.ts gate).
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import {
  readRerankSettings,
  upsertRerankSettings,
} from "#backend/api/admin/llm_catalog_write.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const UPDATER = "abababab-1111-2222-3333-444444444444";
const NOW = new Date("2026-06-12T12:00:00.000Z");

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.rerank_settings`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
});

// Test order is SHUFFLED repo-wide (vitest sequence.shuffle, the pytest-randomly mirror) — every
// test below starts from a clean singleton and seeds its own state.
beforeEach(async () => {
  if (!INTEGRATION_DSN) return;
  await cleanup();
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

describeDb("admin rerank-config storage (disposable DB)", () => {
  it("readRerankSettings: null before the operator ever saves (the DEFAULT-OFF posture)", async () => {
    expect(await readRerankSettings(db)).toBeNull();
  });

  it("upsertRerankSettings: insert then read back the platform-singleton row", async () => {
    await upsertRerankSettings(db, {
      enabled: true,
      modelId: "cohere.rerank-v3-5:0",
      region: "us-west-2",
      topN: 20,
      updatedAt: NOW,
      updatedByUserId: UPDATER,
    });
    const row = await readRerankSettings(db);
    expect(row).toEqual({
      enabled: true,
      modelId: "cohere.rerank-v3-5:0",
      region: "us-west-2",
      topN: 20,
      updatedAt: NOW,
      updatedByUserId: UPDATER,
    });
  });

  it("upsertRerankSettings: a second save UPDATES the singleton (no second row)", async () => {
    await upsertRerankSettings(db, {
      enabled: true,
      modelId: "cohere.rerank-v3-5:0",
      region: "us-west-2",
      topN: 20,
      updatedAt: NOW,
      updatedByUserId: UPDATER,
    });
    const later = new Date("2026-06-12T13:00:00.000Z");
    await upsertRerankSettings(db, {
      enabled: false,
      modelId: "amazon.rerank-v1:0",
      region: null,
      topN: 10,
      updatedAt: later,
      updatedByUserId: UPDATER,
    });
    const row = await readRerankSettings(db);
    expect(row?.enabled).toBe(false);
    expect(row?.modelId).toBe("amazon.rerank-v1:0");
    expect(row?.region).toBeNull();
    expect(row?.topN).toBe(10);
    expect(row?.updatedAt).toEqual(later);
    const count = await sql<{ n: string }>`SELECT count(*) AS n FROM core.rerank_settings`.execute(db);
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it("top_n outside [1,100] is refused by the CHECK constraint (defence-in-depth under Zod)", async () => {
    await expect(
      upsertRerankSettings(db, {
        enabled: true,
        modelId: "cohere.rerank-v3-5:0",
        region: null,
        topN: 0,
        updatedAt: NOW,
        updatedByUserId: UPDATER,
      }),
    ).rejects.toThrow(/rerank_settings|check/i);
  });
});
