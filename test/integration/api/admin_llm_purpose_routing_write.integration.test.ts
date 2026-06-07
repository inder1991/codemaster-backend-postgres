/**
 * Integration test for PUT /api/admin/llm-purpose-routing against the DISPOSABLE Postgres (localhost:5434
 * — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set. super_admin only; assigns a purpose
 * to a catalog model that must be in-catalog + enabled + preflight-validated (else 422).
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const M_OK = "itest-ppm-ok";
const M_DIS = "itest-ppm-disabled";
const M_UNVAL = "itest-ppm-unvalidated";
const PURPOSE = "analysis_curator"; // READ test only asserts purpose-sort, never a specific mapping

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.llm_purpose_model WHERE purpose = ${PURPOSE}`.execute(db);
  await sql`DELETE FROM core.llm_models WHERE model_id IN (${M_OK}, ${M_DIS}, ${M_UNVAL})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await sql`INSERT INTO core.llm_models (provider, model_id, enabled, last_validation_status)
            VALUES ('bedrock', ${M_OK}, true, 'ok'),
                   ('bedrock', ${M_DIS}, false, 'ok'),
                   ('bedrock', ${M_UNVAL}, true, 'untested')`.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function cookie(role: Role): Record<string, string> {
  return {
    [SESSION_COOKIE_NAME]: issueCookie({
      user_id: "00000000-0000-0000-0000-0000000000aa",
      email: "u@x",
      role,
      auth_source: "local",
      ldap_groups: [],
      now: NOW,
      signing_key: SIGNING_KEY,
      installation_id: null,
    }),
  };
}
const SA = () => cookie("super_admin");

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

const URL = "/api/admin/llm-purpose-routing";

describeDb("admin llm-purpose-routing write (disposable :5434)", () => {
  it("assigns an OK model (200 + upsert); 422 not-in-catalog / disabled / not-validated; 403 reader", async () => {
    const app = await makeApp();
    const ok = await app.inject({ method: "PUT", url: URL, cookies: SA(), payload: { purpose: PURPOSE, model_id: M_OK } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ purpose: string; model_id: string }>()).toMatchObject({ purpose: PURPOSE, model_id: M_OK });
    const row = await sql<{ model_id: string }>`SELECT model_id FROM core.llm_purpose_model WHERE purpose = ${PURPOSE}`.execute(db);
    expect(row.rows[0]!.model_id).toBe(M_OK);

    // not in catalog → 422 llm_model_not_in_catalog
    const nic = await app.inject({ method: "PUT", url: URL, cookies: SA(), payload: { purpose: PURPOSE, model_id: "no-such-model" } });
    expect(nic.statusCode).toBe(422);
    expect(nic.json<{ detail: { code: string } }>().detail.code).toBe("llm_model_not_in_catalog");
    // disabled → 422 llm_model_disabled
    expect(
      (await app.inject({ method: "PUT", url: URL, cookies: SA(), payload: { purpose: PURPOSE, model_id: M_DIS } })).json<{ detail: { code: string } }>().detail.code,
    ).toBe("llm_model_disabled");
    // not preflight-validated → 422 llm_model_not_validated
    expect(
      (await app.inject({ method: "PUT", url: URL, cookies: SA(), payload: { purpose: PURPOSE, model_id: M_UNVAL } })).json<{ detail: { code: string } }>().detail.code,
    ).toBe("llm_model_not_validated");

    // bad purpose enum → 422 (contract)
    expect((await app.inject({ method: "PUT", url: URL, cookies: SA(), payload: { purpose: "bogus", model_id: M_OK } })).statusCode).toBe(422);
    // super_admin only → reader 403
    expect((await app.inject({ method: "PUT", url: URL, cookies: cookie("reader"), payload: { purpose: PURPOSE, model_id: M_OK } })).statusCode).toBe(403);
    await app.close();
  });
});
