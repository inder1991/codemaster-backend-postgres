// Regression guard for the HIGH wiring fix: resolveRuntimeEmbedder is the ONE registry-gated DB-vs-env
// selector used by EVERY runtime (review pipeline, background-runner ingest, ANN-fallback), so the corpus
// is ingested with the SAME UI-saved model the queries use. With the field-codec registry installed it
// returns the DB-backed ResolvingEmbeddingsAdapter; makeLazyRuntimeEmbedder defers all of that to the
// first embed so a DSN-less / pre-registry composition root stays bootable.

import { afterEach, describe, expect, it } from "vitest";

import {
  DbThenLegacyEnvEmbedder,
  makeLazyRuntimeEmbedder,
  resolveRuntimeEmbedder,
} from "#backend/adapters/resolve_embeddings.js";
import {
  type EmbedResult,
  type EmbeddingsPort,
  EmbedderDisabledError,
} from "#backend/adapters/embeddings_port.js";
import {
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

const DSN = "postgresql://codemaster:codemaster@localhost:5433/codemaster_test"; // lazy pool — never dialed

afterEach(() => {
  resetAuditKeyRegistryForTesting();
});

describe("resolveRuntimeEmbedder", () => {
  it("returns a runtime embedder (DB-then-legacy-env) when the field-codec registry is installed", () => {
    const reg = new KeyRegistry();
    reg.set(makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(8)]]) }));
    setAuditKeyRegistry(reg);
    expect(resolveRuntimeEmbedder({ dsn: DSN })).toBeInstanceOf(DbThenLegacyEnvEmbedder);
  });

  it("makeLazyRuntimeEmbedder does NOT resolve at construction (bootable DSN-less / pre-registry)", () => {
    resetAuditKeyRegistryForTesting();
    // No registry, no embedder env — eager resolveRuntimeEmbedder would fail-loud; the lazy wrapper must NOT.
    expect(() => makeLazyRuntimeEmbedder()).not.toThrow();
    expect(() => makeLazyRuntimeEmbedder({ dsn: DSN })).not.toThrow();
  });
});

describe("DbThenLegacyEnvEmbedder (DB-config > legacy-env > disabled)", () => {
  const RESULT: EmbedResult = { vectors: [[1]], model_name: "m", model_version: "v", cache_hits: 0 };
  const REQ = { texts: ["x"], model_name: "m", purpose: "p" };

  it("uses the DB adapter when it embeds successfully (no fallback)", async () => {
    const db: EmbeddingsPort = { embed: async () => RESULT };
    let legacyBuilt = false;
    const e = new DbThenLegacyEnvEmbedder(db, () => {
      legacyBuilt = true;
      return { embed: async () => RESULT };
    });
    expect((await e.embed(REQ)).model_name).toBe("m");
    expect(legacyBuilt).toBe(false);
  });

  it("falls back to the legacy env embedder on EmbedderDisabledError (no DB config)", async () => {
    const db: EmbeddingsPort = {
      embed: async () => {
        throw new EmbedderDisabledError("no DB config");
      },
    };
    const legacy: EmbeddingsPort = { embed: async () => ({ ...RESULT, model_name: "legacy-env" }) };
    const e = new DbThenLegacyEnvEmbedder(db, () => legacy);
    expect((await e.embed(REQ)).model_name).toBe("legacy-env");
  });

  it("re-throws EmbedderDisabledError when the legacy env is ALSO unconfigured (fail-loud factory)", async () => {
    const db: EmbeddingsPort = {
      embed: async () => {
        throw new EmbedderDisabledError("no DB config");
      },
    };
    const e = new DbThenLegacyEnvEmbedder(db, () => {
      throw new Error("CODEMASTER_QWEN_DSN required"); // legacy env not configured either
    });
    await expect(e.embed(REQ)).rejects.toBeInstanceOf(EmbedderDisabledError);
  });

  it("propagates a NON-disabled error (connectivity/etc.) without falling back", async () => {
    const db: EmbeddingsPort = {
      embed: async () => {
        throw new Error("boom");
      },
    };
    const e = new DbThenLegacyEnvEmbedder(db, () => ({ embed: async () => RESULT }));
    await expect(e.embed(REQ)).rejects.toThrow(/boom/);
  });
});
