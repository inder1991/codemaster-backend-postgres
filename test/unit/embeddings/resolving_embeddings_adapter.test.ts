// Unit tests for the ResolvingEmbeddingsAdapter (Phase 5 / D4). It resolves the EffectiveEmbedderConfig
// per embed, caches the inner adapter by the non-secret digest (rebuilding only when the config changes),
// throws EmbedderDisabledError when no config resolves, and — for the single-resolve guarantee (7-5) —
// stamps the EmbedResult.model_name with the CONFIGURED model so provenance can never drift from the
// request. Everything is injected (resolveConfig, readDigestParts, buildInner) → no DB / network.

import { describe, expect, it } from "vitest";

import {
  type EmbedRequest,
  type EmbedResult,
  type EmbeddingsPort,
  EmbedderDisabledError,
  EmbeddingsConnectivityError,
  EmbeddingsError,
} from "#backend/adapters/embeddings_port.js";
import { type EffectiveEmbedderConfig } from "#backend/adapters/effective_embedder_config.js";
import { ResolvingEmbeddingsAdapter } from "#backend/adapters/resolving_embeddings_adapter.js";

const REQ: EmbedRequest = { texts: ["hi"], model_name: "ignored", purpose: "confluence_chunk" };

/** A fake inner adapter that echoes a fixed model + records the config it was built from. */
class FakeInner implements EmbeddingsPort {
  public constructor(public readonly builtFrom: EffectiveEmbedderConfig) {}
  public async embed(): Promise<EmbedResult> {
    return { vectors: [[1, 2, 3]], model_name: "echoed-by-provider", model_version: "v", cache_hits: 0 };
  }
}

const DB_CONFIG: EffectiveEmbedderConfig = {
  baseUrl: "http://e/v1",
  apiKey: "sk-1",
  modelName: "configured-model",
  provider: "openai_compat",
  source: "db",
};

function digestParts(over: Record<string, unknown> = {}): {
  baseUrl: string;
  modelName: string;
  keyPresent: boolean;
  lastRotatedAt: Date | null;
  enabled: boolean;
  validationStatus: string | null;
} {
  return {
    baseUrl: "http://e/v1",
    modelName: "configured-model",
    keyPresent: true,
    lastRotatedAt: new Date("2026-06-15T00:00:00.000Z"),
    enabled: true,
    validationStatus: "ok",
    ...over,
  };
}

describe("ResolvingEmbeddingsAdapter", () => {
  it("embeds via the inner adapter and STAMPS the result model_name with the configured model (7-5)", async () => {
    const adapter = new ResolvingEmbeddingsAdapter({
      resolveConfig: async () => DB_CONFIG,
      readDigestParts: async () => digestParts(),
      buildInner: (cfg) => new FakeInner(cfg),
    });
    const r = await adapter.embed(REQ);
    expect(r.vectors).toEqual([[1, 2, 3]]);
    expect(r.model_name).toBe("configured-model"); // NOT the provider's "echoed-by-provider"
  });

  it("CACHES the inner adapter while the digest is unchanged, rebuilds when it changes", async () => {
    let builds = 0;
    let parts = digestParts();
    const adapter = new ResolvingEmbeddingsAdapter({
      resolveConfig: async () => DB_CONFIG,
      readDigestParts: async () => parts,
      buildInner: (cfg) => {
        builds += 1;
        return new FakeInner(cfg);
      },
    });
    await adapter.embed(REQ);
    await adapter.embed(REQ);
    expect(builds).toBe(1); // same digest → one build

    parts = digestParts({ modelName: "configured-model", lastRotatedAt: new Date("2026-06-16T00:00:00.000Z") });
    await adapter.embed(REQ);
    expect(builds).toBe(2); // digest changed → rebuilt
  });

  it("throws EmbedderDisabledError when no config resolves, and recovers after re-enable", async () => {
    let config: EffectiveEmbedderConfig | null = null;
    let parts: ReturnType<typeof digestParts> | null = null;
    const adapter = new ResolvingEmbeddingsAdapter({
      resolveConfig: async () => config,
      readDigestParts: async () => parts,
      buildInner: (cfg) => new FakeInner(cfg),
    });
    await expect(adapter.embed(REQ)).rejects.toBeInstanceOf(EmbedderDisabledError);

    config = DB_CONFIG;
    parts = digestParts();
    const r = await adapter.embed(REQ);
    expect(r.model_name).toBe("configured-model");
  });

  it("builds the inner adapter from the resolved config (keyless passes apiKey null)", async () => {
    let captured: EffectiveEmbedderConfig | null = null;
    const adapter = new ResolvingEmbeddingsAdapter({
      resolveConfig: async () => ({ ...DB_CONFIG, apiKey: null }),
      readDigestParts: async () => digestParts({ keyPresent: false }),
      buildInner: (cfg) => {
        captured = cfg;
        return new FakeInner(cfg);
      },
    });
    await adapter.embed(REQ);
    expect(captured!.apiKey).toBeNull();
  });

  it("EmbedderDisabledError is a SIBLING (NOT a connectivity subclass) so ingest fails-closed (7-8)", () => {
    const e = new EmbedderDisabledError("x");
    expect(e).toBeInstanceOf(EmbeddingsError);
    // Crucial: NOT a connectivity error — an ingest site that catches connectivity for transient blips
    // must NOT swallow a disabled-embedder error; it must propagate and fail the ingest.
    expect(e).not.toBeInstanceOf(EmbeddingsConnectivityError);
  });

  it("a digest-read failure with NO cache → EmbedderDisabledError (fail-closed; retrieval degrades)", async () => {
    const adapter = new ResolvingEmbeddingsAdapter({
      resolveConfig: async () => DB_CONFIG,
      readDigestParts: async () => {
        throw new Error("transient db blip");
      },
      buildInner: (cfg) => new FakeInner(cfg),
    });
    await expect(adapter.embed(REQ)).rejects.toBeInstanceOf(EmbedderDisabledError);
  });

  it("a digest-read failure WITH a warm cache → serves the cached config (no hard throw out of embed)", async () => {
    let fail = false;
    const adapter = new ResolvingEmbeddingsAdapter({
      resolveConfig: async () => DB_CONFIG,
      readDigestParts: async () => {
        if (fail) throw new Error("transient db blip");
        return digestParts();
      },
      buildInner: (cfg) => new FakeInner(cfg),
    });
    await adapter.embed(REQ); // warm the cache
    fail = true;
    const r = await adapter.embed(REQ); // digest read throws → serve cached config, no rejection
    expect(r.model_name).toBe("configured-model");
  });

  it("effectiveConfig() exposes the resolved config (for the EffectiveEmbedderConfigReader)", async () => {
    const adapter = new ResolvingEmbeddingsAdapter({
      resolveConfig: async () => DB_CONFIG,
      readDigestParts: async () => digestParts(),
      buildInner: (cfg) => new FakeInner(cfg),
    });
    expect(await adapter.effectiveConfig()).toEqual(DB_CONFIG);
  });
});
