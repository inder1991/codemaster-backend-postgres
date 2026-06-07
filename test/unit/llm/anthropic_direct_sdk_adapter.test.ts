// Unit coverage of the REAL AnthropicDirectSdkAdapter — the sibling of AnthropicBedrockSdkAdapter that
// calls `@anthropic-ai/sdk` (api.anthropic.com) instead of Bedrock. Asserts the same request-shape
// transform (system hoisted out of `messages`, tools/model/max_tokens passed), the response pass-through,
// the shared SDK-exception → Llm* mapping, AND the load-bearing difference from the Bedrock adapter: the
// SDK is constructed PER CALL (no caching), so a UI-driven key rotation is picked up on the next call.
//
// The SDK is a recorded-response DOUBLE injected via the `sdkFactory` seam — NO @anthropic-ai/* network.

import { describe, expect, it } from "vitest";

import {
  AnthropicDirectSdkAdapter,
  type AnthropicDirectCreateParams,
  type AnthropicDirectSdk,
} from "#backend/integrations/llm/anthropic_direct_sdk_adapter.js";
import {
  LlmCredentialsProvider,
  type LlmProviderSettingsRepoPort,
} from "#backend/integrations/llm/credentials_provider.js";
import { LlmAuthError, LlmServerError } from "#backend/integrations/llm/errors.js";
import {
  type LlmProviderRole,
  type LlmProviderSettings,
} from "#backend/integrations/llm/llm_provider_settings_repo.js";

import { APIConnectionError, AuthenticationError } from "@anthropic-ai/sdk";

class RecordedSdk implements AnthropicDirectSdk {
  public readonly calls: Array<AnthropicDirectCreateParams> = [];
  public closed = 0;
  private readonly response: Record<string, unknown>;
  private readonly throwOnCreate: unknown;

  public constructor(args: { response?: Record<string, unknown>; throwOnCreate?: unknown }) {
    this.response = args.response ?? { content: [{ type: "text", text: "ok" }] };
    this.throwOnCreate = args.throwOnCreate;
  }

  public readonly messages = {
    create: async (params: AnthropicDirectCreateParams): Promise<Record<string, unknown>> => {
      this.calls.push(params);
      if (this.throwOnCreate !== undefined) {
        throw this.throwOnCreate;
      }
      return this.response;
    },
  };

  public async close(): Promise<void> {
    this.closed += 1;
  }
}

class StubRepo implements LlmProviderSettingsRepoPort {
  private readonly map = new Map<LlmProviderRole, LlmProviderSettings | null>();
  public set(role: LlmProviderRole, value: LlmProviderSettings | null): void {
    this.map.set(role, value);
  }
  public async readDecryptedSettings(role: LlmProviderRole): Promise<LlmProviderSettings | null> {
    return this.map.get(role) ?? null;
  }
  public async readLastRotatedAt(): Promise<Date | null> {
    return null;
  }
}

function settings(overrides: Partial<LlmProviderSettings> = {}): LlmProviderSettings {
  return {
    provider: "anthropic_direct",
    modelId: "claude-sonnet-4-6",
    region: "",
    apiKey: "sk-direct-AAAA",
    enabled: true,
    ...overrides,
  };
}

function providerFor(repo: StubRepo): LlmCredentialsProvider {
  return new LlmCredentialsProvider({ repo });
}

describe("AnthropicDirectSdkAdapter.createMessage — request/response transform", () => {
  it("hoists the system message out of `messages`, passes tools + model + max_tokens", async () => {
    const repo = new StubRepo();
    repo.set("primary", settings());
    const sdk = new RecordedSdk({ response: { content: [{ type: "text", text: "done" }] } });
    const adapter = new AnthropicDirectSdkAdapter({
      provider: providerFor(repo),
      sdkFactory: async () => sdk,
    });
    const tools = [{ name: "emit_finding" }];
    const out = await adapter.createMessage({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "You are a reviewer." },
        { role: "user", content: "Review this diff." },
      ],
      maxTokens: 2048,
      tools,
      role: "primary",
    });
    expect(out).toEqual({ content: [{ type: "text", text: "done" }] });
    expect(sdk.calls).toHaveLength(1);
    const params = sdk.calls[0]!;
    expect(params.model).toBe("claude-sonnet-4-6");
    expect(params.max_tokens).toBe(2048);
    expect(params.system).toBe("You are a reviewer.");
    expect(params.messages).toEqual([{ role: "user", content: "Review this diff." }]);
    expect(params.tools).toEqual(tools);
  });

  it("omits `system` when no system message is present and omits `tools` when null", async () => {
    const repo = new StubRepo();
    repo.set("primary", settings());
    const sdk = new RecordedSdk({});
    const adapter = new AnthropicDirectSdkAdapter({
      provider: providerFor(repo),
      sdkFactory: async () => sdk,
    });
    await adapter.createMessage({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "no system here" }],
      maxTokens: 100,
      tools: null,
      role: "primary",
    });
    const params = sdk.calls[0]!;
    expect("system" in params).toBe(false);
    expect("tools" in params).toBe(false);
    expect(params.messages).toEqual([{ role: "user", content: "no system here" }]);
  });
});

describe("AnthropicDirectSdkAdapter — per-call SDK construction (NO caching, unlike Bedrock)", () => {
  it("constructs a fresh SDK on EVERY call so a key rotation is picked up next call", async () => {
    const repo = new StubRepo();
    repo.set("primary", settings());
    let built = 0;
    const adapter = new AnthropicDirectSdkAdapter({
      provider: providerFor(repo),
      sdkFactory: async () => {
        built += 1;
        return new RecordedSdk({});
      },
    });
    const base = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
      tools: null,
      role: "primary" as const,
    };
    await adapter.createMessage(base);
    await adapter.createMessage(base);
    await adapter.createMessage(base);
    expect(built).toBe(3); // one construction per call — credentials (and rotations) resolved fresh
  });
});

describe("AnthropicDirectSdkAdapter — exception mapping (shared with Bedrock)", () => {
  it("maps an auth error → LlmAuthError (non-retryable)", async () => {
    const repo = new StubRepo();
    repo.set("primary", settings());
    const sdk = new RecordedSdk({
      throwOnCreate: new AuthenticationError(401, { type: "error" }, "bad key", new Headers()),
    });
    const adapter = new AnthropicDirectSdkAdapter({
      provider: providerFor(repo),
      sdkFactory: async () => sdk,
    });
    await expect(
      adapter.createMessage({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 10,
        tools: null,
        role: "primary",
      }),
    ).rejects.toBeInstanceOf(LlmAuthError);
  });

  it("maps a connection error → LlmServerError (retryable)", async () => {
    const repo = new StubRepo();
    repo.set("primary", settings());
    const sdk = new RecordedSdk({ throwOnCreate: new APIConnectionError({ message: "Connection error." }) });
    const adapter = new AnthropicDirectSdkAdapter({
      provider: providerFor(repo),
      sdkFactory: async () => sdk,
    });
    await expect(
      adapter.createMessage({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 10,
        tools: null,
        role: "primary",
      }),
    ).rejects.toBeInstanceOf(LlmServerError);
  });
});
