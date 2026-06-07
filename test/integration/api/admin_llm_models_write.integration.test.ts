/**
 * Integration test for the llm-models catalog WRITE routes (PUT upsert, DELETE) against the DISPOSABLE
 * Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set. super_admin
 * only. (POST /test is deferred — it needs the Vault-decrypt seam + a live provider ping.)
 *
 * Schema reality: uq_llm_models_model_id makes model_id GLOBALLY unique, and the dev catalog seeds all 3
 * BEDROCK_MODELS under anthropic_direct. So PUT (BEDROCK-guarded) can only UPDATE an existing claude row
 * (we update claude-haiku — it has no dependent purpose — and restore it); DELETE (no BEDROCK guard) targets
 * our own non-BEDROCK model_ids.
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
const HAIKU = "claude-haiku-4-5-20251001"; // BEDROCK_MODELS, seeded under anthropic_direct, no dependent purpose
const M_DEL = "itest-llmw-del";
const M_DEP = "itest-llmw-dep";
const DEP_PURPOSE = "cost_estimate"; // READ test only asserts purpose-sort, never a specific mapping

let pool: Pool;
let db: Kysely<unknown>;
let origHaiku: { display_name: string | null; enabled: boolean } | null = null;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.llm_purpose_model WHERE purpose = ${DEP_PURPOSE}`.execute(db);
  await sql`DELETE FROM core.llm_models WHERE model_id IN (${M_DEL}, ${M_DEP})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  const orig = await sql<{ display_name: string | null; enabled: boolean }>`
    SELECT display_name, enabled FROM core.llm_models WHERE provider = 'anthropic_direct' AND model_id = ${HAIKU}
  `.execute(db);
  origHaiku = orig.rows[0] ?? null;
  // own deletable models (non-BEDROCK ids; seeded directly, bypassing the PUT BEDROCK guard)
  await sql`INSERT INTO core.llm_models (provider, model_id, enabled) VALUES ('bedrock', ${M_DEL}, true), ('bedrock', ${M_DEP}, true)`.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) {
    if (origHaiku !== null) {
      await sql`UPDATE core.llm_models SET display_name = ${origHaiku.display_name}, enabled = ${origHaiku.enabled}
                WHERE provider = 'anthropic_direct' AND model_id = ${HAIKU}`.execute(db);
    }
    await cleanup();
  }
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

describeDb("admin llm-models write routes (disposable :5434)", () => {
  it("PUT upsert (200): updates a BEDROCK model; 422 non-BEDROCK; 403 reader; 422 bad body", async () => {
    const app = await makeApp();
    const updated = await app.inject({
      method: "PUT",
      url: "/api/admin/llm-models",
      cookies: SA(),
      payload: { provider: "anthropic_direct", model_id: HAIKU, display_name: "Test Haiku", enabled: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ model_id: string; display_name: string }>()).toMatchObject({ model_id: HAIKU, display_name: "Test Haiku" });

    // model_id outside BEDROCK_MODELS → 422 llm_model_not_supported
    const bad = await app.inject({ method: "PUT", url: "/api/admin/llm-models", cookies: SA(), payload: { provider: "bedrock", model_id: "gpt-4", enabled: true } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json<{ detail: { code: string } }>().detail.code).toBe("llm_model_not_supported");

    expect((await app.inject({ method: "PUT", url: "/api/admin/llm-models", cookies: cookie("reader"), payload: { provider: "anthropic_direct", model_id: HAIKU } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/api/admin/llm-models", cookies: SA(), payload: { provider: "bedrock" } })).statusCode).toBe(422);
    await app.close();
  });

  it("DELETE: 204 then 404; 409 when a purpose routes to the model", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "DELETE", url: `/api/admin/llm-models/bedrock/${M_DEL}`, cookies: SA() })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/llm-models/bedrock/${M_DEL}`, cookies: SA() })).statusCode).toBe(404);

    // a model a purpose depends on → 409 (dependents matched on model_id only)
    await sql`INSERT INTO core.llm_purpose_model (purpose, model_id, updated_at, updated_by_user_id)
              VALUES (${DEP_PURPOSE}, ${M_DEP}, now(), '00000000-0000-0000-0000-0000000000aa')
              ON CONFLICT (purpose) DO UPDATE SET model_id = EXCLUDED.model_id`.execute(db);
    const inUse = await app.inject({ method: "DELETE", url: `/api/admin/llm-models/bedrock/${M_DEP}`, cookies: SA() });
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json<{ detail: { code: string; purposes: Array<string> } }>().detail.code).toBe("llm_model_in_use");
    expect(inUse.json<{ detail: { purposes: Array<string> } }>().detail.purposes).toContain(DEP_PURPOSE);
    await app.close();
  });
});
