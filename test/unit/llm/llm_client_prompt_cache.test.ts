// W2.2 (prompt caching) — unit coverage of the cachePrefixMessages plumbing through
// LlmClient.invokeModel → LlmSdk.createMessage:
//
//   * present → forwarded VERBATIM to the SDK on the paid edge (the adapter places the
//     cache_control:{type:"ephemeral"} marker at that boundary);
//   * absent  → the SDK arg carries NO cachePrefixMessages key at all (byte-identical legacy call);
//   * validated fail-fast: it must be an integer with 1 <= n < messages.length — a boundary that
//     covers the whole prompt (or nothing) is a wiring bug, not a cacheable request;
//   * a ledger replay HIT never reaches the SDK, so nothing is forwarded (pure read).

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { InMemoryCostCapEnforcer } from "#backend/cost/enforcer.js";
import { LlmClient, type LlmSdk } from "#backend/integrations/llm/client.js";
import type { LlmInvocationLedgerPort } from "#backend/integrations/llm/invocation_ledger.js";

import { InMemoryBlobStoreAdapter } from "../../support/llm/cassette_sdk.js";

import type { LlmMessage } from "#contracts/llm_message.v1.js";

const TEST_INSTALLATION_ID = "11111111-2222-3333-4444-555555555555";

const RESPONSE: Record<string, unknown> = {
  content: [{ type: "text", text: "No issues identified." }],
  usage: { input_tokens: 80, output_tokens: 12 },
  stop_reason: "end_turn",
};

/** A capturing SDK double: records every createMessage arg object verbatim. */
class CapturingSdk implements LlmSdk {
  public readonly calls: Array<Record<string, unknown>> = [];
  public async createMessage(args: {
    model: string;
    messages: Array<Record<string, unknown>>;
    maxTokens: number;
    tools: Array<Record<string, unknown>> | null;
    role: "primary" | "secondary";
    cachePrefixMessages?: number;
  }): Promise<Record<string, unknown>> {
    this.calls.push(args as unknown as Record<string, unknown>);
    return RESPONSE;
  }
}

function newClient(sdk: LlmSdk, ledger?: LlmInvocationLedgerPort): LlmClient {
  return new LlmClient({
    sdk,
    costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
    blobStore: new InMemoryBlobStoreAdapter(),
    clock: new FakeClock(),
    ...(ledger !== undefined ? { ledger } : {}),
  });
}

const MESSAGES: Array<LlmMessage> = [
  { role: "system", content: "sys prompt" },
  { role: "user", content: "stable PR prefix" },
  { role: "user", content: "per-chunk suffix" },
];

describe("LlmClient.invokeModel — cachePrefixMessages plumbing (W2.2)", () => {
  it("forwards cachePrefixMessages verbatim to the SDK", async () => {
    const sdk = new CapturingSdk();
    await newClient(sdk).invokeModel({
      role: "primary",
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      installationId: TEST_INSTALLATION_ID,
      cachePrefixMessages: 2,
    });
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0]!["cachePrefixMessages"]).toBe(2);
  });

  it("absent → the SDK arg carries NO cachePrefixMessages key (byte-identical legacy call)", async () => {
    const sdk = new CapturingSdk();
    await newClient(sdk).invokeModel({
      role: "primary",
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      installationId: TEST_INSTALLATION_ID,
    });
    expect(sdk.calls).toHaveLength(1);
    expect("cachePrefixMessages" in sdk.calls[0]!).toBe(false);
  });

  it.each([
    [0, "0 caches nothing"],
    [3, "the whole prompt has no variable tail"],
    [4, "beyond the message list"],
    [1.5, "non-integer"],
    [-1, "negative"],
  ])("rejects cachePrefixMessages=%s fail-fast BEFORE any SDK call", async (bad) => {
    const sdk = new CapturingSdk();
    await expect(
      newClient(sdk).invokeModel({
        role: "primary",
        model: "claude-sonnet-4-6",
        messages: MESSAGES,
        installationId: TEST_INSTALLATION_ID,
        cachePrefixMessages: bad as number,
      }),
    ).rejects.toThrow(TypeError);
    expect(sdk.calls).toHaveLength(0);
  });

  it("a ledger replay HIT never reaches the SDK (nothing to forward — pure read)", async () => {
    const sdk = new CapturingSdk();
    const ledger: LlmInvocationLedgerPort = {
      computeKey: () => "stable-key",
      lookup: async () => RESPONSE,
      store: async () => undefined,
    };
    const result = await newClient(sdk, ledger).invokeModel({
      role: "primary",
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      installationId: TEST_INSTALLATION_ID,
      cachePrefixMessages: 2,
      idempotency: {
        reviewId: "11111111-1111-4111-8111-111111111111",
        chunkId: "22222222-2222-4222-8222-222222222222",
        toolSchemaVersion: "rfs-test",
        ledgerPurpose: "bedrock_review_chunk",
      },
    });
    expect(result.content).toBe("No issues identified.");
    expect(sdk.calls).toHaveLength(0);
  });
});
