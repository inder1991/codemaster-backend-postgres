// Unit tests for the REAL preflight validators (1:1 with preflight_validator.py). Inject a fake SDK-client
// factory so the @anthropic-ai SDKs are never loaded; assert the success/timeout/status/generic error
// mapping + token redaction + the bedrock credentials-test default model + the provider factory.

import { describe, expect, it } from "vitest";

import {
  AnthropicDirectPreflightValidator,
  BedrockPreflightValidator,
  getPreflightValidator,
  type BedrockClientFactory,
  type DirectClientFactory,
} from "#backend/integrations/llm/preflight_validator_real.js";

const KEY = "sk-ant-secret-0123456789"; // ≥ 8 chars (redaction applies)

class FakeApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
class FakeTimeoutError extends Error {
  public constructor() {
    super("connection timed out");
    this.name = "APIConnectionTimeoutError";
  }
}

const okBedrock: BedrockClientFactory = async () => ({ messages: { create: async () => ({}) } });
const throwingBedrock =
  (err: unknown): BedrockClientFactory =>
  async () => ({
    messages: {
      create: async () => {
        throw err;
      },
    },
  });
const okDirect: DirectClientFactory = async () => ({
  messages: { create: async () => ({}) },
  models: { list: async () => ({}) },
});
const throwingDirect =
  (err: unknown): DirectClientFactory =>
  async () => ({
    messages: {
      create: async () => {
        throw err;
      },
    },
    models: {
      list: async () => {
        throw err;
      },
    },
  });

describe("BedrockPreflightValidator", () => {
  it("ok on a successful 1-token ping", async () => {
    const r = await new BedrockPreflightValidator({ clientFactory: okBedrock }).validate({
      apiKey: KEY,
      modelId: "anthropic.claude-sonnet-4-6",
      region: "us-east-1",
    });
    expect(r).toEqual({ ok: true, errorMessage: null });
  });

  it("timeout → ok:false with the Bedrock timeout message", async () => {
    const r = await new BedrockPreflightValidator({ clientFactory: throwingBedrock(new FakeTimeoutError()) }).validate({
      apiKey: KEY,
      modelId: "anthropic.claude-sonnet-4-6",
      region: "eu-west-1",
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("timeout: Bedrock did not respond within 5.0s");
    expect(r.errorMessage).toContain("region='eu-west-1'");
  });

  it("APIStatusError → 'upstream returned <status>' with class name", async () => {
    const r = await new BedrockPreflightValidator({
      clientFactory: throwingBedrock(new FakeApiError("forbidden", 403)),
    }).validate({ apiKey: KEY, modelId: "anthropic.claude-sonnet-4-6", region: "us-east-1" });
    expect(r.errorMessage).toBe("upstream returned 403: FakeApiError: forbidden");
  });

  it("generic error → 'unexpected error during preflight' + redacts the token", async () => {
    const r = await new BedrockPreflightValidator({
      clientFactory: throwingBedrock(new Error(`bad token ${KEY} rejected`)),
    }).validate({ apiKey: KEY, modelId: "anthropic.claude-sonnet-4-6", region: "us-east-1" });
    expect(r.errorMessage).toBe("unexpected error during preflight: Error: bad token <REDACTED-API-KEY> rejected");
  });

  it("validateCredentials pings the default model claude-sonnet-4-6", async () => {
    let captured = "";
    const factory: BedrockClientFactory = async () => ({
      messages: {
        create: async (a) => {
          captured = a.model;
          return {};
        },
      },
    });
    const r = await new BedrockPreflightValidator({ clientFactory: factory }).validateCredentials({ apiKey: KEY, region: "us-east-1" });
    expect(r.ok).toBe(true);
    expect(captured).toBe("claude-sonnet-4-6");
  });
});

describe("AnthropicDirectPreflightValidator", () => {
  it("ok on a successful ping; validateCredentials uses models.list", async () => {
    const v = new AnthropicDirectPreflightValidator({ clientFactory: okDirect });
    expect((await v.validate({ apiKey: KEY, modelId: "claude-sonnet-4-6", region: null })).ok).toBe(true);
    expect((await v.validateCredentials({ apiKey: KEY, region: null })).ok).toBe(true);
  });

  it("timeout → Anthropic Direct timeout message", async () => {
    const r = await new AnthropicDirectPreflightValidator({ clientFactory: throwingDirect(new FakeTimeoutError()) }).validate({
      apiKey: KEY,
      modelId: "claude-sonnet-4-6",
      region: null,
    });
    expect(r.errorMessage).toContain("timeout: Anthropic Direct did not respond within 5.0s");
  });

  it("status error → '<status>: <message>' with redaction (no 'upstream returned' prefix)", async () => {
    const r = await new AnthropicDirectPreflightValidator({
      clientFactory: throwingDirect(new FakeApiError(`401 unauthorized ${KEY}`, 401)),
    }).validateCredentials({ apiKey: KEY, region: null });
    expect(r.errorMessage).toBe("401: 401 unauthorized <REDACTED-API-KEY>");
  });
});

describe("getPreflightValidator", () => {
  it("returns the provider-specific validator", () => {
    expect(getPreflightValidator("bedrock")).toBeInstanceOf(BedrockPreflightValidator);
    expect(getPreflightValidator("anthropic_direct")).toBeInstanceOf(AnthropicDirectPreflightValidator);
  });
});
