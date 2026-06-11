// W4.6 [OM9] — port the `core.flags` reader so sync_code_owners can be ENABLED without a code
// change (closes FOLLOW-UP-code-owners-v1-flag-reader). 1:1 with the frozen Python
// `codemaster/ingest/_code_owners_v1_flag.py::read_code_owners_v1_enabled` + its unit matrix
// (tests/unit/ingest/test_code_owners_v1_flag.py): True IFF the row exists AND `rollout` resolves
// to {"enabled": true}; False on absent row / missing key / malformed; NEVER raises (fail-OPEN to
// False — a flag-table blip must not block the webhook → producer chain).
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5439 DB) — never a
// shared cluster (skips when the DSN is absent, per test/integration/_db.ts).
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, expect, it } from "vitest";

import { readCodeOwnersV1Enabled } from "#backend/ingest/_code_owners_v1_flag.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;
let db: Kysely<unknown>;
if (INTEGRATION_DSN) {
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 2 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
}
afterAll(async () => {
  await db?.destroy();
});

async function seedFlag(rolloutJson: string): Promise<void> {
  await sql`
    INSERT INTO core.flags (flag_name, rollout)
    VALUES ('code_owners_v1', CAST(${rolloutJson} AS jsonb))
    ON CONFLICT (flag_name) DO UPDATE SET rollout = EXCLUDED.rollout
  `.execute(db);
}

afterEach(async () => {
  if (INTEGRATION_DSN) await sql`DELETE FROM core.flags WHERE flag_name = 'code_owners_v1'`.execute(db);
});

describeDb("readCodeOwnersV1Enabled — the core.flags reader (OM9)", () => {
  it("absent row → false (the production default-off posture)", async () => {
    expect(await readCodeOwnersV1Enabled(db)).toBe(false);
  });

  it('rollout {"enabled": true} → true', async () => {
    await seedFlag('{"enabled": true}');
    expect(await readCodeOwnersV1Enabled(db)).toBe(true);
  });

  it('rollout {"enabled": false} → false', async () => {
    await seedFlag('{"enabled": false}');
    expect(await readCodeOwnersV1Enabled(db)).toBe(false);
  });

  it("rollout missing the enabled key → false", async () => {
    await seedFlag('{"other_field": "x"}');
    expect(await readCodeOwnersV1Enabled(db)).toBe(false);
  });

  it('rollout enabled non-boolean-true ("true"/1) → false (strict `is True` parity)', async () => {
    await seedFlag('{"enabled": "true"}');
    expect(await readCodeOwnersV1Enabled(db)).toBe(false);
    await seedFlag('{"enabled": 1}');
    expect(await readCodeOwnersV1Enabled(db)).toBe(false);
  });

  it("rollout as a JSON-string payload is parsed defensively (the Python str branch)", async () => {
    await seedFlag(JSON.stringify(JSON.stringify({ enabled: true }))); // jsonb of type string
    expect(await readCodeOwnersV1Enabled(db)).toBe(true);
    await seedFlag('"not-valid-json{"');
    expect(await readCodeOwnersV1Enabled(db)).toBe(false);
  });

  it("DB error → false, NEVER raises (fail-OPEN-to-False contract)", async () => {
    const deadPool = new Pool({ connectionString: INTEGRATION_DSN, max: 1 });
    const deadDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: deadPool }) });
    await deadDb.destroy(); // every query on this engine now rejects
    expect(await readCodeOwnersV1Enabled(deadDb)).toBe(false);
  });
});
