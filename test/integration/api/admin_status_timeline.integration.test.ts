/**
 * Integration test for:
 *   GET /api/admin/status/pipeline (reader+above)
 *   GET /api/admin/status/pilot-progress (owner/super; fail-open to zeros)
 *   GET /api/admin/review-timeline?delivery=<id> (owner/super; partial render + warnings)
 *
 * Status endpoints: happy path + authz matrix.
 * Review-timeline: 404 (no links) + partial render (outbox link found → 200 + Day-1-shim warnings)
 *   + authz (403 for org_owner) + 422 (invalid delivery param).
 *
 * Schema adaptations vs the plan: core.outbox requires payload + schema_version (NOT NULL, no default)
 * and installation_id (CHECK: non-reconcile sink ⇒ installation_id NOT NULL), so the partial-timeline
 * INSERT supplies all four + the seeded installation 00000000-…-0001 + state='pending' (live CHECK
 * vocabulary is {pending,dispatched,dead}).
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
import { StatusRepo } from "#backend/domain/repos/status_repo.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-08T14:30:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INST = "00000000-0000-0000-0000-000000000001";

let pool: Pool;
let db: Kysely<unknown>;

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
});

afterAll(async () => {
  await db?.destroy();
});

function mintCookie(role: Role): string {
  return issueCookie({
    user_id: "00000000-0000-0000-0000-0000000000aa",
    email: "u@x",
    role,
    auth_source: "core_local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: INST,
  });
}

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, {
    db,
    signingKey: SIGNING_KEY,
    clock: new FakeClock({ now: NOW }),
  });
  await app.ready();
  return app;
}

/** Build the app with a StatusRepo whose getPilotProgress throws the given error (fail-open branches). */
async function makeAppWithPilotError(err: Error) {
  const app = buildApp({});
  const statusRepo = new StatusRepo(db);
  statusRepo.getPilotProgress = async (): Promise<never> => {
    throw err;
  };
  await registerAdminRoutes(app, {
    db,
    signingKey: SIGNING_KEY,
    clock: new FakeClock({ now: NOW }),
    statusRepo,
  });
  await app.ready();
  return app;
}

describeDb("admin status + review-timeline", () => {
  it("GET /api/admin/status/pipeline — 200 for reader (health enum); 403 for org_owner", async () => {
    const app = await makeApp();
    const ok = await app.inject({
      method: "GET",
      url: "/api/admin/status/pipeline",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json<{
      schema_version: number;
      bedrock_health: string;
      postgres_health: string;
      temporal_health: string;
    }>();
    expect(body.schema_version).toBe(1);
    expect(body.bedrock_health).toMatch(/healthy|degraded|down/);
    expect(body.postgres_health).toMatch(/healthy|degraded|down/);
    expect(body.temporal_health).toMatch(/healthy|degraded|down/);

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/status/pipeline",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("org_owner") },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });

  it("GET /api/admin/status/pilot-progress — 200 for owner (sprint_day 1..14); 403 for reader", async () => {
    const app = await makeApp();
    const ok = await app.inject({
      method: "GET",
      url: "/api/admin/status/pilot-progress",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json<{ schema_version: number; total_orgs_onboarded: number; sprint_day: number }>();
    expect(body.schema_version).toBe(1);
    expect(body.total_orgs_onboarded).toBeGreaterThanOrEqual(0);
    expect(body.sprint_day).toBeGreaterThanOrEqual(1);
    expect(body.sprint_day).toBeLessThanOrEqual(14);

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/status/pilot-progress",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });

  it("GET /api/admin/status/pilot-progress — schema-drift fail-open returns zeros with target_orgs=0 (Python _pilot_fallback parity)", async () => {
    // 1:1 with the Python status.py _pilot_fallback: on schema-drift the fallback envelope uses
    // target_orgs=0 (NOT 10). The TS schema-drift detection mirrors the pipeline route (UndefinedTable /
    // UndefinedColumn / "does not exist").
    const app = await makeAppWithPilotError(new Error('relation "core.installations" does not exist'));
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/status/pilot-progress",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ total_orgs_onboarded: number; target_orgs: number }>();
    expect(body.total_orgs_onboarded).toBe(0);
    expect(body.target_orgs).toBe(0);
    await app.close();
  });

  it("GET /api/admin/status/pilot-progress — non-schema-drift I/O error returns 503 (Python _safe_call parity)", async () => {
    // 1:1 with the Python _safe_call: a real I/O / persistence error (NOT schema-drift) surfaces 503
    // rather than silently zeroing the dashboard.
    const app = await makeAppWithPilotError(new Error("connection refused"));
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/status/pilot-progress",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("GET /api/admin/review-timeline — 404 for missing delivery; 200 + Day-1 warnings when outbox link exists", async () => {
    const app = await makeApp();
    const notFound = await app.inject({
      method: "GET",
      url: "/api/admin/review-timeline?delivery=nonexistent-delivery-id",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
    });
    expect(notFound.statusCode).toBe(404);

    // Insert an outbox row keyed by a fresh delivery_id to produce a partial timeline. The live schema
    // requires payload + schema_version (NOT NULL, no default) and installation_id (sink≠reconcile CHECK).
    const deliveryId = "test-delivery-" + Date.now();
    await sql`INSERT INTO core.outbox (id, sink, payload, schema_version, state, created_at, delivery_id, installation_id)
              VALUES (gen_random_uuid(), 'test', '{}'::jsonb, 1, 'pending', now(), ${deliveryId}, ${INST}::uuid)`.execute(
      db,
    );

    const ok = await app.inject({
      method: "GET",
      url: `/api/admin/review-timeline?delivery=${deliveryId}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("super_admin") },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json<{
      schema_version: number;
      outbox: { sink: string; state: string } | null;
      warnings: Array<string>;
    }>();
    expect(body.schema_version).toBe(1);
    expect(body.outbox?.sink).toBe("test");
    expect(body.outbox?.state).toBe("pending");
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings.some((w) => w.includes("shim"))).toBe(true); // Day-1 external shims

    // Cleanup the fixture row so re-runs (pytest-randomly-style shuffle) stay deterministic.
    await sql`DELETE FROM core.outbox WHERE delivery_id = ${deliveryId}`.execute(db);
    await app.close();
  });

  it("GET /api/admin/review-timeline — 403 for org_owner (insufficient role)", async () => {
    const app = await makeApp();
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/review-timeline?delivery=test",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("org_owner") },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });

  it("GET /api/admin/review-timeline — 422 for invalid delivery param (>64 chars)", async () => {
    const app = await makeApp();
    const invalid = await app.inject({
      method: "GET",
      url: "/api/admin/review-timeline?delivery=" + "x".repeat(100),
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
    });
    expect(invalid.statusCode).toBe(422);
    await app.close();
  });
});
