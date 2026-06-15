// Unit tests for the EffectiveEmbedderConfig resolver (Phase 4) — the policy that turns the DB row + env
// into the ONE config value that drives the request, provenance, and config-status (plan §3 / 6-2). The
// resolution order is DB-validated > env > none, FAIL-CLOSED:
//   - a DB row that is enabled AND validation='ok'        → source:'db';
//   - a DB row that is disabled OR not yet validated       → null (configured-but-not-ready ≠ fall to env);
//   - NO DB row at all                                     → env bootstrap fallback (source:'env', 7-6);
//   - a DB READ ERROR (cold start / outage)                → null, and env is NOT consulted (D2-val).
// The non-secret digest invalidates the Phase-5 adapter cache; it must change on any field change
// (including key rotation, captured via last_rotated_at) and be stable otherwise.

import { describe, expect, it } from "vitest";

import {
  type EmbedderConfigResolveDeps,
  effectiveConfigDigest,
  resolveEffectiveEmbedderConfig,
} from "#backend/adapters/effective_embedder_config.js";

function deps(over: Partial<EmbedderConfigResolveDeps> & Pick<EmbedderConfigResolveDeps, "readDbConfig">): EmbedderConfigResolveDeps {
  return { env: {}, ...over };
}

const DB_OK = {
  baseUrl: "http://db.embedder:8080/v1",
  modelName: "db-model",
  apiKey: "sk-db",
  enabled: true,
  validationStatus: "ok" as const,
  configRevision: 1,
};

const ENV_SET = {
  CODEMASTER_EMBEDDER_BASE_URL: "http://env.embedder:8080/v1",
  CODEMASTER_EMBEDDER_MODEL_NAME: "env-model",
  CODEMASTER_EMBEDDER_API_KEY: "sk-env",
};

describe("resolveEffectiveEmbedderConfig", () => {
  it("uses a validated, enabled DB row (source:db)", async () => {
    const cfg = await resolveEffectiveEmbedderConfig(deps({ readDbConfig: async () => DB_OK }));
    expect(cfg).toEqual({
      baseUrl: "http://db.embedder:8080/v1",
      apiKey: "sk-db",
      modelName: "db-model",
      provider: "openai_compat",
      source: "db",
    });
  });

  it("returns null when the DB row is present but validation != ok (fail-closed, no env fallback)", async () => {
    const cfg = await resolveEffectiveEmbedderConfig(
      deps({ readDbConfig: async () => ({ ...DB_OK, validationStatus: "failed" }), env: ENV_SET }),
    );
    expect(cfg).toBeNull();
  });

  it("returns null when the DB row is present but disabled (fail-closed, no env fallback)", async () => {
    const cfg = await resolveEffectiveEmbedderConfig(
      deps({ readDbConfig: async () => ({ ...DB_OK, enabled: false }), env: ENV_SET }),
    );
    expect(cfg).toBeNull();
  });

  it("falls back to env ONLY when there is no DB row at all (source:env)", async () => {
    const cfg = await resolveEffectiveEmbedderConfig(
      deps({ readDbConfig: async () => null, env: ENV_SET }),
    );
    expect(cfg).toEqual({
      baseUrl: "http://env.embedder:8080/v1",
      apiKey: "sk-env",
      modelName: "env-model",
      provider: "openai_compat",
      source: "env",
    });
  });

  it("env fallback is keyless when CODEMASTER_EMBEDDER_API_KEY is unset", async () => {
    const envNoKey = {
      CODEMASTER_EMBEDDER_BASE_URL: ENV_SET.CODEMASTER_EMBEDDER_BASE_URL,
      CODEMASTER_EMBEDDER_MODEL_NAME: ENV_SET.CODEMASTER_EMBEDDER_MODEL_NAME,
    };
    const cfg = await resolveEffectiveEmbedderConfig(
      deps({ readDbConfig: async () => null, env: envNoKey }),
    );
    expect(cfg?.apiKey).toBeNull();
    expect(cfg?.source).toBe("env");
  });

  it("returns null when there is no DB row and no env config", async () => {
    expect(await resolveEffectiveEmbedderConfig(deps({ readDbConfig: async () => null }))).toBeNull();
  });

  it("a DB read error PROPAGATES (not swallowed to null, env NOT consulted) so the adapter can map it to a connectivity-class error (rr-1)", async () => {
    // null would be indistinguishable from no-config and the legacy-env fallback would mask the outage by
    // embedding with the env model. The throw makes the adapter surface connectivity → retrieval lexical /
    // ingest fail-closed, never the env model.
    await expect(
      resolveEffectiveEmbedderConfig(
        deps({
          readDbConfig: async () => {
            throw new Error("connection refused");
          },
          env: ENV_SET,
        }),
      ),
    ).rejects.toThrow(/connection refused/);
  });
});

describe("effectiveConfigDigest", () => {
  const parts = {
    baseUrl: "http://e/v1",
    modelName: "m",
    keyPresent: true,
    lastRotatedAt: new Date("2026-06-15T00:00:00.000Z"),
    enabled: true,
    validationStatus: "ok" as const,
  };

  it("is stable for identical parts and changes on any field change (incl. key rotation via last_rotated_at)", () => {
    expect(effectiveConfigDigest(parts)).toBe(effectiveConfigDigest({ ...parts }));
    expect(effectiveConfigDigest(parts)).not.toBe(effectiveConfigDigest({ ...parts, modelName: "m2" }));
    expect(effectiveConfigDigest(parts)).not.toBe(effectiveConfigDigest({ ...parts, enabled: false }));
    expect(effectiveConfigDigest(parts)).not.toBe(
      effectiveConfigDigest({ ...parts, validationStatus: "failed" }),
    );
    expect(effectiveConfigDigest(parts)).not.toBe(
      effectiveConfigDigest({ ...parts, lastRotatedAt: new Date("2026-06-16T00:00:00.000Z") }),
    );
  });

  it("maps a null (no-config) to a stable sentinel", () => {
    expect(effectiveConfigDigest(null)).toBe(effectiveConfigDigest(null));
    expect(effectiveConfigDigest(null)).not.toBe(effectiveConfigDigest(parts));
  });
});
