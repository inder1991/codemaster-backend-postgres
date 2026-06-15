// Integration test for the embedder-config admin routes (Phase 6) against the disposable PG. Proves:
// PUT stages (GET never returns the key); a keyless initial config is allowed; an http+private base_url is
// accepted (operator infra, D8); POST /test probes the STAGED config and on success PROMOTES it (validation
// →ok, the active generation's provenance + runtime active_model_name flip to the new model); a probe
// failure persists validation=failed; the dimension-mismatch + 503-unwired + no-config + authz paths.

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";
import { getPool, tenantKysely, disposeAllPools } from "#platform/db/database.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes, type EmbedderProbePort } from "#backend/api/admin/admin_routes.js";
import { PostgresEmbeddingGenerationsRepo } from "#backend/domain/repos/embedding_generations_repo.js";
import {
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const reg = new KeyRegistry();
reg.set(makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(3)]]) }));

const pool = INTEGRATION_DSN ? getPool(INTEGRATION_DSN) : undefined;
const db = INTEGRATION_DSN ? tenantKysely<unknown>(INTEGRATION_DSN) : undefined;

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

type ProbeMode = { ok: true } | { ok: false; dimension: number | null };

async function makeApp(probe?: ProbeMode) {
  const app = buildApp({});
  const embedderProbe: EmbedderProbePort = {
    probe: async () =>
      probe === undefined || probe.ok
        ? { ok: true, detail: "ok — 1024-dim", dimension: 1024, code: null }
        : {
            ok: false,
            detail: "probe failed",
            dimension: probe.dimension,
            code: probe.dimension !== null ? "dimension_mismatch" : "connectivity_error",
          },
  };
  await registerAdminRoutes(app, {
    db: db!,
    signingKey: SIGNING_KEY,
    clock: new FakeClock({ now: NOW }),
    ...(probe !== undefined ? { getEmbedderProbe: () => embedderProbe } : {}),
  });
  await app.ready();
  return app;
}

const resetSeed = async (): Promise<void> => {
  if (!pool) return;
  await pool.query("DELETE FROM core.embedder_provider_settings");
  await pool.query("DELETE FROM core.chunk_embeddings");
  await pool.query("DELETE FROM core.knowledge_chunks");
  await pool.query("DELETE FROM core.confluence_chunks");
  await pool.query("DELETE FROM cache.cache_embeddings");
  await pool.query("DELETE FROM core.embedding_generations WHERE generation_id <> 1");
  await pool.query(
    "UPDATE core.embedding_generations SET model_name='qwen3-embed-0.6b', provider_name='qwen', " +
      "embedding_dimension=1024, state='active' WHERE generation_id = 1",
  );
  await pool.query(
    "UPDATE core.embedder_runtime_state SET active_generation=1, active_model_name='qwen3-embed-0.6b', " +
      "pending_generation=NULL, pending_model_name=NULL, config_version=1 WHERE singleton = true",
  );
};

describeDb("admin embedder-config (disposable)", () => {
  beforeAll(() => {
    setAuditKeyRegistry(reg);
  });
  beforeEach(resetSeed);
  afterAll(async () => {
    resetAuditKeyRegistryForTesting();
    await resetSeed();
    await disposeAllPools();
  });

  it("PUT (super_admin) stages; GET returns the non-secret view WITHOUT the key", async () => {
    const app = await makeApp();
    const put = await app.inject({
      method: "PUT",
      url: "/api/admin/embedder-config",
      cookies: cookie("super_admin"),
      payload: { base_url: "http://embedder.local:8080/v1", model_name: "mxbai-embed-large", api_key: "sk-secret-9999" },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: "GET", url: "/api/admin/embedder-config", cookies: cookie("super_admin") });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      provider: "openai_compat",
      base_url: "http://embedder.local:8080/v1",
      model_name: "mxbai-embed-large",
      key_present: true,
      enabled: true,
      last_validation_status: null,
    });
    expect(get.body).not.toContain("sk-secret-9999");
    await app.close();
  });

  it("a keyless initial config is allowed (api_key omitted) → key_present false", async () => {
    const app = await makeApp();
    const put = await app.inject({
      method: "PUT",
      url: "/api/admin/embedder-config",
      cookies: cookie("super_admin"),
      payload: { base_url: "http://ollama.local:11434/v1", model_name: "nomic-embed-text" },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/api/admin/embedder-config", cookies: cookie("super_admin") });
    expect(get.json<{ key_present: boolean }>().key_present).toBe(false);
    await app.close();
  });

  it("accepts an http + private-host base_url (operator infra; NOT SSRF-blocked — 7-11/D8)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/embedder-config",
      cookies: cookie("super_admin"),
      payload: { base_url: "http://10.1.2.3:8080/v1", model_name: "m" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("PUT is 403 for non-super_admin and 422 on a bad body (non-URL / missing model)", async () => {
    const app = await makeApp();
    expect(
      (await app.inject({ method: "PUT", url: "/api/admin/embedder-config", cookies: cookie("platform_owner"), payload: { base_url: "http://e/v1", model_name: "m" } })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "PUT", url: "/api/admin/embedder-config", cookies: cookie("super_admin"), payload: { base_url: "not-a-url", model_name: "m" } })).statusCode,
    ).toBe(422);
    expect(
      (await app.inject({ method: "PUT", url: "/api/admin/embedder-config", cookies: cookie("super_admin"), payload: { base_url: "http://e/v1" } })).statusCode,
    ).toBe(422);
    await app.close();
  });

  it("POST /test: probe ok → PROMOTES (validation ok; provenance + active_model_name flip)", async () => {
    const app = await makeApp({ ok: true });
    await app.inject({
      method: "PUT",
      url: "/api/admin/embedder-config",
      cookies: cookie("super_admin"),
      payload: { base_url: "http://embedder.local:8080/v1", model_name: "mxbai-embed-large", api_key: "sk-x" },
    });
    const test = await app.inject({ method: "POST", url: "/api/admin/embedder-config/test", cookies: cookie("super_admin") });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ ok: true, detected_dimension: 1024, corpus_dimension: 1024 });

    const gen = await pool!.query<{ model_name: string; provider_name: string }>(
      "SELECT model_name, provider_name FROM core.embedding_generations WHERE generation_id = 1",
    );
    expect(gen.rows[0]).toEqual({ model_name: "mxbai-embed-large", provider_name: "openai_compat" });
    const rt = await pool!.query<{ active_model_name: string }>("SELECT active_model_name FROM core.embedder_runtime_state");
    expect(rt.rows[0]!.active_model_name).toBe("mxbai-embed-large");
    const get = await app.inject({ method: "GET", url: "/api/admin/embedder-config", cookies: cookie("super_admin") });
    expect(get.json<{ last_validation_status: string }>().last_validation_status).toBe("ok");
    await app.close();
  });

  it("POST /test: probe fail → ok:false + validation persisted failed (no promote)", async () => {
    const app = await makeApp({ ok: false, dimension: null });
    await app.inject({
      method: "PUT",
      url: "/api/admin/embedder-config",
      cookies: cookie("super_admin"),
      payload: { base_url: "http://embedder.local:8080/v1", model_name: "mxbai-embed-large", api_key: "sk-x" },
    });
    const test = await app.inject({ method: "POST", url: "/api/admin/embedder-config/test", cookies: cookie("super_admin") });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ ok: false, error: "connectivity_error" });
    const gen = await pool!.query<{ provider_name: string }>("SELECT provider_name FROM core.embedding_generations WHERE generation_id = 1");
    expect(gen.rows[0]!.provider_name).toBe("qwen"); // NOT promoted
    const get = await app.inject({ method: "GET", url: "/api/admin/embedder-config", cookies: cookie("super_admin") });
    expect(get.json<{ last_validation_status: string }>().last_validation_status).toBe("failed");
    await app.close();
  });

  it("POST /test: a returned-but-wrong dimension → ok:false error=dimension_mismatch", async () => {
    const app = await makeApp({ ok: false, dimension: 512 });
    await app.inject({
      method: "PUT",
      url: "/api/admin/embedder-config",
      cookies: cookie("super_admin"),
      payload: { base_url: "http://e/v1", model_name: "m", api_key: "sk-x" },
    });
    const test = await app.inject({ method: "POST", url: "/api/admin/embedder-config/test", cookies: cookie("super_admin") });
    expect(test.json()).toMatchObject({ ok: false, error: "dimension_mismatch", detected_dimension: 512 });
    await app.close();
  });

  it("POST /test: 503 when the probe is unwired; 422 when no config is saved", async () => {
    const bare = await makeApp(); // no probe
    expect((await bare.inject({ method: "POST", url: "/api/admin/embedder-config/test", cookies: cookie("super_admin") })).statusCode).toBe(503);
    await bare.close();

    const wired = await makeApp({ ok: true }); // probe wired but no config staged
    expect((await wired.inject({ method: "POST", url: "/api/admin/embedder-config/test", cookies: cookie("super_admin") })).statusCode).toBe(422);
    await wired.close();
  });

  const insertSecondGen = async (): Promise<void> => {
    await new PostgresEmbeddingGenerationsRepo({ db: db! }).insertNew({
      modelName: "mxbai-embed-large",
      embeddingDimension: 1024,
      generationLabel: null,
      generationReason: null,
      createdByEmail: "admin@example.com",
      createdFromGeneration: 1,
    });
  };

  it("PUT: a model change on a non-greenfield corpus → 409 BEFORE overwriting the WORKING config (#1)", async () => {
    const app = await makeApp({ ok: true });
    // 1. greenfield: configure + validate model-a (promote → active generation = model-a)
    await app.inject({
      method: "PUT",
      url: "/api/admin/embedder-config",
      cookies: cookie("super_admin"),
      payload: { base_url: "http://e/v1", model_name: "model-a", api_key: "sk-a" },
    });
    await app.inject({ method: "POST", url: "/api/admin/embedder-config/test", cookies: cookie("super_admin") });
    // 2. corpus becomes non-greenfield
    await insertSecondGen();
    // 3. PUT a DIFFERENT model → 409, and model-a is left intact + still validated (NOT disabled)
    const put = await app.inject({
      method: "PUT",
      url: "/api/admin/embedder-config",
      cookies: cookie("super_admin"),
      payload: { base_url: "http://e/v1", model_name: "model-b" },
    });
    expect(put.statusCode).toBe(409);
    const get = await app.inject({ method: "GET", url: "/api/admin/embedder-config", cookies: cookie("super_admin") });
    expect(get.json()).toMatchObject({ model_name: "model-a", last_validation_status: "ok" });
    await app.close();
  });

  it("PUT: re-saving the SAME model on a non-greenfield corpus is allowed (not a contract change)", async () => {
    const app = await makeApp({ ok: true });
    await app.inject({
      method: "PUT",
      url: "/api/admin/embedder-config",
      cookies: cookie("super_admin"),
      payload: { base_url: "http://e/v1", model_name: "model-a", api_key: "sk-a" },
    });
    await app.inject({ method: "POST", url: "/api/admin/embedder-config/test", cookies: cookie("super_admin") });
    await insertSecondGen();
    // same model (e.g. editing the base_url) → no contract change → allowed
    const put = await app.inject({
      method: "PUT",
      url: "/api/admin/embedder-config",
      cookies: cookie("super_admin"),
      payload: { base_url: "http://e2/v1", model_name: "model-a" },
    });
    expect(put.statusCode).toBe(200);
    await app.close();
  });

  it("POST /test: a concurrent re-stage during a FAILED probe → 409 (not a stale ok:false 200) (#3)", async () => {
    // A probe that bumps config_revision (simulating a concurrent PUT) THEN fails → the failed-write CAS
    // misses → the route must 409, not stamp the new config 'failed' / return a stale 200.
    const app = buildApp({});
    const racingProbe: EmbedderProbePort = {
      probe: async () => {
        await pool!.query("UPDATE core.embedder_provider_settings SET config_revision = config_revision + 1");
        return { ok: false, detail: "boom", dimension: null, code: "connectivity_error" };
      },
    };
    await registerAdminRoutes(app, {
      db: db!,
      signingKey: SIGNING_KEY,
      clock: new FakeClock({ now: NOW }),
      getEmbedderProbe: () => racingProbe,
    });
    await app.ready();
    await app.inject({
      method: "PUT",
      url: "/api/admin/embedder-config",
      cookies: cookie("super_admin"),
      payload: { base_url: "http://e/v1", model_name: "mxbai-embed-large", api_key: "sk-x" },
    });
    const test = await app.inject({ method: "POST", url: "/api/admin/embedder-config/test", cookies: cookie("super_admin") });
    expect(test.statusCode).toBe(409);
    await app.close();
  });

  it("PUT enable-only toggle preserves the prior validation (D2-val) — no forced re-test", async () => {
    const app = await makeApp({ ok: true });
    const payload = { base_url: "http://embedder.local:8080/v1", model_name: "mxbai-embed-large" };
    await app.inject({
      method: "PUT",
      url: "/api/admin/embedder-config",
      cookies: cookie("super_admin"),
      payload: { ...payload, api_key: "sk-x" },
    });
    await app.inject({ method: "POST", url: "/api/admin/embedder-config/test", cookies: cookie("super_admin") }); // validation → ok
    // disable WITHOUT changing base_url / model / key → validation must be PRESERVED
    const put = await app.inject({
      method: "PUT",
      url: "/api/admin/embedder-config",
      cookies: cookie("super_admin"),
      payload: { ...payload, enabled: false },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/api/admin/embedder-config", cookies: cookie("super_admin") });
    expect(get.json()).toMatchObject({ enabled: false, last_validation_status: "ok" });
    await app.close();
  });
});
