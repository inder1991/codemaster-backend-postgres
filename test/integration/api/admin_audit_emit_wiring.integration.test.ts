// W4.7 / EH7 — CONCRETE audit emission for the admin + auth surfaces against the DISPOSABLE Postgres.
// Until this wave, every `await opts.audit?.(...)` in the admin router and the whole login-audit seam
// were silent no-ops in production (server.ts wired no emitter): credential rotation, repo enablement,
// role changes, and login attempts left NO audit trail. These tests pin the concrete adapters:
//
//   * makePgAuditEmitter — the MemberAuditEmitter against audit.audit_events via the canonical
//     emitAuditEvent helper (AAD-bound local AES-256-GCM for before/after; fail-CLOSED).
//     A null installationId (platform-scope actions, e.g. integrations) maps to the seeded
//     PLATFORM_SCOPE_AUDIT_INSTALLATION_ID sentinel row (the TS schema keeps the column NOT NULL).
//   * emitLoginEvent + the auth-router wiring (auditDb) — login.success / login.failure rows with
//     {auth_source, outcome, client_ip_hashed} (IP sha256-truncated, never plaintext), including the
//     rate-limited 429 path; FAIL-SAFE: audit-storage outage must never block a legitimate login.

import {
  type DatabaseConnection,
  Kysely,
  PostgresAdapter,
  PostgresDialect,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";
import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { makePgAuditEmitter } from "#backend/api/admin/audit_emit_adapter.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { emitLoginEvent } from "#backend/api/auth/audit.js";
import { registerAuthRoutes, SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import { type LocalUser, PostgresLocalUserRepo } from "#backend/api/auth/local_user_repo.js";
import { NoOpLdapClient } from "#backend/api/auth/noop_ldap.js";
import { LoginRateLimiter } from "#backend/api/auth/rate_limit.js";
import { issueCookie } from "#backend/api/auth/session.js";
import type { ConfluenceValidatorPort } from "#backend/integrations/confluence/confluence_validator.js";
import { PLATFORM_SCOPE_AUDIT_INSTALLATION_ID } from "#backend/infra/sentinels.js";
import {
  AUDIT_AFTER_AAD,
  decryptAuditJsonBytea,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// A distinctive fixed instant: every row this suite writes carries created_at = NOW (FakeClock), so
// cleanup is exact and never touches other suites' audit rows.
const NOW = new Date("2032-03-04T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INST = "5a5a5a5a-1111-2222-3333-444444444444";
const ACTOR = "5b5b5b5b-1111-2222-3333-444444444444";
const PW = "test-password-123";
const PW_HASH = "$argon2id$v=19$m=65536,t=3,p=4$B5QfWyYH3WdHYy1TH9rkoA$SomedFZGU2en2csfxEl+WOEJNowVbJjN0AIxtQoavN4";

let pool: Pool;
let db: Kysely<unknown>;
let registry: KeyRegistry;

type AuditRow = {
  installation_id: string;
  actor_kind: string;
  actor_id: string | null;
  action: string;
  target_kind: string;
  target_id: string | null;
  after: Buffer | null;
};

async function auditRows(action: string): Promise<Array<AuditRow>> {
  const r = await sql<AuditRow>`
    SELECT installation_id, actor_kind, actor_id, action, target_kind, target_id, after
    FROM audit.audit_events WHERE created_at = ${NOW} AND action = ${action}
    ORDER BY audit_event_id
  `.execute(db);
  return [...r.rows];
}

async function cleanup(): Promise<void> {
  await sql`DELETE FROM audit.audit_events WHERE created_at = ${NOW}`.execute(db);
  await sql`DELETE FROM core.integrations WHERE config_json->>'space_key' = 'AUDITWIRE'`.execute(db);
  await sql`DELETE FROM core.local_users WHERE user_id = ${ACTOR}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${INST}`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  const reg = new KeyRegistry();
  reg.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(7)]]) }));
  setAuditKeyRegistry(reg);
  registry = reg;
  await cleanup();
  await sql`INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
            VALUES (${INST}, 980000210, 'itest-audit-wire', 'Organization')
            ON CONFLICT (installation_id) DO NOTHING`.execute(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM audit.audit_events WHERE created_at = ${NOW}`.execute(db);
  }
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

/** A Kysely whose every query throws — a genuinely-broken audit pool. (A destroyed PostgresDialect
 *  Kysely still serves queries in this driver version, so `db.destroy()` is NOT a failure fixture.) */
function throwingKysely(): Kysely<unknown> {
  const connection: DatabaseConnection = {
    async executeQuery() {
      throw new Error("audit pool is down");
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error("audit pool is down");
    },
  };
  return new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => ({
        async init() {},
        async acquireConnection() {
          return connection;
        },
        async beginTransaction() {},
        async commitTransaction() {},
        async rollbackTransaction() {},
        async releaseConnection() {},
        async destroy() {},
      }),
      createIntrospector: (innerDb) => new PostgresIntrospector(innerDb),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

function superAdmin(): LocalUser {
  return {
    user_id: ACTOR,
    username: "itest-audit-root",
    email: "root@internal",
    full_name: "Root",
    password_hash: PW_HASH,
    role: "super_admin",
    state: "active",
    last_password_change: NOW,
    last_login_at: null,
    failed_attempts: 0,
    locked_until: null,
    created_at: NOW,
    created_by_user_id: null,
  };
}

/** Auth app over the PRODUCTION PostgresLocalUserRepo, so the same-TX audit callback actually runs
 *  inside recordLoginAttempt's transaction (the InMemory repo accepts the callback but never invokes
 *  it — vacuous same-TX semantics, test-only). */
async function makeAuthApp(args?: { auditDb?: Kysely<unknown>; rateLimiter?: LoginRateLimiter }) {
  const localRepo = new PostgresLocalUserRepo({ db, registry });
  await sql`DELETE FROM core.local_users WHERE user_id = ${ACTOR}`.execute(db);
  await localRepo.insert(superAdmin());
  const app = buildApp({});
  await registerAuthRoutes(app, {
    localRepo,
    ldap: new NoOpLdapClient(),
    clock: new FakeClock({ now: NOW }),
    signingKey: SIGNING_KEY,
    secureCookies: false,
    ...(args?.auditDb !== undefined ? { auditDb: args.auditDb } : {}),
    ...(args?.rateLimiter !== undefined ? { rateLimiter: args.rateLimiter } : {}),
  });
  await app.ready();
  return app;
}

async function login(
  app: Awaited<ReturnType<typeof makeAuthApp>>,
  password: string,
  username = "itest-audit-root",
) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ username, password }),
  });
}

describeDb("W4.7/EH7 concrete audit emission (disposable PG)", () => {
  it("makePgAuditEmitter writes a decryptable audit row under the given installation", async () => {
    const emit = makePgAuditEmitter({ db });
    await emit({
      actorUserId: ACTOR,
      installationId: INST,
      action: "member.role_change.requested",
      targetKind: "role_grant_pending",
      targetId: "tgt-1",
      before: null,
      after: { role: "platform_operator" },
      now: NOW,
    });
    const rows = await auditRows("member.role_change.requested");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.installation_id).toBe(INST);
    expect(rows[0]!.actor_kind).toBe("user");
    expect(rows[0]!.actor_id).toBe(ACTOR);
    expect(decryptAuditJsonBytea(rows[0]!.after!, AUDIT_AFTER_AAD)).toEqual({ role: "platform_operator" });
  });

  it("null installationId (platform-scope action) maps to the seeded platform sentinel", async () => {
    const emit = makePgAuditEmitter({ db });
    await emit({
      actorUserId: ACTOR,
      installationId: null,
      action: "integration.removed",
      targetKind: "integration",
      targetId: "tgt-2",
      before: { enabled: true },
      after: null,
      now: NOW,
    });
    const rows = await auditRows("integration.removed");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.installation_id).toBe(PLATFORM_SCOPE_AUDIT_INSTALLATION_ID);
  });

  it("end-to-end: an admin WRITE route wired with the emitter leaves an audit trail (integration.added)", async () => {
    const validator: ConfluenceValidatorPort = {
      validateSpace: async () => ({ ok: true, detail: "ok", validatedAt: NOW }),
    };
    const app = buildApp({});
    await registerAdminRoutes(app, {
      db,
      signingKey: SIGNING_KEY,
      clock: new FakeClock({ now: NOW }),
      audit: makePgAuditEmitter({ db }),
      getConfluenceValidator: () => validator,
    });
    await app.ready();
    const cookie = issueCookie({
      user_id: ACTOR,
      email: "u@x",
      role: "super_admin",
      auth_source: "core_local",
      ldap_groups: [],
      now: NOW,
      signing_key: SIGNING_KEY,
      installation_id: INST,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/integrations/confluence-spaces",
      headers: { "content-type": "application/json" },
      cookies: { [SESSION_COOKIE_NAME]: cookie },
      payload: JSON.stringify({ space_key: "AUDITWIRE", space_name: "Audit Wire" }),
    });
    expect(res.statusCode).toBe(201);
    const rows = await auditRows("integration.added");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(ACTOR);
    await app.close();
  });

  it("login ok → a SAME-TX login.success row with {auth_source, outcome, client_ip_hashed} (no plaintext IP)", async () => {
    const app = await makeAuthApp({ auditDb: db });
    expect((await login(app, PW)).statusCode).toBe(200);
    const rows = await auditRows("login.success");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(ACTOR);
    expect(rows[0]!.target_kind).toBe("session");
    const after = decryptAuditJsonBytea(rows[0]!.after!, AUDIT_AFTER_AAD) as Record<string, unknown>;
    expect(after.auth_source).toBe("local");
    expect(after.outcome).toBe("ok");
    expect(String(after.client_ip_hashed)).toMatch(/^[0-9a-f]{32}$/);
    await app.close();
  });

  it("wrong password for a KNOWN user → a same-TX login.failure row carrying the actor", async () => {
    const app = await makeAuthApp({ auditDb: db });
    expect((await login(app, "wrong")).statusCode).toBe(401);
    const rows = await auditRows("login.failure");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(ACTOR);
    const after = decryptAuditJsonBytea(rows[0]!.after!, AUDIT_AFTER_AAD) as Record<string, unknown>;
    expect(after.outcome).toBe("bad_credentials");
    await app.close();
  });

  it("UNKNOWN username → the post-authenticate fallback emits login.failure with actor null", async () => {
    const app = await makeAuthApp({ auditDb: db });
    expect((await login(app, "wrong", "no-such-user")).statusCode).toBe(401);
    const rows = await auditRows("login.failure");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBeNull();
    const after = decryptAuditJsonBytea(rows[0]!.after!, AUDIT_AFTER_AAD) as Record<string, unknown>;
    expect(after.outcome).toBe("bad_credentials");
    await app.close();
  });

  it("rate-limited 429 → a login.failure row with outcome=rate_limited (the credential-spray trail)", async () => {
    const clock = new FakeClock({ now: NOW });
    const app = await makeAuthApp({
      auditDb: db,
      rateLimiter: new LoginRateLimiter({ maxAttempts: 1, windowMs: 300_000, lockoutMs: 300_000, clock }),
    });
    expect((await login(app, "wrong")).statusCode).toBe(401);
    expect((await login(app, PW)).statusCode).toBe(429);
    const rows = await auditRows("login.failure");
    const outcomes = rows.map(
      (r) => (decryptAuditJsonBytea(r.after!, AUDIT_AFTER_AAD) as Record<string, unknown>).outcome,
    );
    expect(outcomes).toContain("rate_limited");
    await app.close();
  });

  it("FAIL-SAFE: a broken audit pool never blocks the auditDb-routed paths (fallback + rate-limited)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = new FakeClock({ now: NOW });
    const app = await makeAuthApp({
      auditDb: throwingKysely(),
      rateLimiter: new LoginRateLimiter({ maxAttempts: 1, windowMs: 300_000, lockoutMs: 300_000, clock }),
    });
    // Fallback path (unknown user) → emit swallows the broken pool → still 401, never 500.
    expect((await login(app, "wrong", "no-such-user")).statusCode).toBe(401);
    // Rate-limited path → emit swallows → still 429.
    expect((await login(app, PW)).statusCode).toBe(429);
    await app.close();
  });

  it("emitLoginEvent strict mode re-raises (the same-TX R8 contract); non-strict swallows", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const args = {
      executor: throwingKysely(),
      outcome: "ok" as const,
      authSource: "local" as const,
      userId: ACTOR,
      installationId: PLATFORM_SCOPE_AUDIT_INSTALLATION_ID,
      clientIp: "10.0.0.1",
      clock: new FakeClock({ now: NOW }),
    };
    await expect(emitLoginEvent({ ...args, strict: true })).rejects.toThrow();
    await expect(emitLoginEvent(args)).resolves.toBeUndefined();
  });
});
