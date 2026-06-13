// W3.1 — operator dead-letter surface (outbox). GET lists dead rows (platform_operator+); POST replay
// resets a dead row → pending (super_admin) + emits an audit event. Runs ONLY when CODEMASTER_PG_CORE_DSN set.

import { randomInt, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { PostgresOutboxRepo } from "#backend/domain/repos/outbox_repo.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const installationId = randomUUID();
const ghId = randomInt(1, 2_000_000_000);

let pool: Pool;
let db: Kysely<unknown>;

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

type AuditEvent = { action: string; before: unknown; after: unknown };

async function makeApp(audited?: Array<AuditEvent>) {
  const app = buildApp({});
  await registerAdminRoutes(app, {
    db,
    signingKey: SIGNING_KEY,
    clock: new FakeClock({ now: NOW }),
    ...(audited ? { audit: async (e: AuditEvent) => void audited.push(e) } : {}),
  });
  await app.ready();
  return app;
}

/** Seed a DEAD outbox row via the repo; returns its id. */
async function seedDead(tag: string, error: string): Promise<string> {
  const repo = new PostgresOutboxRepo({ clock: new FakeClock({ now: NOW }) });
  const deliveryId = `dl-${tag}-${ghId}`;
  await repo.appendNonReviewDispatch({
    db,
    workflowType: "syncCodeOwners",
    payload: {},
    schemaVersion: 2,
    installationId,
    deliveryId,
  });
  const row = await pool.query<{ id: string }>(`SELECT id FROM core.outbox WHERE delivery_id = $1`, [deliveryId]);
  const id = row.rows[0]!.id;
  await repo.markDead({ db, id, error });
  return id;
}

describeDb("admin dead-letter (outbox) — W3.1", () => {
  beforeAll(async () => {
    if (!INTEGRATION_DSN) return;
    pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    await pool.query(
      `INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
       VALUES ($1, $2, $3, 'Organization')`,
      [installationId, ghId, `acct-${ghId}`],
    );
  });
  beforeEach(async () => {
    await sql`DELETE FROM core.outbox WHERE installation_id = ${installationId}`.execute(db);
  });
  afterAll(async () => {
    await sql`DELETE FROM core.outbox WHERE installation_id = ${installationId}`.execute(db);
    await sql`DELETE FROM core.installations WHERE installation_id = ${installationId}`.execute(db);
    await db?.destroy();
  });

  it("GET lists dead rows (platform_operator+); 403 for reader", async () => {
    const id = await seedDead("list", "boom: sink rejected");
    const app = await makeApp();
    const ok = await app.inject({ method: "GET", url: "/api/admin/dead-letter/outbox", cookies: cookie("platform_operator") });
    expect(ok.statusCode).toBe(200);
    const rows = ok.json<{ rows: Array<{ id: string; last_error: string }> }>().rows;
    const mine = rows.find((r) => r.id === id);
    expect(mine?.last_error).toContain("boom");
    expect(ok.body).not.toContain('"payload"'); // never lists the payload
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/dead-letter/outbox", cookies: cookie("reader") })).statusCode,
    ).toBe(403);
    await app.close();
  });

  it("POST replay (super_admin) resets the row → pending, audits, and is 404 the second time", async () => {
    const id = await seedDead("replay", "boom: transient");
    const audited: Array<AuditEvent> = [];
    const app = await makeApp(audited);
    try {
      const res = await app.inject({ method: "POST", url: `/api/admin/dead-letter/outbox/${id}/replay`, cookies: cookie("super_admin") });
      expect(res.statusCode).toBe(200);
      // row is now pending (re-claimable)
      const state = await pool.query<{ state: string }>(`SELECT state FROM core.outbox WHERE id = $1`, [id]);
      expect(state.rows[0]?.state).toBe("pending");
      // audited with the prior dead state archived (NOT in `after`); never the payload
      expect(audited).toHaveLength(1);
      expect(audited[0]!.action).toBe("outbox.replayed");
      expect(JSON.stringify(audited[0]!.before)).toContain("boom");
      expect(JSON.stringify(audited[0]!.after)).not.toContain("boom");
      // second replay: no longer dead → 404
      expect(
        (await app.inject({ method: "POST", url: `/api/admin/dead-letter/outbox/${id}/replay`, cookies: cookie("super_admin") })).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("POST replay is 403 for non-super_admin and 422 for a malformed id", async () => {
    const id = await seedDead("rbac", "boom");
    const app = await makeApp();
    try {
      expect(
        (await app.inject({ method: "POST", url: `/api/admin/dead-letter/outbox/${id}/replay`, cookies: cookie("platform_owner") })).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: "POST", url: "/api/admin/dead-letter/outbox/not-a-uuid/replay", cookies: cookie("super_admin") })).statusCode,
      ).toBe(422);
    } finally {
      await app.close();
    }
  });
});
