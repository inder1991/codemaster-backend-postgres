/**
 * Integration test for PUT /api/admin/flags/{flag_name} (two-person kill-switch flip) against the
 * DISPOSABLE Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set.
 *
 * 1:1 port of codemaster/api/admin/flags.py put_route + postgres_flags_repo.py. Covers:
 *   - 428 If-Match missing; 400 If-Match unparseable; 422 bad body; 404 unknown flag; 403 role.
 *   - typed-confirm gate (400) for tenant-wide (global) flags; NOT required for installation scope.
 *   - staged_first (first approver: pending_* set, live value UNTOUCHED) → committed (second approver:
 *     value flipped, last_changed_* bumped, pending cleared, audit emitted).
 *   - 409 stale_write (CAS If-Match miss); 409 self_second_approver; 409 stale_write (pending-value mismatch).
 *
 * flag_name is the core.flags PRIMARY KEY (globally unique), so every flag below uses the isolated
 * `fwtest-` prefix — verified free across the test tree — to avoid PK collisions with admin_flags (read).
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

const NOW = new Date("2026-06-07T12:00:00.000Z"); // FakeClock — becomes last_changed_at on commit
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INST = "aa11bb22-3333-4444-5555-666677778888";
const USER_A = "aa11bb22-0000-0000-0000-00000000000a";
const USER_B = "aa11bb22-0000-0000-0000-00000000000b";
const SEED_TS = new Date("2026-06-01T00:00:00.000Z"); // ms precision — the If-Match optimistic token
const SEED_ISO = SEED_TS.toISOString();

const F_HAPPY = "fwtest-global-happy";
const F_INST = "fwtest-inst-noconfirm";
const F_STALE = "fwtest-global-stale";
const F_SELF = "fwtest-global-self";
const F_MISMATCH = "fwtest-global-mismatch";
const F_CONFIRM = "fwtest-global-confirm";
const ALL_FLAGS = [F_HAPPY, F_INST, F_STALE, F_SELF, F_MISMATCH, F_CONFIRM];

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.flags WHERE flag_name = ANY(${ALL_FLAGS})`.execute(db);
}

async function seedFlag(name: string, scope: "global" | "installation"): Promise<void> {
  const scopeId = scope === "installation" ? INST : null;
  await sql`INSERT INTO core.flags (flag_name, scope, scope_id, value_json, last_changed_at,
                                    last_changed_by_user_id, pending_second_approver)
            VALUES (${name}, ${scope}, ${scopeId}, ${'{"on":false}'}, ${SEED_TS}, NULL, false)`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await seedFlag(F_HAPPY, "global");
  await seedFlag(F_INST, "installation");
  await seedFlag(F_STALE, "global");
  await seedFlag(F_SELF, "global");
  await seedFlag(F_MISMATCH, "global");
  await seedFlag(F_CONFIRM, "global");
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function cookie(role: Role, userId: string): Record<string, string> {
  return {
    [SESSION_COOKIE_NAME]: issueCookie({
      user_id: userId,
      email: "u@x",
      role,
      auth_source: "local",
      ldap_groups: [],
      now: NOW,
      signing_key: SIGNING_KEY,
      installation_id: INST,
    }),
  };
}

type AuditEvent = { action: string; targetId: string; before: unknown; after: unknown };

async function makeApp(audited?: Array<AuditEvent>) {
  const app = buildApp({});
  await registerAdminRoutes(app, {
    db,
    signingKey: SIGNING_KEY,
    clock: new FakeClock({ now: NOW }),
    ...(audited
      ? {
          audit: async (e: AuditEvent) => {
            audited.push(e);
          },
        }
      : {}),
  });
  await app.ready();
  return app;
}

const url = (flag: string): string => `/api/admin/flags/${flag}`;

describeDb("admin flags write — PUT (disposable :5434)", () => {
  it("428 If-Match missing; 400 unparseable; 422 bad body; 404 unknown; 403 role", async () => {
    const app = await makeApp();
    const A = cookie("platform_owner", USER_A);
    // 428 — no If-Match header
    expect(
      (await app.inject({ method: "PUT", url: url(F_INST), cookies: A, payload: { value_json: '{"on":true}' } }))
        .statusCode,
    ).toBe(428);
    // 400 — If-Match not an ISO timestamp
    expect(
      (
        await app.inject({
          method: "PUT",
          url: url(F_INST),
          cookies: A,
          headers: { "if-match": "not-a-date" },
          payload: { value_json: '{"on":true}' },
        })
      ).statusCode,
    ).toBe(400);
    // 422 — missing value_json / empty value_json
    expect(
      (await app.inject({ method: "PUT", url: url(F_INST), cookies: A, headers: { "if-match": SEED_ISO }, payload: {} }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: url(F_INST),
          cookies: A,
          headers: { "if-match": SEED_ISO },
          payload: { value_json: "" },
        })
      ).statusCode,
    ).toBe(422);
    // 404 — unknown flag
    expect(
      (
        await app.inject({
          method: "PUT",
          url: url("fwtest-does-not-exist"),
          cookies: A,
          headers: { "if-match": SEED_ISO },
          payload: { value_json: '{"on":true}' },
        })
      ).statusCode,
    ).toBe(404);
    // 403 — reader / operator cannot write
    for (const role of ["reader", "platform_operator"] as const) {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: url(F_INST),
            cookies: cookie(role, USER_A),
            headers: { "if-match": SEED_ISO },
            payload: { value_json: '{"on":true}' },
          })
        ).statusCode,
      ).toBe(403);
    }
    await app.close();
  });

  it("typed-confirm gate (400) for global flags — missing and wrong phrase", async () => {
    const app = await makeApp();
    const A = cookie("platform_owner", USER_A);
    // missing X-Typed-Confirm-Phrase
    const missing = await app.inject({
      method: "PUT",
      url: url(F_CONFIRM),
      cookies: A,
      headers: { "if-match": SEED_ISO },
      payload: { value_json: '{"on":true}' },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ detail: { code: string; expected_phrase: string } }>().detail).toEqual({
      code: "typed_confirm_required",
      expected_phrase: `flip ${F_CONFIRM}`,
    });
    // wrong phrase
    expect(
      (
        await app.inject({
          method: "PUT",
          url: url(F_CONFIRM),
          cookies: A,
          headers: { "if-match": SEED_ISO, "x-typed-confirm-phrase": "flip wrong" },
          payload: { value_json: '{"on":true}' },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("global flip: staged_first (value untouched) → committed (value flipped, audit emitted)", async () => {
    const audited: Array<AuditEvent> = [];
    const app = await makeApp(audited);
    const confirm = `flip ${F_HAPPY}`;
    // first approver A — stages, live value UNCHANGED
    const first = await app.inject({
      method: "PUT",
      url: url(F_HAPPY),
      cookies: cookie("platform_owner", USER_A),
      headers: { "if-match": SEED_ISO, "x-typed-confirm-phrase": confirm },
      payload: { value_json: '{"on":true}' },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ path: string; flag: Record<string, unknown> }>();
    expect(firstBody.path).toBe("staged_first");
    expect(firstBody.flag.value_json).toBe('{"on":false}'); // live value untouched
    expect(firstBody.flag.pending_second_approver).toBe(true);
    expect(firstBody.flag.pending_value_json).toBe('{"on":true}');
    expect(firstBody.flag.pending_first_approver_user_id).toBe(USER_A);
    expect(audited).toHaveLength(0); // no audit on stage

    // second approver B (≠ A) — commits
    const second = await app.inject({
      method: "PUT",
      url: url(F_HAPPY),
      cookies: cookie("platform_owner", USER_B),
      headers: { "if-match": SEED_ISO, "x-typed-confirm-phrase": confirm },
      payload: { value_json: '{"on":true}' },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<{ path: string; flag: Record<string, unknown> }>();
    expect(secondBody.path).toBe("committed");
    expect(secondBody.flag.value_json).toBe('{"on":true}'); // flipped
    expect(secondBody.flag.pending_second_approver).toBe(false);
    expect(secondBody.flag.pending_value_json).toBeNull();
    expect(secondBody.flag.last_changed_by_user_id).toBe(USER_B);
    expect(secondBody.flag.last_changed_at).toBe(NOW.toISOString());
    // audit emitted once on commit
    expect(audited).toHaveLength(1);
    expect(audited[0]!.action).toBe("flag.put");
    expect(audited[0]!.targetId).toBe(F_HAPPY);
    expect(audited[0]!.before).toEqual({ value_json: '{"on":false}' });
    expect((audited[0]!.after as Record<string, unknown>)["value_json"]).toBe('{"on":true}');
    await app.close();
  });

  it("installation flip needs NO typed-confirm: staged_first → committed", async () => {
    const app = await makeApp();
    const firstBody = (
      await app.inject({
        method: "PUT",
        url: url(F_INST),
        cookies: cookie("platform_owner", USER_A),
        headers: { "if-match": SEED_ISO },
        payload: { value_json: '{"on":true}' },
      })
    ).json<{ path: string }>();
    expect(firstBody.path).toBe("staged_first");
    const second = await app.inject({
      method: "PUT",
      url: url(F_INST),
      cookies: cookie("platform_owner", USER_B),
      headers: { "if-match": SEED_ISO },
      payload: { value_json: '{"on":true}' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ path: string }>().path).toBe("committed");
    await app.close();
  });

  it("409 stale_write on CAS If-Match miss (carries current state)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: url(F_STALE),
      cookies: cookie("platform_owner", USER_A),
      headers: { "if-match": "2020-01-01T00:00:00.000Z", "x-typed-confirm-phrase": `flip ${F_STALE}` },
      payload: { value_json: '{"on":true}' },
    });
    expect(res.statusCode).toBe(409);
    const detail = res.json<{ detail: { code: string; current_value_json: string; current_changed_at: string } }>()
      .detail;
    expect(detail.code).toBe("stale_write");
    expect(detail.current_value_json).toBe('{"on":false}');
    expect(detail.current_changed_at).toBe(SEED_ISO);
    await app.close();
  });

  it("409 self_second_approver (same user stages then approves)", async () => {
    const app = await makeApp();
    const confirm = `flip ${F_SELF}`;
    await app.inject({
      method: "PUT",
      url: url(F_SELF),
      cookies: cookie("platform_owner", USER_A),
      headers: { "if-match": SEED_ISO, "x-typed-confirm-phrase": confirm },
      payload: { value_json: '{"on":true}' },
    });
    const self = await app.inject({
      method: "PUT",
      url: url(F_SELF),
      cookies: cookie("platform_owner", USER_A),
      headers: { "if-match": SEED_ISO, "x-typed-confirm-phrase": confirm },
      payload: { value_json: '{"on":true}' },
    });
    expect(self.statusCode).toBe(409);
    expect(self.json<{ detail: { code: string } }>().detail.code).toBe("self_second_approver");
    await app.close();
  });

  it("409 stale_write when second approver's value disagrees with staged value", async () => {
    const app = await makeApp();
    const confirm = `flip ${F_MISMATCH}`;
    await app.inject({
      method: "PUT",
      url: url(F_MISMATCH),
      cookies: cookie("platform_owner", USER_A),
      headers: { "if-match": SEED_ISO, "x-typed-confirm-phrase": confirm },
      payload: { value_json: '{"on":true}' },
    });
    const mismatch = await app.inject({
      method: "PUT",
      url: url(F_MISMATCH),
      cookies: cookie("platform_owner", USER_B),
      headers: { "if-match": SEED_ISO, "x-typed-confirm-phrase": confirm },
      payload: { value_json: '{"on":false}' }, // differs from staged
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json<{ detail: { code: string } }>().detail.code).toBe("stale_write");
    await app.close();
  });
});
