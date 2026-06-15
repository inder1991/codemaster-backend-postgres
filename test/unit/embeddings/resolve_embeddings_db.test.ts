// Unit test for the DB-backed branch of resolveEmbeddingsConsumer (Phase 5 rewire). With an
// embedderConfigPort it returns a ResolvingEmbeddingsAdapter that resolves DB-validated > env > none;
// without one, the legacy env-only selection is untouched (covered by existing tests). We verify the
// wiring via effectiveConfig() (no network / inner-adapter build).

import { describe, expect, it } from "vitest";

import {
  type EmbedderConfigReadPort,
  resolveEmbeddingsConsumer,
} from "#backend/adapters/resolve_embeddings.js";
import { ResolvingEmbeddingsAdapter } from "#backend/adapters/resolving_embeddings_adapter.js";

const DB_ROW = {
  baseUrl: "http://db.embedder:8080/v1",
  modelName: "db-model",
  apiKey: "sk-db",
  enabled: true,
  validationStatus: "ok" as const,
};

const NON_SECRET = {
  provider: "openai_compat" as const,
  baseUrl: "http://db.embedder:8080/v1",
  modelName: "db-model",
  keyPresent: true,
  enabled: true,
  lastValidationStatus: "ok" as const,
  lastValidationError: null,
  lastValidatedAt: new Date("2026-06-15T00:00:00.000Z"),
  lastRotatedAt: new Date("2026-06-15T00:00:00.000Z"),
  lastRotatedBy: "admin@example.com",
  updatedAt: new Date("2026-06-15T00:00:00.000Z"),
};

const port: EmbedderConfigReadPort = {
  readForResolve: async () => DB_ROW,
  readNonSecret: async () => NON_SECRET,
};

describe("resolveEmbeddingsConsumer DB-backed branch", () => {
  it("returns a ResolvingEmbeddingsAdapter wired to the DB config when a port is supplied", async () => {
    const e = resolveEmbeddingsConsumer({ embedderConfigPort: port, env: {} });
    expect(e).toBeInstanceOf(ResolvingEmbeddingsAdapter);
    expect(await (e as ResolvingEmbeddingsAdapter).effectiveConfig()).toEqual({
      baseUrl: "http://db.embedder:8080/v1",
      apiKey: "sk-db",
      modelName: "db-model",
      provider: "openai_compat",
      source: "db",
    });
  });

  it("a disabled DB row + no env → effectiveConfig() null (the embed path would fail-closed)", async () => {
    const disabledPort: EmbedderConfigReadPort = {
      readForResolve: async () => ({ ...DB_ROW, enabled: false }),
      readNonSecret: async () => ({ ...NON_SECRET, enabled: false }),
    };
    const e = resolveEmbeddingsConsumer({ embedderConfigPort: disabledPort, env: {} });
    expect(await (e as ResolvingEmbeddingsAdapter).effectiveConfig()).toBeNull();
  });
});
