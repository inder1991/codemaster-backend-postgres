// Unit tests for the LLM provider-config write/test contract cross-field invariants (superRefine),
// 1:1 with the Python model_validators in contracts/admin/llm_provider_config/v1.py.

import { describe, expect, it } from "vitest";

import { LegacyBedrockConfigUpdateBodyV1, LlmCredentialsTestV1, LlmProviderConfigUpdateV1 } from "#contracts/admin.v1.js";

const KEY = "sk-ant-0123456789abcdef"; // ≥20 chars

describe("LlmProviderConfigUpdateV1 cross-field invariants", () => {
  it("accepts a valid bedrock config (region + anthropic.-prefixed model)", () => {
    const r = LlmProviderConfigUpdateV1.safeParse({
      provider: "bedrock",
      role: "primary",
      model_id: "anthropic.claude-sonnet-4-6",
      region: "us-east-1",
      api_key: KEY,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.enabled).toBe(true); // default
      expect(r.data.schema_version).toBe(1);
    }
  });

  it("accepts a valid anthropic_direct config (no region, claude- model)", () => {
    expect(
      LlmProviderConfigUpdateV1.safeParse({
        provider: "anthropic_direct",
        role: "secondary",
        model_id: "claude-sonnet-4-6",
        region: null,
        api_key: KEY,
      }).success,
    ).toBe(true);
  });

  it("rejects bedrock without a region", () => {
    const r = LlmProviderConfigUpdateV1.safeParse({
      provider: "bedrock",
      role: "primary",
      model_id: "anthropic.claude-sonnet-4-6",
      region: null,
      api_key: KEY,
    });
    expect(r.success).toBe(false);
  });

  // The model_id name-prefix gate is DROPPED — the live preflight ping is the validator, and a static
  // regex cannot express Bedrock cross-region inference-profile IDs (us./eu./apac.-prefixed).
  it("accepts a region-prefixed bedrock inference-profile model_id (us.anthropic.…)", () => {
    expect(
      LlmProviderConfigUpdateV1.safeParse({
        provider: "bedrock",
        role: "primary",
        model_id: "us.anthropic.claude-sonnet-4-6-v1:0",
        region: "us-east-1",
        api_key: KEY,
      }).success,
    ).toBe(true);
  });

  it("accepts an arbitrary bedrock model_id with a region (prefix gate dropped; preflight is the gate)", () => {
    expect(
      LlmProviderConfigUpdateV1.safeParse({
        provider: "bedrock",
        role: "primary",
        model_id: "gpt-4",
        region: "us-east-1",
        api_key: KEY,
      }).success,
    ).toBe(true);
  });

  it("accepts an arbitrary anthropic_direct model_id (prefix gate dropped; preflight is the gate)", () => {
    expect(
      LlmProviderConfigUpdateV1.safeParse({
        provider: "anthropic_direct",
        role: "primary",
        model_id: "anthropic.claude-sonnet-4-6",
        region: null,
        api_key: KEY,
      }).success,
    ).toBe(true);
  });

  it("rejects a short api_key (<20 chars) and a malformed region", () => {
    expect(
      LlmProviderConfigUpdateV1.safeParse({
        provider: "bedrock",
        role: "primary",
        model_id: "claude-sonnet-4-6",
        region: "us-east-1",
        api_key: "too-short",
      }).success,
    ).toBe(false);
    expect(
      LlmProviderConfigUpdateV1.safeParse({
        provider: "bedrock",
        role: "primary",
        model_id: "claude-sonnet-4-6",
        region: "US_EAST_1",
        api_key: KEY,
      }).success,
    ).toBe(false);
  });
});

describe("LlmCredentialsTestV1 cross-field invariants (model-less)", () => {
  it("accepts anthropic_direct without region; bedrock with region", () => {
    expect(
      LlmCredentialsTestV1.safeParse({ provider: "anthropic_direct", region: null, api_key: KEY }).success,
    ).toBe(true);
    expect(LlmCredentialsTestV1.safeParse({ provider: "bedrock", region: "eu-west-1", api_key: KEY }).success).toBe(
      true,
    );
  });

  it("rejects bedrock without region", () => {
    expect(LlmCredentialsTestV1.safeParse({ provider: "bedrock", region: null, api_key: KEY }).success).toBe(false);
  });
});

describe("LegacyBedrockConfigUpdateBodyV1 (deprecated shim)", () => {
  it("accepts a region-prefixed Bedrock inference-profile model_id (prefix gate dropped)", () => {
    expect(
      LegacyBedrockConfigUpdateBodyV1.safeParse({
        model_id: "us.anthropic.claude-sonnet-4-6-v1:0",
        region: "us-east-1",
        api_key: KEY,
      }).success,
    ).toBe(true);
  });
});
