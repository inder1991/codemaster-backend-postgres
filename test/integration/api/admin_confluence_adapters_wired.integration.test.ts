/**
 * Route-level proof that the REAL Confluence adapters (confluence_validator_real.ts), when wired into
 * registerAdminRoutes the way server.ts wires them, close the two 503s:
 *   - POST /api/admin/confluence-config/test  (getPlatformCredentialProbe) → 200, NOT 503.
 *   - POST /api/admin/integrations/confluence-spaces (getConfluenceValidator) → 201/422, NOT 503.
 *
 * The external client + the DB creds-read are the injected STUB seams of the real adapters (no network), so
 * the connectivity-test half needs no DB and runs everywhere. The CREATE half writes core.integrations, so
 * it is DB-gated (describeDb — skips locally w/o CODEMASTER_PG_CORE_DSN, runs in CI) and reuses the
 * FWWIRED* space-key prefix + the cc00cc00- id namespace from admin_integrations_create.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";
import {
  makeConfluenceValidator,
  makePlatformCredentialProbe,
  type ConfluenceListSpacesClient,
} from "#backend/integrations/confluence/confluence_validator_real.js";
import { ConfluenceAuthError } from "#backend/integrations/confluence/client.js";
import type { ConfluenceSettings } from "#backend/integrations/confluence/confluence_settings_repo.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const CLOCK = new FakeClock({ now: NOW });

function cookie(role: Role): Record<string, string> {
  return {
    [SESSION_COOKIE_NAME]: issueCookie({
      user_id: "cc00cc00-0000-0000-0000-0000000000aa",
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

const SETTINGS: ConfluenceSettings = {
  baseUrl: "https://acme.atlassian.net/wiki",
  authEmail: "bot@acme.com",
  token: "secret-token",
  enabled: true,
};

const stubSpaces = (keys: ReadonlyArray<string>): ConfluenceListSpacesClient => ({
  listSpaces: async () => keys.map((space_key) => ({ space_key })),
});

// ─── Connectivity-test route (DB-FREE) ────────────────────────────────────────────────────────────

describe("admin confluence-config/test — REAL probe wired (no 503)", () => {
  // A never-queried Kysely just to satisfy AdminRoutesOptions.db (the /test route does not touch the DB).
  const dummyDb = null as unknown as Kysely<unknown>;

  async function appWithProbe(client: ConfluenceListSpacesClient) {
    const app = buildApp({});
    await registerAdminRoutes(app, {
      db: dummyDb,
      signingKey: SIGNING_KEY,
      clock: CLOCK,
      // EXACTLY as server.ts wires it — the real adapter, with the client seam stubbed (no network).
      getPlatformCredentialProbe: () => makePlatformCredentialProbe({ clock: CLOCK, makeConfluenceClient: () => client }),
    });
    await app.ready();
    return app;
  }

  it("probe success → 200 ok:true (was 503 before wiring)", async () => {
    const app = await appWithProbe(stubSpaces(["ENG"]));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/confluence-config/test",
        cookies: cookie("super_admin"),
        payload: { base_url: "https://acme.atlassian.net/wiki", token: "tok" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ ok: boolean }>().ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("probe auth failure → 200 ok:false with a message (never the token); still NOT 503", async () => {
    const failing: ConfluenceListSpacesClient = {
      listSpaces: async () => {
        throw new ConfluenceAuthError("GET /api/v2/spaces returned 401");
      },
    };
    const app = await appWithProbe(failing);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/confluence-config/test",
        cookies: cookie("super_admin"),
        payload: { base_url: "https://acme.atlassian.net/wiki", token: "secret-token-xyz" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ ok: boolean }>().ok).toBe(false);
      expect(res.body).not.toContain("secret-token-xyz");
    } finally {
      await app.close();
    }
  });
});

// ─── Add-Confluence-space CREATE route (DB-gated) ───────────────────────────────────────────────────

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.integrations WHERE config_json ->> 'space_key' LIKE 'FWWIRED%'`.execute(db);
}

describeDb("admin integrations CREATE — REAL validator wired (no 503)", () => {
  beforeAll(async () => {
    if (!INTEGRATION_DSN) return;
    pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    await cleanup();
  });
  afterAll(async () => {
    if (INTEGRATION_DSN) await cleanup();
    await db?.destroy();
  });

  async function makeApp(validatorClient: ConfluenceListSpacesClient) {
    const app = buildApp({});
    await registerAdminRoutes(app, {
      db,
      signingKey: SIGNING_KEY,
      clock: CLOCK,
      // EXACTLY as server.ts wires it — the real validator, with the creds-read + client seams stubbed.
      getConfluenceValidator: () =>
        makeConfluenceValidator({
          readSettings: async () => SETTINGS,
          makeClient: () => validatorClient,
        }),
    });
    await app.ready();
    return app;
  }

  const okBody = (spaceKey: string) => ({
    space_key: spaceKey,
    space_name: "Engineering",
    scope: "whole_space",
    page_tree_root_id: null,
    trust_tier: "semi",
    governance_ack: true,
    visibility: "org:eng",
    strict_label_mode: false,
  });

  it("space reachable → 201 (real validator validated reachability, no 503)", async () => {
    const app = await makeApp(stubSpaces(["FWWIREDOK", "OTHER"]));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/integrations/confluence-spaces",
        cookies: cookie("platform_owner"),
        payload: okBody("FWWIREDOK"),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json<{ last_validated_at: string | null }>().last_validated_at).toBe(NOW.toISOString());
    } finally {
      await app.close();
    }
  });

  it("space NOT reachable → 422 not_found (the real validator's list-spaces miss), not 503", async () => {
    const app = await makeApp(stubSpaces(["SOMETHING-ELSE"]));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/integrations/confluence-spaces",
        cookies: cookie("platform_owner"),
        payload: okBody("FWWIREDMISS"),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ detail: { code: string } }>().detail.code).toBe("not_found");
    } finally {
      await app.close();
    }
  });

  it("auth failure from the client → 422 auth_error, not 503", async () => {
    const failing: ConfluenceListSpacesClient = {
      listSpaces: async () => {
        throw new ConfluenceAuthError("GET /api/v2/spaces returned 401");
      },
    };
    const app = await makeApp(failing);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/integrations/confluence-spaces",
        cookies: cookie("platform_owner"),
        payload: okBody("FWWIREDAUTH"),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ detail: { code: string } }>().detail.code).toBe("auth_error");
    } finally {
      await app.close();
    }
  });
});
