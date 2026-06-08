// Real-DB integration test for `list_active_confluence_spaces_activity` — the 1:1 TS port of the frozen
// Python vendor/codemaster-py/codemaster/activities/list_active_confluence_spaces.py.
//
// Runs ONLY when CODEMASTER_PG_CORE_DSN is set (the shared describeDb gate) — pointing at the DISPOSABLE
// Postgres (postgresql://postgres:postgres@localhost:5434/codemaster). SKIPS otherwise. NEVER touches
// the in-cluster DB; every seeded core.integrations row is cleaned up.
//
// Coverage: returns enabled confluence_space integrations ordered by space_key; an `enabled = FALSE`
// row is excluded; the space_key is extracted from config_json->>'space_key' (sidestepping the asyncpg
// JSONB gotcha).

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { ListActiveConfluenceSpacesActivity } from "#backend/activities/list_active_confluence_spaces.activity.js";

import { disposeAllPools, getPool } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// Unique space_key prefix per file run so concurrent suites never collide and cleanup is surgical.
const SK_PREFIX = `ZZINTTEST_SPACES_${process.pid}_`;

describeDb("list_active_confluence_spaces_activity (integration)", () => {
  const dsn = INTEGRATION_DSN as string;
  const pool = getPool(dsn);
  const activity = new ListActiveConfluenceSpacesActivity({ dsn });

  const cleanup = async (): Promise<void> => {
    await pool.query(
      "DELETE FROM core.integrations WHERE kind = 'confluence_space' AND config_json->>'space_key' LIKE $1",
      [`${SK_PREFIX}%`],
    );
  };

  const seedSpace = async (spaceKey: string, enabled: boolean): Promise<void> => {
    await pool.query(
      `INSERT INTO core.integrations (kind, config_json, enabled, trust_tier)
       VALUES ('confluence_space', $1::jsonb, $2, 'trusted')`,
      [JSON.stringify({ space_key: spaceKey }), enabled],
    );
  };

  beforeAll(async () => {
    await pool.query("SELECT 1 FROM core.integrations WHERE false");
    await cleanup();
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await disposeAllPools();
  });

  it("returns enabled confluence_space rows ordered by space_key", async () => {
    // Seed out of order; the activity must return them sorted by space_key.
    await seedSpace(`${SK_PREFIX}CHARLIE`, true);
    await seedSpace(`${SK_PREFIX}ALPHA`, true);
    await seedSpace(`${SK_PREFIX}BRAVO`, true);

    const out = await activity.listActiveSpaces({ schema_version: 1 });
    const ours = out.spaces.filter((s) => s.space_key.startsWith(SK_PREFIX));
    expect(ours.map((s) => s.space_key)).toEqual([
      `${SK_PREFIX}ALPHA`,
      `${SK_PREFIX}BRAVO`,
      `${SK_PREFIX}CHARLIE`,
    ]);
    // Every returned space carries a real integration_id UUID.
    for (const s of ours) {
      expect(s.integration_id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("excludes a disabled (enabled = FALSE) confluence_space row", async () => {
    await seedSpace(`${SK_PREFIX}ON`, true);
    await seedSpace(`${SK_PREFIX}OFF`, false);

    const out = await activity.listActiveSpaces({ schema_version: 1 });
    const keys = out.spaces.filter((s) => s.space_key.startsWith(SK_PREFIX)).map((s) => s.space_key);
    expect(keys).toEqual([`${SK_PREFIX}ON`]);
  });
});
