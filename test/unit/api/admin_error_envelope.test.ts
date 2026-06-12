// W4.7 / EH6 — the admin/auth scopes must never echo an unmapped error's message in the 500 body.
// Dozens of admin handlers end with a bare `throw e;` after mapping their typed errors; Fastify's
// DEFAULT error handler responds 500 with `message: err.message` — for a driver-level Postgres
// error that is raw schema text (column/table names, query fragments). A scoped error handler logs
// the full error server-side and returns the uniform `{detail:"internal error"}` envelope.
// Framework-classified CLIENT errors (4xx, e.g. a malformed JSON body) keep their status.

import { afterEach, describe, expect, it, vi } from "vitest";

// The handler's contract includes a server-side structured log of the FULL error — capture it both
// to assert it and to keep test output pristine.
afterEach(() => {
  vi.restoreAllMocks();
});

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { registerAuthRoutes, SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { LocalUserRepo } from "#backend/api/auth/local_user_repo.js";
import { NoOpLdapClient } from "#backend/api/auth/noop_ldap.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { recordingKysely } from "./_recording_kysely.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INST = "3a3a3a3a-1111-2222-3333-444444444444";
const PG_LEAK = 'column "api_key_ciphertext" of relation "core.llm_provider_settings" does not exist';

function cookie(): string {
  return issueCookie({
    user_id: "00000000-0000-0000-0000-0000000000aa",
    email: "u@x",
    role: "super_admin",
    auth_source: "core_local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: INST,
  });
}

async function makeAdminApp(dbResults: ReadonlyArray<ReadonlyArray<unknown> | Error>) {
  const { db } = recordingKysely(dbResults);
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

describe("W4.7/EH6 admin-scope error envelope", () => {
  it("an unmapped DB error → 500 {detail:'internal error'}; the schema text NEVER reaches the body", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await makeAdminApp([new Error(PG_LEAK)]);
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/flags",
      cookies: { [SESSION_COOKIE_NAME]: cookie() },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ detail: string }>().detail).toBe("internal error");
    expect(res.body).not.toContain("api_key_ciphertext");
    expect(res.body).not.toContain("llm_provider_settings");
    // The FULL error is preserved server-side (structured log), so EH6 trades no diagnosability.
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("api_unhandled_error");
    expect(logged).toContain("api_key_ciphertext");
    await app.close();
  });

  it("a route-classified 4xx that sends an Error body (the zod `send(body.error)` idiom) keeps its status", async () => {
    // POST reject with a too-short reason: the route does reply.code(422).send(zodError) — an Error
    // instance, which Fastify routes through the error handler. The handler must honor the
    // route-set 4xx (Fastify-default semantics), not clamp it to a generic 500.
    const app = await makeAdminApp([[]]);
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/knowledge/proposals/aaaaaaaa-1111-2222-3333-444444444444/reject",
      headers: { "content-type": "application/json" },
      cookies: { [SESSION_COOKIE_NAME]: cookie() },
      payload: JSON.stringify({ reason: 42 }), // wrong type → zod parse failure → send(body.error)
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("framework-classified client errors keep their 4xx status (malformed JSON body → 400)", async () => {
    const app = await makeAdminApp([[]]);
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/integrations/confluence-spaces",
      headers: { "content-type": "application/json" },
      cookies: { [SESSION_COOKIE_NAME]: cookie() },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("W4.7/EH6 auth-scope error envelope", () => {
  it("an unmapped repo error during login → 500 {detail:'internal error'} without the message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const throwingRepo = {
      getByUsername: async () => {
        throw new Error(PG_LEAK);
      },
      recordLoginAttempt: async () => {
        throw new Error(PG_LEAK);
      },
    } as unknown as LocalUserRepo;
    const app = buildApp({});
    await registerAuthRoutes(app, {
      localRepo: throwingRepo,
      ldap: new NoOpLdapClient(),
      clock: new FakeClock({ now: NOW }),
      signingKey: SIGNING_KEY,
      secureCookies: false,
    });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ username: "root", password: "x" }),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ detail: string }>().detail).toBe("internal error");
    expect(res.body).not.toContain("llm_provider_settings");
    await app.close();
  });
});
