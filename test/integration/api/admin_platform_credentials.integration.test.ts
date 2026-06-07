/**
 * Integration test for platform-credentials (GET / PATCH / POST test, confluence + embedder/qwen) against
 * the DISPOSABLE Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set.
 *
 * 1:1 port of platform_credentials.py. Secrets live in Vault KV (the InMemoryVault double); the meta table
 * holds rotation/validation metadata. core.platform_credentials_meta is a GLOBAL singleton (PK credential_key,
 * 2 possible rows) — this file owns its lifecycle exclusively (beforeEach/afterAll DELETE both keys). The
 * qwen config-bump test snapshots core.embedder_runtime_state.config_version and asserts +1.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { InMemoryVault } from "#backend/adapters/vault_port.js";
import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import type {
  PlatformCredentialProbePort,
  PlatformTestResult,
  UserEmailResolverPort,
} from "#backend/api/admin/platform_credentials_probe.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";
import type { DnsResolver } from "#backend/security/url_validator.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const CONFLUENCE_PATH = "codemaster/confluence/token";
const QWEN_PATH = "codemaster/embedder/qwen";

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.platform_credentials_meta WHERE credential_key IN ('confluence', 'embedder.qwen')`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
});
beforeEach(async () => {
  if (INTEGRATION_DSN) await cleanup();
});
afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function cookie(role: Role): Record<string, string> {
  return {
    [SESSION_COOKIE_NAME]: issueCookie({
      user_id: "cc11cc11-0000-0000-0000-0000000000aa",
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

type AuditEvent = { action: string; installationId: string | null; after: Record<string, unknown> | null };

const stubProbe = (r: Partial<PlatformTestResult> = {}): PlatformCredentialProbePort => {
  const res: PlatformTestResult = { ok: true, errorCode: null, errorDetail: null, latencyMs: 5, detectedDimension: null, ...r };
  return { testConfluence: async () => res, testQwen: async () => res };
};
const stubResolver: UserEmailResolverPort = { resolveEmail: async () => "op@codemaster.test" };
const dnsTo =
  (...addrs: Array<string>): DnsResolver =>
  async () =>
    addrs;

async function makeApp(args: {
  vault?: InMemoryVault;
  probe?: PlatformCredentialProbePort;
  audited?: Array<AuditEvent>;
  dnsResolver?: DnsResolver;
}) {
  const app = buildApp({});
  await registerAdminRoutes(app, {
    db,
    signingKey: SIGNING_KEY,
    clock: new FakeClock({ now: NOW }),
    userEmailResolver: stubResolver,
    ...(args.vault ? { vault: args.vault } : {}),
    ...(args.probe ? { getPlatformCredentialProbe: () => args.probe! } : {}),
    ...(args.dnsResolver ? { dnsResolver: args.dnsResolver } : {}),
    ...(args.audited
      ? {
          audit: async (e: AuditEvent) => {
            args.audited!.push(e);
          },
        }
      : {}),
  });
  await app.ready();
  return app;
}

const CONF = "/api/admin/platform-credentials/confluence";
const QWEN = "/api/admin/platform-credentials/embedder/qwen";

describeDb("admin platform-credentials (disposable :5434)", () => {
  it("GET: no Vault payload → base_url null, token_present false; 503 when vault unwired", async () => {
    const vault = new InMemoryVault();
    const app = await makeApp({ vault });
    try {
      const res = await app.inject({ method: "GET", url: CONF, cookies: cookie("platform_owner") });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ base_url: string | null; token_present: boolean; credential_key: string }>();
      expect(body.credential_key).toBe("confluence");
      expect(body.base_url).toBeNull();
      expect(body.token_present).toBe(false);
    } finally {
      await app.close();
    }
    const bare = await makeApp({});
    try {
      expect((await bare.inject({ method: "GET", url: CONF, cookies: cookie("platform_owner") })).statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });

  it("GET: surfaces base_url + token_present (qwen keys off api_key) + meta", async () => {
    const vault = new InMemoryVault();
    await vault.kvWrite({ path: QWEN_PATH, data: { base_url: "https://qwen.example.com", api_key: "secret-qwen" } });
    await sql`INSERT INTO core.platform_credentials_meta (credential_key, last_rotated_at, last_rotated_by)
              VALUES ('embedder.qwen', ${NOW}, 'prev@op')`.execute(db);
    const app = await makeApp({ vault });
    try {
      const body = (await app.inject({ method: "GET", url: QWEN, cookies: cookie("super_admin") })).json<{
        base_url: string;
        token_present: boolean;
        last_rotated_by: string;
      }>();
      expect(body.base_url).toBe("https://qwen.example.com");
      expect(body.token_present).toBe(true); // keys off api_key, not token
      expect(body.last_rotated_by).toBe("prev@op");
    } finally {
      await app.close();
    }
  });

  it("403 for reader / platform_operator; 401 with no session", async () => {
    const vault = new InMemoryVault();
    const app = await makeApp({ vault, probe: stubProbe(), dnsResolver: dnsTo("93.184.216.34") });
    try {
      for (const role of ["reader", "platform_operator"] as const) {
        expect((await app.inject({ method: "GET", url: CONF, cookies: cookie(role) })).statusCode).toBe(403);
        expect(
          (await app.inject({ method: "PATCH", url: CONF, cookies: cookie(role), payload: { base_url: "https://x.example.com", token: "t" } })).statusCode,
        ).toBe(403);
      }
      expect((await app.inject({ method: "GET", url: CONF })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("PATCH happy (probe ok): 200, Vault round-trip, meta, audit (installation NULL)", async () => {
    const vault = new InMemoryVault();
    const audited: Array<AuditEvent> = [];
    const app = await makeApp({ vault, probe: stubProbe({ ok: true }), audited, dnsResolver: dnsTo("93.184.216.34") });
    try {
      const res = await app.inject({
        method: "PATCH",
        url: CONF,
        cookies: cookie("platform_owner"),
        payload: { base_url: "https://confluence.example.com", token: "atatt-secret-token" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ token_present: boolean; last_rotated_by: string; last_validation_error: string | null }>();
      expect(body.token_present).toBe(true);
      expect(body.last_rotated_by).toBe("op@codemaster.test");
      expect(body.last_validation_error).toBeNull();
      // Vault round-trip
      const payload = await vault.kvRead({ path: CONFLUENCE_PATH });
      expect(payload).toEqual({ base_url: "https://confluence.example.com", token: "atatt-secret-token" });
      // audit
      expect(audited).toHaveLength(1);
      expect(audited[0]!.action).toBe("platform_credentials.rotated.confluence");
      expect(audited[0]!.installationId).toBe("00000000-0000-0000-0000-000000000001"); // PLATFORM_SCOPE_AUDIT sentinel
      expect(audited[0]!.after).toMatchObject({ probe_ok: true, forced: false });
    } finally {
      await app.close();
    }
  });

  it("PATCH base_url-only rotation preserves the prior token", async () => {
    const vault = new InMemoryVault();
    await vault.kvWrite({ path: CONFLUENCE_PATH, data: { base_url: "https://old.example.com", token: "keep-me" } });
    const app = await makeApp({ vault, probe: stubProbe(), dnsResolver: dnsTo("93.184.216.34") });
    try {
      const res = await app.inject({ method: "PATCH", url: CONF, cookies: cookie("platform_owner"), payload: { base_url: "https://new.example.com" } });
      expect(res.statusCode).toBe(200);
      const payload = await vault.kvRead({ path: CONFLUENCE_PATH });
      expect(payload).toEqual({ base_url: "https://new.example.com", token: "keep-me" }); // token preserved
    } finally {
      await app.close();
    }
  });

  it("PATCH 422: empty_patch / incomplete_credential / SSRF codes (no write on any)", async () => {
    const vault = new InMemoryVault();
    const app = await makeApp({ vault, probe: stubProbe(), dnsResolver: dnsTo("10.0.0.5") }); // private → ssrf
    const expect422 = async (payload: Record<string, unknown>, error: string): Promise<void> => {
      const res = await app.inject({ method: "PATCH", url: CONF, cookies: cookie("platform_owner"), payload });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: string }>().error).toBe(error);
    };
    try {
      await expect422({ base_url: null, token: null }, "empty_patch");
      await expect422({ base_url: "https://internal.example.com", token: "t" }, "ssrf_blocked"); // dns→private
      await expect422({ base_url: "https://u:p@h.example.com", token: "t" }, "userinfo_not_allowed");
      // incomplete: empty vault + only token (no base_url ever)
      await expect422({ token: "t-only" }, "incomplete_credential");
      // no Vault write happened
      await expect(vault.kvRead({ path: CONFLUENCE_PATH })).rejects.toThrow();
      // meta untouched
      expect((await sql`SELECT 1 FROM core.platform_credentials_meta WHERE credential_key='confluence'`.execute(db)).rows).toHaveLength(0);
    } finally {
      await app.close();
    }
    // https_required needs its own app (http URL never reaches dns)
    const app2 = await makeApp({ vault: new InMemoryVault(), probe: stubProbe(), dnsResolver: dnsTo("93.184.216.34") });
    try {
      const res = await app2.inject({ method: "PATCH", url: CONF, cookies: cookie("platform_owner"), payload: { base_url: "http://x.example.com", token: "t" } });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: string }>().error).toBe("https_required");
    } finally {
      await app2.close();
    }
  });

  it("PATCH probe-fail no force → 422; NO Vault write, NO meta, NO audit", async () => {
    const vault = new InMemoryVault();
    const audited: Array<AuditEvent> = [];
    const app = await makeApp({ vault, probe: stubProbe({ ok: false, errorCode: "auth_error", errorDetail: "401 unauthorized" }), audited, dnsResolver: dnsTo("93.184.216.34") });
    try {
      const res = await app.inject({ method: "PATCH", url: CONF, cookies: cookie("platform_owner"), payload: { base_url: "https://x.example.com", token: "bad" } });
      expect(res.statusCode).toBe(422);
      const body = res.json<{ error: string; msg: string }>();
      expect(body.error).toBe("auth_error");
      expect(body.msg).toContain("?force=true");
      await expect(vault.kvRead({ path: CONFLUENCE_PATH })).rejects.toThrow();
      expect((await sql`SELECT 1 FROM core.platform_credentials_meta WHERE credential_key='confluence'`.execute(db)).rows).toHaveLength(0);
      expect(audited).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("PATCH probe-fail WITH ?force=true → 200; Vault written; audit forced:true; meta records the error", async () => {
    const vault = new InMemoryVault();
    const audited: Array<AuditEvent> = [];
    const app = await makeApp({ vault, probe: stubProbe({ ok: false, errorCode: "auth_error", errorDetail: "401" }), audited, dnsResolver: dnsTo("93.184.216.34") });
    try {
      const res = await app.inject({ method: "PATCH", url: `${CONF}?force=true`, cookies: cookie("platform_owner"), payload: { base_url: "https://x.example.com", token: "forced" } });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ last_validation_error: string }>().last_validation_error).toBe("auth_error");
      expect((await vault.kvRead({ path: CONFLUENCE_PATH })).token).toBe("forced");
      expect(audited[0]!.after).toMatchObject({ probe_ok: false, forced: true });
    } finally {
      await app.close();
    }
  });

  it("PATCH qwen bumps config_version; confluence does NOT", async () => {
    const before = (await sql<{ config_version: string }>`SELECT config_version FROM core.embedder_runtime_state WHERE singleton = true`.execute(db)).rows[0];
    expect(before).toBeDefined(); // seeded by 0002_seed.sql
    const beforeN = Number(before!.config_version);
    const vault = new InMemoryVault();
    const app = await makeApp({ vault, probe: stubProbe(), dnsResolver: dnsTo("93.184.216.34") });
    try {
      await app.inject({ method: "PATCH", url: QWEN, cookies: cookie("platform_owner"), payload: { base_url: "https://qwen.example.com", token: "qk" } });
      const afterQwen = Number((await sql<{ config_version: string }>`SELECT config_version FROM core.embedder_runtime_state WHERE singleton = true`.execute(db)).rows[0]!.config_version);
      expect(afterQwen).toBe(beforeN + 1);
      await app.inject({ method: "PATCH", url: CONF, cookies: cookie("platform_owner"), payload: { base_url: "https://c.example.com", token: "ck" } });
      const afterConf = Number((await sql<{ config_version: string }>`SELECT config_version FROM core.embedder_runtime_state WHERE singleton = true`.execute(db)).rows[0]!.config_version);
      expect(afterConf).toBe(afterQwen); // confluence skips the bump
    } finally {
      await app.close();
    }
  });

  it("PATCH 503 (vault/probe unwired); 422 bad body (extra field)", async () => {
    const bare = await makeApp({ vault: new InMemoryVault() }); // vault but no probe
    try {
      expect(
        (await bare.inject({ method: "PATCH", url: CONF, cookies: cookie("platform_owner"), payload: { base_url: "https://x.example.com", token: "t" } })).statusCode,
      ).toBe(503);
      expect(
        (await bare.inject({ method: "PATCH", url: CONF, cookies: cookie("platform_owner"), payload: { base_url: "https://x.example.com", token: "t", bogus: 1 } })).statusCode,
      ).toBe(422); // .strict() rejects the extra field before the 503 guard
    } finally {
      await bare.close();
    }
  });

  it("POST /test: 422 no_credential; 200 {ok:true, corpus_dimension}; 200 {ok:false} on probe fail", async () => {
    // no credential
    const v1 = new InMemoryVault();
    const app1 = await makeApp({ vault: v1, probe: stubProbe() });
    try {
      const res = await app1.inject({ method: "POST", url: `${CONF}/test`, cookies: cookie("platform_owner") });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: string }>().error).toBe("no_credential");
    } finally {
      await app1.close();
    }
    // ok (qwen → corpus_dimension 1024)
    const v2 = new InMemoryVault();
    await v2.kvWrite({ path: QWEN_PATH, data: { base_url: "https://qwen.example.com", api_key: "k" } });
    const app2 = await makeApp({ vault: v2, probe: stubProbe({ ok: true }) });
    try {
      const res = await app2.inject({ method: "POST", url: `${QWEN}/test`, cookies: cookie("platform_owner") });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ ok: boolean; corpus_dimension: number | null; error: string | null }>()).toMatchObject({
        ok: true,
        error: null,
        corpus_dimension: 1024,
      });
      expect((await sql<{ e: string | null }>`SELECT last_validation_error AS e FROM core.platform_credentials_meta WHERE credential_key='embedder.qwen'`.execute(db)).rows[0]!.e).toBeNull();
    } finally {
      await app2.close();
    }
    // probe fail (200, ok:false, detected_dimension surfaced)
    const v3 = new InMemoryVault();
    await v3.kvWrite({ path: QWEN_PATH, data: { base_url: "https://qwen.example.com", api_key: "k" } });
    const app3 = await makeApp({ vault: v3, probe: stubProbe({ ok: false, errorCode: "dimension_mismatch", detectedDimension: 768 }) });
    try {
      const res = await app3.inject({ method: "POST", url: `${QWEN}/test`, cookies: cookie("platform_owner") });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ ok: boolean; error: string; detected_dimension: number; corpus_dimension: number }>()).toMatchObject({
        ok: false,
        error: "dimension_mismatch",
        detected_dimension: 768,
        corpus_dimension: 1024,
      });
      expect((await sql<{ e: string }>`SELECT last_validation_error AS e FROM core.platform_credentials_meta WHERE credential_key='embedder.qwen'`.execute(db)).rows[0]!.e).toBe("dimension_mismatch");
    } finally {
      await app3.close();
    }
  });
});
