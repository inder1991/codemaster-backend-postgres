// Phase 7 wiring: when the field-codec registry is installed (production boot), buildActivities() wires
// the DB-backed embedder (ResolvingEmbeddingsAdapter: DB-validated > env > disabled) and therefore does
// NOT require CODEMASTER_QWEN_DSN / the openai_compat env vars — the UI-saved config is the source. Without
// the registry it falls back to the env-only selection, which is fail-loud on missing embedder env.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildActivities } from "#backend/worker/build_activities.js";
import {
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

// Only the DSN is required (lazy pool — never dialed); every embedder env var is deliberately ABSENT so
// the test proves the DB path needs none of them.
const EMBEDDER_ENV = [
  "CODEMASTER_QWEN_DSN",
  "CODEMASTER_EMBEDDINGS_PROVIDER",
  "CODEMASTER_EMBEDDER_BASE_URL",
  "CODEMASTER_EMBEDDER_API_KEY",
  "CODEMASTER_EMBEDDER_MODEL_NAME",
];
const SAVED: Record<string, string | undefined> = {};

describe("buildActivities() embedder wiring (Phase 7)", () => {
  beforeEach(() => {
    for (const k of ["CODEMASTER_PG_CORE_DSN", ...EMBEDDER_ENV]) {
      SAVED[k] = process.env[k];
    }
    process.env["CODEMASTER_PG_CORE_DSN"] =
      "postgresql://codemaster:codemaster@localhost:5433/codemaster_test";
    for (const k of EMBEDDER_ENV) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    resetAuditKeyRegistryForTesting();
    for (const k of ["CODEMASTER_PG_CORE_DSN", ...EMBEDDER_ENV]) {
      const prev = SAVED[k];
      if (prev === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = prev;
      }
    }
  });

  it("with the registry installed, buildActivities() succeeds WITHOUT any embedder env (DB path)", () => {
    const reg = new KeyRegistry();
    reg.set(makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(5)]]) }));
    setAuditKeyRegistry(reg);
    // The DB-backed ResolvingEmbeddingsAdapter is lazy (no DB/network at construction) and reads no env.
    expect(() => buildActivities()).not.toThrow();
  });

  it("without the registry AND without embedder env, buildActivities() is fail-loud (env-only path)", () => {
    resetAuditKeyRegistryForTesting();
    expect(() => buildActivities()).toThrow(/CODEMASTER_QWEN_DSN|CODEMASTER_EMBEDDER/);
  });
});
