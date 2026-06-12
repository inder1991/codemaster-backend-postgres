/**
 * Integration tests for the W1.3 RH9 Bedrock re-ranker admin config surface against the DISPOSABLE
 * Postgres (NEVER the cluster). Two layers, mirroring admin_llm_config.integration.test.ts:
 *
 *   1. storage — readRerankSettings / upsertRerankSettings over core.rerank_settings (migration
 *      0048): the platform-singleton row the admin PUT persists and the retrieval wiring reads.
 *   2. routes — GET/PUT /api/admin/rerank-config (added in the routes slice).
 *
 * Runs ONLY when CODEMASTER_PG_CORE_DSN is set; SKIPS otherwise (the _db.ts gate).
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import {
  readRerankSettings,
  upsertRerankSettings,
} from "#backend/api/admin/llm_catalog_write.js";
import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

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

// ─── GET/PUT /api/admin/rerank-config (the UI-facing surface) ─────────────────────────────────────

const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");

type AuditEv = {
  actorUserId: string;
  installationId: string | null;
  action: string;
  targetKind: string;
  targetId: string;
  after: Record<string, unknown> | null;
};

function mintCookie(role: Role): string {
  return issueCookie({
    user_id: "00000000-0000-0000-0000-0000000000aa",
    email: "u@x",
    role,
    auth_source: "local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: null,
  });
}

const cookieFor = (role: Role): Record<string, string> => ({ [SESSION_COOKIE_NAME]: mintCookie(role) });

async function makeApp(audited?: Array<AuditEv>) {
  const app = buildApp({});
  await registerAdminRoutes(app, {
    db,
    signingKey: SIGNING_KEY,
    clock: new FakeClock({ now: NOW }),
    ...(audited
      ? {
          audit: async (e: AuditEv) => {
            audited.push(e);
          },
        }
      : {}),
  });
  await app.ready();
  return app;
}

const PUT_BODY = {
  enabled: true,
  model_id: "cohere.rerank-v3-5:0",
  region: "us-west-2",
  top_n: 20,
};

describeDb("admin rerank-config routes (disposable DB)", () => {
  beforeEach(() => {
    // The GET folds in the env baseline — keep it deterministic per test.
    delete process.env.CODEMASTER_RERANK_ENABLED;
    delete process.env.CODEMASTER_RERANK_MODEL_ID;
    delete process.env.CODEMASTER_RERANK_REGION;
    delete process.env.CODEMASTER_RERANK_TOP_N;
  });

  it("GET: unconfigured → the disabled default with source=default (reader role suffices)", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/rerank-config", cookies: cookieFor("reader") });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        schema_version: 1,
        enabled: false,
        model_id: null,
        region: null,
        top_n: 25,
        source: "default",
        updated_at: null,
        updated_by_user_id: null,
      });
    } finally {
      await app.close();
    }
  });

  it("GET: a Helm/env baseline surfaces with source=environment", async () => {
    process.env.CODEMASTER_RERANK_ENABLED = "true";
    process.env.CODEMASTER_RERANK_MODEL_ID = "amazon.rerank-v1:0";
    process.env.CODEMASTER_RERANK_TOP_N = "15";
    const app = await makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/rerank-config", cookies: cookieFor("reader") });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        enabled: true,
        model_id: "amazon.rerank-v1:0",
        top_n: 15,
        source: "environment",
        updated_at: null,
      });
    } finally {
      await app.close();
    }
  });

  it("GET: 403 for org_owner (not a platform reader role)", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/rerank-config", cookies: cookieFor("org_owner") });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("PUT: super_admin persists the row, audits rerank_config.updated, and the GET flips to source=database", async () => {
    const audited: Array<AuditEv> = [];
    const app = await makeApp(audited);
    try {
      const res = await app.inject({ method: "PUT", url: "/api/admin/rerank-config", cookies: cookieFor("super_admin"), payload: PUT_BODY });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        schema_version: 1,
        enabled: true,
        model_id: "cohere.rerank-v3-5:0",
        region: "us-west-2",
        top_n: 20,
        source: "database",
        updated_at: NOW.toISOString(),
        updated_by_user_id: "00000000-0000-0000-0000-0000000000aa",
      });
      // Persisted (the retrieval resolver reads exactly this row).
      const row = await readRerankSettings(db);
      expect(row?.enabled).toBe(true);
      expect(row?.modelId).toBe("cohere.rerank-v3-5:0");
      expect(row?.topN).toBe(20);
      // Audit.
      expect(audited.map((e) => e.action)).toEqual(["rerank_config.updated"]);
      expect(audited[0]!.targetKind).toBe("rerank_config");
      expect(audited[0]!.targetId).toBe("global");
      expect(audited[0]!.after).toMatchObject({ enabled: true, model_id: "cohere.rerank-v3-5:0" });
      // GET now reads back the database source.
      const get = await app.inject({ method: "GET", url: "/api/admin/rerank-config", cookies: cookieFor("reader") });
      expect(get.json()).toMatchObject({ enabled: true, source: "database" });
    } finally {
      await app.close();
    }
  });

  it("PUT: an unsupported model_id → 422 rerank_model_not_supported (nothing written)", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/admin/rerank-config",
        cookies: cookieFor("super_admin"),
        payload: { ...PUT_BODY, model_id: "anthropic.claude-3-haiku" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ detail: { code: string } }>().detail.code).toBe("rerank_model_not_supported");
      expect(await readRerankSettings(db)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("PUT: Zod refuses out-of-range top_n / a malformed region / extra keys (422)", async () => {
    const app = await makeApp();
    try {
      for (const payload of [
        { ...PUT_BODY, top_n: 0 },
        { ...PUT_BODY, top_n: 101 },
        { ...PUT_BODY, region: "not a region" },
        { ...PUT_BODY, surprise: true },
      ]) {
        const res = await app.inject({ method: "PUT", url: "/api/admin/rerank-config", cookies: cookieFor("super_admin"), payload });
        expect(res.statusCode).toBe(422);
      }
      expect(await readRerankSettings(db)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("PUT: 403 for every non-super_admin role", async () => {
    const app = await makeApp();
    try {
      for (const role of ["reader", "platform_operator", "platform_owner", "org_owner"] as const) {
        const res = await app.inject({ method: "PUT", url: "/api/admin/rerank-config", cookies: cookieFor(role), payload: PUT_BODY });
        expect(res.statusCode).toBe(403);
      }
    } finally {
      await app.close();
    }
  });
});
