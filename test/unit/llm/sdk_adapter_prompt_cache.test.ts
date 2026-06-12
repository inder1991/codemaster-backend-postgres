// W2.2 (prompt caching) — unit coverage of the cache_control marker placement in the SDK adapters.
//
// The Anthropic Messages API caches PREFIXES at explicit `cache_control: {type: "ephemeral"}`
// breakpoints, rendered tools → system → messages (Bedrock serves the SAME API shape, so the marker
// is identical for both adapters). Given `cachePrefixMessages = n` (the count of leading messages
// forming the byte-stable prefix), the adapter must:
//
//   * convert the hoisted `system` kwarg from a plain string to ONE text block carrying
//     cache_control — this breakpoint caches tools + system (cross-PR reuse);
//   * convert the LAST stable user message's content to a text block carrying cache_control — this
//     breakpoint caches tools + system + the PR-stable prefix (the per-chunk fan-out reuse);
//   * leave every variable-tail message EXACTLY as before (plain string content);
//   * with NO cachePrefixMessages → the legacy wire shape byte-for-byte (system as a plain string,
//     all message contents plain strings, no cache_control anywhere).

import { describe, expect, it } from "vitest";

import {
  AnthropicBedrockSdkAdapter,
  buildAnthropicMessageParams,
  type BedrockCreateParams,
  type BedrockSdk,
} from "#backend/integrations/llm/bedrock_sdk_adapter.js";
import { AnthropicDirectSdkAdapter } from "#backend/integrations/llm/anthropic_direct_sdk_adapter.js";
import type {
  LlmCredentials,
  LlmCredentialsProvider,
} from "#backend/integrations/llm/credentials_provider.js";

const EPHEMERAL = { type: "ephemeral" };

const MESSAGES: Array<Record<string, unknown>> = [
  { role: "system", content: "sys prompt" },
  { role: "user", content: "stable PR prefix" },
  { role: "user", content: "per-chunk suffix" },
];

// ── the shared transform ─────────────────────────────────────────────────────────────────────────

describe("buildAnthropicMessageParams — cache_control placement (W2.2)", () => {
  it("marks the system block AND the last stable user block; the variable tail stays plain", () => {
    const { system, messages } = buildAnthropicMessageParams({
      messages: MESSAGES,
      cachePrefixMessages: 2,
    });
    expect(system).toEqual([{ type: "text", text: "sys prompt", cache_control: EPHEMERAL }]);
    expect(messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "stable PR prefix", cache_control: EPHEMERAL }],
      },
      { role: "user", content: "per-chunk suffix" },
    ]);
  });

  it("prefix covering ONLY the system message marks just the system block", () => {
    const { system, messages } = buildAnthropicMessageParams({
      messages: [
        { role: "system", content: "sys prompt" },
        { role: "user", content: "per-chunk suffix" },
      ],
      cachePrefixMessages: 1,
    });
    expect(system).toEqual([{ type: "text", text: "sys prompt", cache_control: EPHEMERAL }]);
    expect(messages).toEqual([{ role: "user", content: "per-chunk suffix" }]);
  });

  it("prefix with no system message marks only the last stable user block", () => {
    const { system, messages } = buildAnthropicMessageParams({
      messages: [
        { role: "user", content: "stable PR prefix" },
        { role: "user", content: "per-chunk suffix" },
      ],
      cachePrefixMessages: 1,
    });
    expect(system).toBeNull();
    expect(messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "stable PR prefix", cache_control: EPHEMERAL }],
      },
      { role: "user", content: "per-chunk suffix" },
    ]);
  });

  it("absent → byte-identical legacy hoist (string system, plain contents, zero cache_control)", () => {
    const { system, messages } = buildAnthropicMessageParams({ messages: MESSAGES });
    expect(system).toBe("sys prompt");
    expect(messages).toEqual([
      { role: "user", content: "stable PR prefix" },
      { role: "user", content: "per-chunk suffix" },
    ]);
    expect(JSON.stringify({ system, messages })).not.toContain("cache_control");
  });

  it("a system message OUTSIDE the prefix leaves the system kwarg unmarked (never cache variable bytes)", () => {
    const { system, messages } = buildAnthropicMessageParams({
      messages: [
        { role: "user", content: "stable PR prefix" },
        { role: "system", content: "late operator note" },
        { role: "user", content: "per-chunk suffix" },
      ],
      cachePrefixMessages: 1,
    });
    // the hoisted system string contains variable-region bytes → no marker on it.
    expect(system).toBe("late operator note");
    expect(messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "stable PR prefix", cache_control: EPHEMERAL }],
    });
  });
});

// ── both adapters thread the boundary into the wire params ──────────────────────────────────────

/** A recorded-response SDK double capturing the params each create call received. */
class RecordedSdk {
  public readonly calls: Array<BedrockCreateParams> = [];
  public readonly messages = {
    create: async (params: BedrockCreateParams): Promise<Record<string, unknown>> => {
      this.calls.push(params);
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

const CREDS: LlmCredentials = { apiKey: "k", region: "us-east-1", modelId: "m" };
const PROVIDER: LlmCredentialsProvider = {
  current: async () => CREDS,
} as unknown as LlmCredentialsProvider;

describe("SDK adapters — cachePrefixMessages → cache_control in the wire params (W2.2)", () => {
  it.each([
    ["bedrock", (sdk: RecordedSdk) =>
      new AnthropicBedrockSdkAdapter({
        provider: PROVIDER,
        sdkFactory: async () => sdk as unknown as BedrockSdk,
      })],
    ["anthropic_direct", (sdk: RecordedSdk) =>
      new AnthropicDirectSdkAdapter({
        provider: PROVIDER,
        sdkFactory: async () => sdk as unknown as BedrockSdk,
      })],
  ] as const)("%s adapter places the marker at the stable/variable boundary", async (_name, make) => {
    const sdk = new RecordedSdk();
    const adapter = make(sdk);
    await adapter.createMessage({
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      maxTokens: 2048,
      tools: [{ name: "report_finding" }],
      role: "primary",
      cachePrefixMessages: 2,
    });
    expect(sdk.calls).toHaveLength(1);
    const params = sdk.calls[0]!;
    expect(params.system).toEqual([
      { type: "text", text: "sys prompt", cache_control: EPHEMERAL },
    ]);
    expect(params.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "stable PR prefix", cache_control: EPHEMERAL }],
      },
      { role: "user", content: "per-chunk suffix" },
    ]);
    expect(params.tools).toEqual([{ name: "report_finding" }]);
  });

  it.each([
    ["bedrock", (sdk: RecordedSdk) =>
      new AnthropicBedrockSdkAdapter({
        provider: PROVIDER,
        sdkFactory: async () => sdk as unknown as BedrockSdk,
      })],
    ["anthropic_direct", (sdk: RecordedSdk) =>
      new AnthropicDirectSdkAdapter({
        provider: PROVIDER,
        sdkFactory: async () => sdk as unknown as BedrockSdk,
      })],
  ] as const)("%s adapter without the boundary keeps the legacy wire shape", async (_name, make) => {
    const sdk = new RecordedSdk();
    const adapter = make(sdk);
    await adapter.createMessage({
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      maxTokens: 2048,
      tools: null,
      role: "primary",
    });
    expect(sdk.calls).toHaveLength(1);
    const params = sdk.calls[0]!;
    expect(params.system).toBe("sys prompt");
    expect(params.messages).toEqual([
      { role: "user", content: "stable PR prefix" },
      { role: "user", content: "per-chunk suffix" },
    ]);
    expect(JSON.stringify(params)).not.toContain("cache_control");
  });
});
