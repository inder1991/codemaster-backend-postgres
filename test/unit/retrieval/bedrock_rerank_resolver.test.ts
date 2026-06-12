// W1.3 RH9 — buildBedrockRerankOverrideResolver: per-retrieval effective-config resolution into the
// rerankOverride seam. DB row > env > default-OFF; a settings-read fault FAILS OPEN to the env
// baseline (a DB blip must not silently flip the reranker on/off relative to the Helm intent — and
// must never fail retrieval).

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type BedrockRerankCredentialsSource,
  buildBedrockRerankOverrideResolver,
} from "#backend/retrieval/bedrock_rerank.js";
import { LlmRerank } from "#backend/retrieval/llm_rerank.js";
import { parseRerankEnv, type RerankStoredSettings } from "#backend/retrieval/rerank_config.js";

const CREDS: BedrockRerankCredentialsSource = async () => ({
  apiKey: "k-0123456789",
  region: "us-east-1",
});

const ENV_ENABLED = parseRerankEnv({
  CODEMASTER_RERANK_ENABLED: "true",
  CODEMASTER_RERANK_MODEL_ID: "cohere.rerank-v3-5:0",
});
const ENV_EMPTY = parseRerankEnv({});

const ROW_ENABLED: RerankStoredSettings = {
  enabled: true,
  modelId: "amazon.rerank-v1:0",
  region: "eu-central-1",
  topN: 10,
};
const ROW_DISABLED: RerankStoredSettings = { ...ROW_ENABLED, enabled: false };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildBedrockRerankOverrideResolver", () => {
  it("nothing configured → undefined (DEFAULT OFF: the IdentityRerankPort pass-through stands)", async () => {
    const resolve = buildBedrockRerankOverrideResolver({
      readSettings: async () => null,
      credentials: CREDS,
      env: ENV_EMPTY,
    });
    await expect(resolve()).resolves.toBeUndefined();
  });

  it("an enabled DB row → an LlmRerank override (the admin-API enable path)", async () => {
    const resolve = buildBedrockRerankOverrideResolver({
      readSettings: async () => ROW_ENABLED,
      credentials: CREDS,
      env: ENV_EMPTY,
    });
    await expect(resolve()).resolves.toBeInstanceOf(LlmRerank);
  });

  it("no DB row + env-enabled → an LlmRerank override (the Helm-only enable path)", async () => {
    const resolve = buildBedrockRerankOverrideResolver({
      readSettings: async () => null,
      credentials: CREDS,
      env: ENV_ENABLED,
    });
    await expect(resolve()).resolves.toBeInstanceOf(LlmRerank);
  });

  it("a DISABLED DB row beats an env-enabled baseline (UI kill-flip without a rollout)", async () => {
    const resolve = buildBedrockRerankOverrideResolver({
      readSettings: async () => ROW_DISABLED,
      credentials: CREDS,
      env: ENV_ENABLED,
    });
    await expect(resolve()).resolves.toBeUndefined();
  });

  it("a settings-read fault FAILS OPEN to the env baseline with a structured WARN", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const readSettings = async (): Promise<RerankStoredSettings | null> => {
      throw new Error("db blip");
    };
    const fromEnv = buildBedrockRerankOverrideResolver({ readSettings, credentials: CREDS, env: ENV_ENABLED });
    await expect(fromEnv()).resolves.toBeInstanceOf(LlmRerank);
    const silent = buildBedrockRerankOverrideResolver({ readSettings, credentials: CREDS, env: ENV_EMPTY });
    await expect(silent()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain("bedrock_rerank_failed");
  });
});
