// Unit tests for the LLM provider-config write/test contract cross-field invariants (superRefine),
// 1:1 with the Python model_validators in contracts/admin/llm_provider_config/v1.py.

import { describe, expect, it } from "vitest";

import { LlmCredentialsTestV1, LlmProviderConfigUpdateV1 } from "#contracts/admin.v1.js";

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

  it("rejects a bedrock model_id without the anthropic./claude- prefix", () => {
    expect(
      LlmProviderConfigUpdateV1.safeParse({
        provider: "bedrock",
        role: "primary",
        model_id: "gpt-4",
        region: "us-east-1",
        api_key: KEY,
      }).success,
    ).toBe(false);
  });

  it("rejects an anthropic_direct model_id that is not claude-prefixed", () => {
    expect(
      LlmProviderConfigUpdateV1.safeParse({
        provider: "anthropic_direct",
        role: "primary",
        model_id: "anthropic.claude-sonnet-4-6", // anthropic. prefix is bedrock-only
        region: null,
        api_key: KEY,
      }).success,
    ).toBe(false);
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
