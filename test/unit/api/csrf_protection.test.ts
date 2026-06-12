// W4.7 / EC4 — CSRF double-submit VERIFICATION (port of codemaster/api/middleware/csrf.py, the
// deferred FOLLOW-UP-csrf-verification-middleware). The session cookie is the sole credential for
// every admin/auth mutation, so all non-GET routes on those scopes must require an X-CSRF-Token
// header matching the csrf_token cookie (timing-safe), 403 otherwise. Enforcement mounts iff a
// csrfSecret is wired (mirrors the Python's conditional middleware mount); the production server
// always wires it. /api/auth/logout stays exempt (anchor-navigation logout cannot carry a header;
// worst-case CSRF is a self-inflictable logout — the Python's documented posture).

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { registerAuthRoutes, SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import { InMemoryLocalUserRepo, type LocalUser } from "#backend/api/auth/local_user_repo.js";
import { NoOpLdapClient } from "#backend/api/auth/noop_ldap.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { recordingKysely } from "./_recording_kysely.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const CSRF_SECRET = Buffer.from("0123456789abcdef0123456789abcdef");
const CSRF_TOKEN = CSRF_SECRET.toString("hex");
const PW = "test-password-123";
const PW_HASH = "$argon2id$v=19$m=65536,t=3,p=4$B5QfWyYH3WdHYy1TH9rkoA$SomedFZGU2en2csfxEl+WOEJNowVbJjN0AIxtQoavN4";
const INST = "3a3a3a3a-1111-2222-3333-444444444444";

function superAdmin(): LocalUser {
  return {
    user_id: "00000000-0000-0000-0000-0000000000aa",
    username: "root",
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

async function makeAuthApp() {
  const localRepo = new InMemoryLocalUserRepo();
  await localRepo.insert(superAdmin());
  const app = buildApp({});
  await registerAuthRoutes(app, {
    localRepo,
    ldap: new NoOpLdapClient(),
    clock: new FakeClock({ now: NOW }),
    signingKey: SIGNING_KEY,
    secureCookies: false,
    csrfSecret: CSRF_SECRET,
  });
  await app.ready();
  return app;
}

async function makeAdminApp(withCsrf: boolean) {
  const { db } = recordingKysely([[]]);
  const app = buildApp({});
  await registerAdminRoutes(app, {
    db,
    signingKey: SIGNING_KEY,
    clock: new FakeClock({ now: NOW }),
    ...(withCsrf ? { csrfSecret: CSRF_SECRET } : {}),
  });
  await app.ready();
  return app;
}

function sessionCookie(role: "super_admin" = "super_admin"): string {
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

describe("W4.7/EC4 CSRF verification — auth scope", () => {
  it("POST /api/auth/login without token → 403 csrf token missing", async () => {
    const app = await makeAuthApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ username: "root", password: PW }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toBe("csrf token missing");
    await app.close();
  });

  it("POST /api/auth/login with matching cookie+header → passes through to the handler (200)", async () => {
    const app = await makeAuthApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json", "x-csrf-token": CSRF_TOKEN },
      cookies: { csrf_token: CSRF_TOKEN },
      payload: JSON.stringify({ username: "root", password: PW }),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("mismatched header vs cookie → 403 csrf token mismatch", async () => {
    const app = await makeAuthApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json", "x-csrf-token": "deadbeef" },
      cookies: { csrf_token: CSRF_TOKEN },
      payload: JSON.stringify({ username: "root", password: PW }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toBe("csrf token mismatch");
    await app.close();
  });

  it("safe methods (GET /api/auth/me, GET /api/auth/csrf) are not gated", async () => {
    const app = await makeAuthApp();
    expect((await app.inject({ method: "GET", url: "/api/auth/csrf" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401); // auth, not csrf
    await app.close();
  });

  it("POST /api/auth/logout is exempt (anchor-navigation logout)", async () => {
    const app = await makeAuthApp();
    const res = await app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("EC4: the session cookie is SameSite=Strict (set on login AND on the logout clear)", async () => {
    const app = await makeAuthApp();
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json", "x-csrf-token": CSRF_TOKEN },
      cookies: { csrf_token: CSRF_TOKEN },
      payload: JSON.stringify({ username: "root", password: PW }),
    });
    expect(login.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.sameSite).toBe("Strict");
    const logout = await app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(logout.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.sameSite).toBe("Strict");
    await app.close();
  });
});

describe("W4.7/EC4 CSRF verification — admin scope", () => {
  it("a state-changing admin route without the token → 403 BEFORE authz/handler", async () => {
    const app = await makeAdminApp(true);
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/integrations/confluence-spaces",
      headers: { "content-type": "application/json" },
      cookies: { [SESSION_COOKIE_NAME]: sessionCookie() },
      payload: JSON.stringify({ space_key: "ENG", space_name: "Engineering" }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toBe("csrf token missing");
    await app.close();
  });

  it("with matching cookie+header the request reaches the handler (503: validator unwired)", async () => {
    const app = await makeAdminApp(true);
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/integrations/confluence-spaces",
      headers: { "content-type": "application/json", "x-csrf-token": CSRF_TOKEN },
      cookies: { [SESSION_COOKIE_NAME]: sessionCookie(), csrf_token: CSRF_TOKEN },
      payload: JSON.stringify({ space_key: "ENG", space_name: "Engineering" }),
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("GET admin reads are not gated by CSRF", async () => {
    const app = await makeAdminApp(true);
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/flags",
      cookies: { [SESSION_COOKIE_NAME]: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("without a wired csrfSecret the hook is not mounted (test-harness compatibility)", async () => {
    const app = await makeAdminApp(false);
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/integrations/confluence-spaces",
      headers: { "content-type": "application/json" },
      cookies: { [SESSION_COOKIE_NAME]: sessionCookie() },
      payload: JSON.stringify({ space_key: "ENG", space_name: "Engineering" }),
    });
    expect(res.statusCode).toBe(503); // straight to the unwired-validator handler, no csrf gate
    await app.close();
  });
});
