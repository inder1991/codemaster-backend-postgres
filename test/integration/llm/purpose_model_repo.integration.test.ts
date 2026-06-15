// Integration test for the purpose resolver's read repo (the validating LEFT JOIN) + the resolver over it,
// against the DISPOSABLE Postgres (:5434). Proves the SQL returns enabled + last_validation_status and that
// the resolver routes a VALID pin to its model while falling back to the static seed for a disabled /
// not-validated pin. Runs only when CODEMASTER_PG_CORE_DSN is set.

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { PostgresPurposeModelReadRepo } from "#backend/llm/purpose_model_repo.js";
import { PurposeModelResolver } from "#backend/llm/purpose_model_resolver.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const M_OK = "itest-pmr-ok";
const M_DIS = "itest-pmr-dis";
const M_FAIL = "itest-pmr-fail";
const P_OK = "review_finding"; // valid pin → resolves to M_OK
const P_DIS = "walkthrough"; // disabled-model pin → seed (claude-opus-4-7)
const P_FAIL = "analysis_curator"; // failed-preflight pin → seed (claude-haiku-4-5-20251001)

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.llm_purpose_model WHERE purpose IN (${P_OK}, ${P_DIS}, ${P_FAIL})`.execute(db);
  await sql`DELETE FROM core.llm_models WHERE model_id IN (${M_OK}, ${M_DIS}, ${M_FAIL})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await sql`INSERT INTO core.llm_models (provider, model_id, enabled, last_validation_status) VALUES
    ('bedrock', ${M_OK}, true, 'ok'),
    ('bedrock', ${M_DIS}, false, 'ok'),
    ('bedrock', ${M_FAIL}, true, 'failed')`.execute(db);
  // Pins reference existing models (the FK requires it).
  await sql`INSERT INTO core.llm_purpose_model (purpose, model_id, updated_at, updated_by_user_id) VALUES
    (${P_OK}, ${M_OK}, now(), NULL),
    (${P_DIS}, ${M_DIS}, now(), NULL),
    (${P_FAIL}, ${M_FAIL}, now(), NULL)`.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) {
    await cleanup();
  }
  await db?.destroy();
});

describeDb("PostgresPurposeModelReadRepo + resolver (disposable :5434)", () => {
  it("join exposes enabled+status; resolver uses the valid pin and seeds the disabled/failed ones", async () => {
    const repo = new PostgresPurposeModelReadRepo({ db });
    const byPurpose = new Map((await repo.listPurposeModelsWithState()).map((r) => [r.purpose, r]));
    expect(byPurpose.get(P_OK)).toMatchObject({ model_id: M_OK, enabled: true, last_validation_status: "ok" });
    expect(byPurpose.get(P_DIS)).toMatchObject({ model_id: M_DIS, enabled: false });
    expect(byPurpose.get(P_FAIL)).toMatchObject({ model_id: M_FAIL, last_validation_status: "failed" });

    const resolver = new PurposeModelResolver({ repo, clock: new FakeClock() });
    expect(await resolver.resolve(P_OK)).toBe(M_OK); // valid pin wins
    expect(await resolver.resolve(P_DIS)).toBe("claude-opus-4-7"); // disabled → seed
    expect(await resolver.resolve(P_FAIL)).toBe("claude-haiku-4-5-20251001"); // not-ok → seed
  });
});
