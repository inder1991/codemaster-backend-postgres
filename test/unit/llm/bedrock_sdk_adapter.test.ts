// Unit coverage of the REAL AnthropicBedrockSdkAdapter (de-stub step 3) — the request-shape transform
// (system hoisted out of messages, tools passed through, model/max_tokens), the response `model_dump`
// pass-through, the SDK-exception → Llm* mapping, and the SDK cache rebuild-on-cred-change / reuse rule.
//
// The SDK is a RECORDED-RESPONSE DOUBLE injected via the `sdkFactory` seam (the user-approved cassette
// stand-in for the unreachable Bedrock service) — NO @anthropic-ai/* import, NO AWS call. The real
// `defaultBedrockSdkFactory` (the bearer-authed `@anthropic-ai/bedrock-sdk`) is NEVER triggered here.
//
// The credentials provider is driven by the REAL LlmCredentialsProvider over a stub settings repo so
// the role→creds resolution + the SDK-cache keying on the credential triple are exercised end to end.

import { describe, expect, it } from "vitest";

import {
  AnthropicBedrockSdkAdapter,
  type BedrockCreateParams,
  type BedrockRequestOptions,
  type BedrockSdk,
  hoistSystemMessages,
  mapAnthropicException,
} from "#backend/integrations/llm/bedrock_sdk_adapter.js";
import {
  LlmCredentialsProvider,
  type LlmProviderSettingsRepoPort,
} from "#backend/integrations/llm/credentials_provider.js";
import {
  LlmAuthError,
  LlmInvocationError,
  LlmRateLimitError,
  LlmServerError,
  LlmTimeoutError,
} from "#backend/integrations/llm/errors.js";
import {
  type LlmProviderRole,
  type LlmProviderSettings,
} from "#backend/integrations/llm/llm_provider_settings_repo.js";

import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";

// ─── recorded-response SDK double + a capturing factory ────────────────────────────────────────

/**
 * A recorded-response SDK double satisfying {@link BedrockSdk}: `messages.create` records the params it
 * was called with and returns the recorded response (or throws a scripted error). The call args are
 * captured so a test can assert the request shape the adapter built. `close()` is recorded too.
 */
class RecordedSdk implements BedrockSdk {
  public readonly calls: Array<BedrockCreateParams> = [];
  // W4.2b — capture the 2nd `RequestOptions`-shaped arg of `messages.create` (one slot per call,
  // `undefined` when no opts arg was passed) so a test can assert a forwarded `signal` reaches the SDK
  // request options AND that the absent case passes NO opts arg (byte-identical to the pre-W4.2b call).
  public readonly optsCalls: Array<BedrockRequestOptions | undefined> = [];
  public closed = 0;
  private readonly response: Record<string, unknown>;
  private readonly throwOnCreate: unknown;

  public constructor(args: { response?: Record<string, unknown>; throwOnCreate?: unknown }) {
    this.response = args.response ?? { content: [{ type: "text", text: "ok" }] };
    this.throwOnCreate = args.throwOnCreate;
  }

  public readonly messages = {
    create: async (
      params: BedrockCreateParams,
      opts?: BedrockRequestOptions,
    ): Promise<Record<string, unknown>> => {
      this.calls.push(params);
      this.optsCalls.push(opts);
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

/** A settings-repo stub for the credentials provider — returns a per-role settings object. */
class StubRepo implements LlmProviderSettingsRepoPort {
  private readonly settings = new Map<LlmProviderRole, LlmProviderSettings | null>();

  public set(role: LlmProviderRole, value: LlmProviderSettings | null): void {
    this.settings.set(role, value);
  }

  public async readDecryptedSettings(role: LlmProviderRole): Promise<LlmProviderSettings | null> {
    return this.settings.get(role) ?? null;
  }

  public async readLastRotatedAt(): Promise<Date | null> {
    return null;
  }
}

function settings(overrides: Partial<LlmProviderSettings> = {}): LlmProviderSettings {
  return {
    provider: "bedrock",
    modelId: "claude-sonnet-4-6",
    region: "us-east-1",
    apiKey: "sk-token-AAAA",
    enabled: true,
    ...overrides,
  };
}

function providerFor(repo: StubRepo): LlmCredentialsProvider {
  return new LlmCredentialsProvider({ repo });
}

describe("AnthropicBedrockSdkAdapter.createMessage — request/response transform", () => {
  it("hoists the system message out of `messages`, passes tools + model + max_tokens", async () => {
    const repo = new StubRepo();
    repo.set("primary", settings());
    const sdk = new RecordedSdk({
      response: { content: [{ type: "text", text: "done" }], usage: { input_tokens: 3 } },
    });
    const adapter = new AnthropicBedrockSdkAdapter({
      provider: providerFor(repo),
      sdkFactory: async () => sdk,
    });

    const tools = [{ name: "report_finding", input_schema: { type: "object" } }];
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

    // Response is returned verbatim (the `.model_dump()` analogue — a plain object pass-through).
    expect(out).toEqual({ content: [{ type: "text", text: "done" }], usage: { input_tokens: 3 } });

    // The request the adapter built: system hoisted to the top-level kwarg; messages carries only the
    // user/assistant entries; tools/model/max_tokens passed through.
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
    const adapter = new AnthropicBedrockSdkAdapter({
      provider: providerFor(repo),
      sdkFactory: async () => sdk,
    });

    await adapter.createMessage({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "no system here" }],
      maxTokens: 512,
      tools: null,
      role: "primary",
    });

    const params = sdk.calls[0]!;
    expect("system" in params).toBe(false);
    expect("tools" in params).toBe(false);
    expect(params.messages).toEqual([{ role: "user", content: "no system here" }]);
  });

  it("joins multiple system entries with a blank line, in document order", async () => {
    const repo = new StubRepo();
    repo.set("primary", settings());
    const sdk = new RecordedSdk({});
    const adapter = new AnthropicBedrockSdkAdapter({
      provider: providerFor(repo),
      sdkFactory: async () => sdk,
    });

    await adapter.createMessage({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "first" },
        { role: "user", content: "u" },
        { role: "system", content: "second" },
      ],
      maxTokens: 256,
      role: "primary",
    });

    expect(sdk.calls[0]!.system).toBe("first\n\nsecond");
    expect(sdk.calls[0]!.messages).toEqual([{ role: "user", content: "u" }]);
  });
});

describe("AnthropicBedrockSdkAdapter.createMessage — AbortSignal threading (W4.2b, gate ①)", () => {
  it("forwards a passed `signal` into the SDK request options (2nd arg)", async () => {
    const repo = new StubRepo();
    repo.set("primary", settings());
    const sdk = new RecordedSdk({});
    const adapter = new AnthropicBedrockSdkAdapter({
      provider: providerFor(repo),
      sdkFactory: async () => sdk,
    });

    const controller = new AbortController();
    await adapter.createMessage({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 16,
      tools: null,
      role: "primary",
      signal: controller.signal,
    });

    // The in-flight Bedrock call RECEIVES the caller's signal via `RequestOptions.signal`.
    expect(sdk.optsCalls).toHaveLength(1);
    expect(sdk.optsCalls[0]).toEqual({ signal: controller.signal });
    expect(sdk.optsCalls[0]!.signal).toBe(controller.signal);
  });

  it("passes NO opts arg when `signal` is absent (byte-identical to the pre-W4.2b call)", async () => {
    const repo = new StubRepo();
    repo.set("primary", settings());
    const sdk = new RecordedSdk({});
    const adapter = new AnthropicBedrockSdkAdapter({
      provider: providerFor(repo),
      sdkFactory: async () => sdk,
    });

    await adapter.createMessage({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 16,
      tools: null,
      role: "primary",
    });

    // No `signal` → the SDK is called with exactly ONE positional arg (the params); the 2nd opts arg is
    // never supplied, so an absent-signal call is byte-identical to the Temporal path.
    expect(sdk.optsCalls).toHaveLength(1);
    expect(sdk.optsCalls[0]).toBeUndefined();
  });
});

describe("AnthropicBedrockSdkAdapter — SDK cache rebuild rule", () => {
  it("reuses the same SDK across calls while credentials are unchanged", async () => {
    const repo = new StubRepo();
    repo.set("primary", settings({ apiKey: "sk-stable" }));
    let built = 0;
    const sdk = new RecordedSdk({});
    const adapter = new AnthropicBedrockSdkAdapter({
      provider: providerFor(repo),
      sdkFactory: async () => {
        built += 1;
        return sdk;
      },
    });

    await adapter.createMessage({ model: "claude-sonnet-4-6", messages: [], maxTokens: 16, role: "primary" });
    await adapter.createMessage({ model: "claude-sonnet-4-6", messages: [], maxTokens: 16, role: "primary" });

    // One build despite two calls — the credential triple did not change.
    expect(built).toBe(1);
  });

  it("rebuilds the SDK when the credential triple changes (rotation)", async () => {
    const repo = new StubRepo();
    repo.set("primary", settings({ apiKey: "sk-v1" }));
    // Fresh provider per call (ttlSeconds default is fine; we mutate the row + reset via a new provider
    // instance keyed off the same repo by constructing the adapter with a provider whose cache we bust
    // by rotating the underlying row). Simpler: drive the credential change through the provider's TTL
    // by using a zero TTL so every current() re-reads.
    const provider = new LlmCredentialsProvider({ repo, ttlSeconds: 0 });
    const builtCreds: Array<string> = [];
    const adapter = new AnthropicBedrockSdkAdapter({
      provider,
      sdkFactory: async (creds) => {
        builtCreds.push(creds.apiKey);
        return new RecordedSdk({});
      },
    });

    await adapter.createMessage({ model: "claude-sonnet-4-6", messages: [], maxTokens: 16, role: "primary" });
    // Operator rotates the token; TTL=0 forces a re-read so the adapter sees the new triple.
    repo.set("primary", settings({ apiKey: "sk-v2" }));
    await adapter.createMessage({ model: "claude-sonnet-4-6", messages: [], maxTokens: 16, role: "primary" });

    // Two builds, one per distinct api_key — the rebuild-on-credential-change rule.
    expect(builtCreds).toEqual(["sk-v1", "sk-v2"]);
  });

  it("aclose() closes the cached SDK once and is idempotent / no-op when nothing was built", async () => {
    const repo = new StubRepo();
    repo.set("primary", settings());
    const sdk = new RecordedSdk({});
    const adapter = new AnthropicBedrockSdkAdapter({
      provider: providerFor(repo),
      sdkFactory: async () => sdk,
    });

    // No-op before any build.
    await adapter.aclose();
    expect(sdk.closed).toBe(0);

    await adapter.createMessage({ model: "claude-sonnet-4-6", messages: [], maxTokens: 16, role: "primary" });
    await adapter.aclose();
    expect(sdk.closed).toBe(1);

    // Idempotent: a second aclose() does not re-close (the cached ref was cleared).
    await adapter.aclose();
    expect(sdk.closed).toBe(1);
  });
});

describe("AnthropicBedrockSdkAdapter — exception mapping", () => {
  async function invokeWith(thrown: unknown): Promise<unknown> {
    const repo = new StubRepo();
    repo.set("primary", settings());
    const adapter = new AnthropicBedrockSdkAdapter({
      provider: providerFor(repo),
      sdkFactory: async () => new RecordedSdk({ throwOnCreate: thrown }),
    });
    try {
      await adapter.createMessage({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 16,
        role: "primary",
      });
      return undefined;
    } catch (e) {
      return e;
    }
  }

  it("maps APIConnectionTimeoutError → LlmTimeoutError", async () => {
    expect(await invokeWith(new APIConnectionTimeoutError({ message: "timed out" }))).toBeInstanceOf(
      LlmTimeoutError,
    );
  });

  it("maps RateLimitError → LlmRateLimitError", async () => {
    const rate = new RateLimitError(429, { type: "error" }, "429", new Headers());
    expect(await invokeWith(rate)).toBeInstanceOf(LlmRateLimitError);
  });

  it("maps AuthenticationError (401) and PermissionDeniedError (403) → LlmAuthError", async () => {
    const auth = new AuthenticationError(401, { type: "error" }, "401", new Headers());
    const perm = new PermissionDeniedError(403, { type: "error" }, "403", new Headers());
    expect(await invokeWith(auth)).toBeInstanceOf(LlmAuthError);
    expect(await invokeWith(perm)).toBeInstanceOf(LlmAuthError);
  });

  it("maps APIConnectionError → LlmServerError", async () => {
    expect(await invokeWith(new APIConnectionError({ message: "conn reset" }))).toBeInstanceOf(
      LlmServerError,
    );
  });

  it("maps a 5xx APIError → LlmServerError, a 4xx APIError → generic LlmInvocationError", async () => {
    const server = new APIError(503, { type: "error" }, "503", new Headers());
    expect(await invokeWith(server)).toBeInstanceOf(LlmServerError);

    const client400 = new APIError(400, { type: "error" }, "400", new Headers());
    const mapped = await invokeWith(client400);
    expect(mapped).toBeInstanceOf(LlmInvocationError);
    // A 4xx is NOT a server error — it is the generic base, not the LlmServerError subclass.
    expect(mapped).not.toBeInstanceOf(LlmServerError);
  });

  it("re-throws an already-mapped LlmInvocationError unchanged (does not double-wrap)", async () => {
    const already = new LlmRateLimitError("already mapped");
    const out = await invokeWith(already);
    expect(out).toBe(already);
  });

  it("wraps an unknown thrown value as a generic LlmInvocationError", async () => {
    const out = await invokeWith(new Error("unexpected"));
    expect(out).toBeInstanceOf(LlmInvocationError);
    expect((out as LlmInvocationError).message).toBe("unexpected");
  });
});

describe("hoistSystemMessages + mapAnthropicException (pure helpers)", () => {
  it("hoistSystemMessages returns null system + all messages when there is no system entry", () => {
    const [sys, rest] = hoistSystemMessages([{ role: "user", content: "u" }]);
    expect(sys).toBeNull();
    expect(rest).toEqual([{ role: "user", content: "u" }]);
  });

  it("hoistSystemMessages coerces a non-string system content to a string", () => {
    const [sys] = hoistSystemMessages([{ role: "system", content: 42 }]);
    expect(sys).toBe("42");
  });

  it("mapAnthropicException default-wraps a plain string throw", () => {
    const mapped = mapAnthropicException("boom");
    expect(mapped).toBeInstanceOf(LlmInvocationError);
    expect(mapped.message).toBe("boom");
  });
});
