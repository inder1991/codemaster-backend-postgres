// Regression guard for the HIGH wiring fix: resolveRuntimeEmbedder is the ONE registry-gated DB-vs-env
// selector used by EVERY runtime (review pipeline, background-runner ingest, ANN-fallback), so the corpus
// is ingested with the SAME UI-saved model the queries use. With the field-codec registry installed it
// returns the DB-backed ResolvingEmbeddingsAdapter; makeLazyRuntimeEmbedder defers all of that to the
// first embed so a DSN-less / pre-registry composition root stays bootable.

import { afterEach, describe, expect, it } from "vitest";

import {
  makeLazyRuntimeEmbedder,
  resolveRuntimeEmbedder,
} from "#backend/adapters/resolve_embeddings.js";
import { ResolvingEmbeddingsAdapter } from "#backend/adapters/resolving_embeddings_adapter.js";
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
  it("returns the DB-backed ResolvingEmbeddingsAdapter when the field-codec registry is installed", () => {
    const reg = new KeyRegistry();
    reg.set(makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(8)]]) }));
    setAuditKeyRegistry(reg);
    expect(resolveRuntimeEmbedder({ dsn: DSN })).toBeInstanceOf(ResolvingEmbeddingsAdapter);
  });

  it("makeLazyRuntimeEmbedder does NOT resolve at construction (bootable DSN-less / pre-registry)", () => {
    resetAuditKeyRegistryForTesting();
    // No registry, no embedder env — eager resolveRuntimeEmbedder would fail-loud; the lazy wrapper must NOT.
    expect(() => makeLazyRuntimeEmbedder()).not.toThrow();
    expect(() => makeLazyRuntimeEmbedder({ dsn: DSN })).not.toThrow();
  });
});
