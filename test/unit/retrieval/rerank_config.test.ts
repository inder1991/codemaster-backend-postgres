// W1.3 RH9 — the Bedrock re-ranker config contract: Helm/env parsing (boot, fail-loud) + the
// DB-row-over-env precedence the admin PUT relies on. DEFAULT OFF: with nothing configured the
// effective config is disabled and retrieval keeps the IdentityRerankPort pass-through.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RERANK_TOP_N,
  RERANK_MODELS,
  parseRerankEnv,
  resolveEffectiveRerankConfig,
} from "#backend/retrieval/rerank_config.js";

describe("parseRerankEnv (the Helm → CODEMASTER_RERANK_* boot read)", () => {
  it("empty env → DEFAULT OFF (disabled, no model, default top-N)", () => {
    expect(parseRerankEnv({})).toEqual({
      enabled: false,
      modelId: null,
      region: null,
      topN: DEFAULT_RERANK_TOP_N,
    });
  });

  it("fully-specified env → parsed verbatim", () => {
    expect(
      parseRerankEnv({
        CODEMASTER_RERANK_ENABLED: "true",
        CODEMASTER_RERANK_MODEL_ID: "cohere.rerank-v3-5:0",
        CODEMASTER_RERANK_REGION: "us-west-2",
        CODEMASTER_RERANK_TOP_N: "30",
      }),
    ).toEqual({ enabled: true, modelId: "cohere.rerank-v3-5:0", region: "us-west-2", topN: 30 });
  });

  it("a staged (disabled) model id parses — operators pre-stage the model and flip later", () => {
    expect(
      parseRerankEnv({ CODEMASTER_RERANK_MODEL_ID: "amazon.rerank-v1:0" }),
    ).toEqual({ enabled: false, modelId: "amazon.rerank-v1:0", region: null, topN: DEFAULT_RERANK_TOP_N });
  });

  it("FAIL-LOUD: enabled without a model id", () => {
    expect(() => parseRerankEnv({ CODEMASTER_RERANK_ENABLED: "true" })).toThrow(
      /CODEMASTER_RERANK_MODEL_ID/,
    );
  });

  it("FAIL-LOUD: a model id outside the supported rerank set", () => {
    expect(() =>
      parseRerankEnv({ CODEMASTER_RERANK_MODEL_ID: "anthropic.claude-3-haiku" }),
    ).toThrow(/CODEMASTER_RERANK_MODEL_ID/);
  });

  it("FAIL-LOUD: unparseable / out-of-range top-N and a malformed enabled token", () => {
    for (const topN of ["abc", "0", "101", "2.5"]) {
      expect(() => parseRerankEnv({ CODEMASTER_RERANK_TOP_N: topN })).toThrow(
        /CODEMASTER_RERANK_TOP_N/,
      );
    }
    expect(() => parseRerankEnv({ CODEMASTER_RERANK_ENABLED: "yes-please" })).toThrow(
      /CODEMASTER_RERANK_ENABLED/,
    );
  });

  it("FAIL-LOUD: a region that is not an AWS region shape", () => {
    expect(() =>
      parseRerankEnv({
        CODEMASTER_RERANK_MODEL_ID: "amazon.rerank-v1:0",
        CODEMASTER_RERANK_REGION: "not a region",
      }),
    ).toThrow(/CODEMASTER_RERANK_REGION/);
  });
});

describe("resolveEffectiveRerankConfig (DB row beats env beats default)", () => {
  const envEnabled = parseRerankEnv({
    CODEMASTER_RERANK_ENABLED: "true",
    CODEMASTER_RERANK_MODEL_ID: "cohere.rerank-v3-5:0",
  });

  it("no row + empty env → the disabled default (the DEFAULT-OFF proof)", () => {
    expect(resolveEffectiveRerankConfig({ row: null, env: parseRerankEnv({}) })).toEqual({
      config: { enabled: false, modelId: null, region: null, topN: DEFAULT_RERANK_TOP_N },
      source: "default",
    });
  });

  it("no row + env-configured → the env config (Helm-only operation)", () => {
    expect(resolveEffectiveRerankConfig({ row: null, env: envEnabled })).toEqual({
      config: envEnabled,
      source: "environment",
    });
  });

  it("a DB row wins over env entirely — including DISABLING an env-enabled reranker", () => {
    const row = {
      enabled: false,
      modelId: "amazon.rerank-v1:0",
      region: "eu-central-1",
      topN: 10,
    };
    expect(resolveEffectiveRerankConfig({ row, env: envEnabled })).toEqual({
      config: { enabled: false, modelId: "amazon.rerank-v1:0", region: "eu-central-1", topN: 10 },
      source: "database",
    });
  });
});

describe("RERANK_MODELS (the supported Bedrock rerank-API models)", () => {
  it("carries exactly the Cohere + Amazon rerank models", () => {
    expect([...RERANK_MODELS].sort()).toEqual(["amazon.rerank-v1:0", "cohere.rerank-v3-5:0"]);
  });
});
