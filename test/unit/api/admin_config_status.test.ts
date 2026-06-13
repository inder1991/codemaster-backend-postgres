// GET /api/admin/config-status — the non-blocking feature-config state for the UI setup-checklist.
// Verifies admin-auth + that it returns the injected provider's items (never secret values).

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import type { Kysely } from "kysely";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const STUB_ITEMS = [
  { key: "github_app.app_id", state: "pending", source: "none", gates: "GitHub App auth" },
  { key: "confluence.token", state: "configured", source: "file", gates: "Confluence ingestion" },
];

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

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, {
    db: {} as unknown as Kysely<unknown>,
    signingKey: SIGNING_KEY,
    clock: new FakeClock({ now: NOW }),
    configStatusProvider: () => Promise.resolve(STUB_ITEMS),
  });
  await app.ready();
  return app;
}

describe("GET /api/admin/config-status", () => {
  it("returns the feature-config status for an authorized admin", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/config-status",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("super_admin") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: STUB_ITEMS });
    await app.close();
  });

  it("401 without a session cookie (admin-auth required)", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/admin/config-status" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403 for a role below platform_operator", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/config-status",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
