import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import {
  InMemoryCostCapEnforcer,
  type CostCapEnforcer,
} from "#backend/cost/enforcer.js";
import { LedgerRequiredError, LlmClient, type LlmSdk } from "#backend/integrations/llm/client.js";
import {
  LEDGER_PURPOSE_NS,
  purposeChunkId,
  type LlmInvocationKeyInputs,
  type LlmInvocationLedgerEntry,
  type LlmInvocationLedgerPort,
} from "#backend/integrations/llm/invocation_ledger.js";
import { uuid5 } from "#platform/randomness.js";

import { InMemoryBlobStoreAdapter } from "../../support/llm/cassette_sdk.js";

import type { LlmMessage } from "#contracts/llm_message.v1.js";

// W2.1 (D2 / F4 / F9) — the PR-level ledger purpose-key surrogate + strict-ledger mode.
//
// E8: PR-level paid LLM calls (walkthrough / curator / rerank / fix_prompt) have no per-chunk UUID to
// key the invocation ledger by, so the chunkId is a DETERMINISTIC uuid5 of (LEDGER_PURPOSE_NS, purpose).
// This keeps `computeKey` unchanged while satisfying D2's "key by purpose + stable input, not just
// review_id" — walkthrough and fix_prompt can never collide nor replay the wrong response.
//
// F4 (strict-ledger mode): the de-Temporal shell constructs its review LlmClient with strictLedger:true,
// so a paid invokeModel (a ledger MISS about to call the SDK) that lacks an idempotency context is a HARD
// ERROR (LedgerRequiredError) — un-ledgered paid Bedrock calls are forbidden in the shell path. The
// Temporal-legacy path keeps the default (strictLedger:false) and pays un-ledgered exactly as before.

const MESSAGES: Array<LlmMessage> = [
  { role: "system", content: "sys" },
  { role: "user", content: "summarize this PR" },
];

const REPLAYABLE_RESPONSE: Record<string, unknown> = {
  content: [{ type: "text", text: "walkthrough body." }],
  usage: { input_tokens: 120, output_tokens: 80 },
  stop_reason: "end_turn",
};

const TEST_INSTALLATION_ID = "11111111-2222-3333-4444-555555555555";
const REVIEW_ID = "22222222-3333-4444-5555-666666666666";

const PURPOSES = ["walkthrough", "curator", "rerank", "fix_prompt"] as const;

/** A recorded-response SDK that COUNTS its createMessage invocations (the unreachable-Bedrock stand-in). */
function countingSdk(response: Record<string, unknown>): { sdk: LlmSdk; calls: () => number } {
  let n = 0;
  return {
    sdk: {
      async createMessage(): Promise<Record<string, unknown>> {
        n += 1;
        return response;
      },
    },
    calls: () => n,
  };
}

/** An in-memory ledger (no Postgres) implementing the injection PORT — keyed by the deterministic key. */
class FakeLedger implements LlmInvocationLedgerPort {
  public lookups = 0;
  public stores = 0;
  private readonly rows = new Map<string, Record<string, unknown>>();
  public computeKey(inputs: LlmInvocationKeyInputs): string {
    return [
      inputs.reviewId,
      inputs.chunkId,
      inputs.role,
      inputs.model,
      inputs.promptSha256,
      inputs.toolSchemaVersion,
    ].join("|");
  }
  public async lookup(args: { key: string; installationId: string }): Promise<Record<string, unknown> | null> {
    this.lookups += 1;
    return this.rows.get(args.key) ?? null;
  }
  public async store(args: { key: string; entry: LlmInvocationLedgerEntry }): Promise<void> {
    this.stores += 1;
    if (!this.rows.has(args.key)) this.rows.set(args.key, args.entry.providerResponse);
  }
}

function newCostCap(): CostCapEnforcer {
  return new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 });
}

describe("purposeChunkId — deterministic uuid5 surrogate per purpose (E8 / D2)", () => {
  it("LEDGER_PURPOSE_NS is a stable uuid4 literal (canonical lowercase hyphenated form)", () => {
    expect(LEDGER_PURPOSE_NS).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("is DETERMINISTIC: the same purpose always maps to the same chunkId across calls", () => {
    for (const purpose of PURPOSES) {
      expect(purposeChunkId(purpose)).toBe(purposeChunkId(purpose));
    }
  });

  it("equals uuid5(LEDGER_PURPOSE_NS, purpose) — the documented derivation", () => {
    for (const purpose of PURPOSES) {
      expect(purposeChunkId(purpose)).toBe(uuid5(LEDGER_PURPOSE_NS, purpose));
    }
  });

  it("is DISTINCT per purpose (no two purposes collide)", () => {
    const ids = PURPOSES.map((p) => purposeChunkId(p));
    expect(new Set(ids).size).toBe(PURPOSES.length);
  });

  it("returns a canonical v5 UUID string", () => {
    for (const purpose of PURPOSES) {
      expect(purposeChunkId(purpose)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});

describe("LlmClient strictLedger mode (F4) — paid calls must be ledgered in the shell path", () => {
  function strictClient(args: { sdk: LlmSdk; ledger?: LlmInvocationLedgerPort }): LlmClient {
    return new LlmClient({
      sdk: args.sdk,
      costCap: newCostCap(),
      blobStore: new InMemoryBlobStoreAdapter(),
      clock: new FakeClock(),
      strictLedger: true,
      // exactOptionalPropertyTypes: omit `ledger` entirely when absent (no explicit `undefined`).
      ...(args.ledger !== undefined ? { ledger: args.ledger } : {}),
    });
  }

  it("THROWS LedgerRequiredError on a paid call with NO idempotency context (strict + ledger present)", async () => {
    const sdk = countingSdk(REPLAYABLE_RESPONSE);
    const client = strictClient({ sdk: sdk.sdk, ledger: new FakeLedger() });
    await expect(
      client.invokeModel({
        role: "primary",
        model: "claude-sonnet-4-6",
        messages: MESSAGES,
        installationId: TEST_INSTALLATION_ID,
      }),
    ).rejects.toBeInstanceOf(LedgerRequiredError);
    // The SDK was NEVER called — the paid edge is fenced BEFORE the wire.
    expect(sdk.calls()).toBe(0);
  });

  it("THROWS AT CONSTRUCTION when no ledger is wired (F5 fail-fast: strict mode requires a ledger)", () => {
    // F5 remediation moved this rejection EARLIER than the paid edge: a `strictLedger:true` client with no
    // ledger is a MISCONFIGURATION rejected at construction — fail-fast — so it can never reach the wire (the
    // pre-F5 behavior deferred the throw to the first paid invokeModel; strictly weaker). The SDK is
    // unreachable because the client is never built.
    const sdk = countingSdk(REPLAYABLE_RESPONSE);
    expect(() => strictClient({ sdk: sdk.sdk })).toThrow(LedgerRequiredError);
    expect(sdk.calls()).toBe(0);
  });

  it("PAYS NORMALLY with an idempotency context, then REPLAYS on the second call (no double-pay)", async () => {
    const ledger = new FakeLedger();
    const idempotency = {
      reviewId: REVIEW_ID,
      chunkId: purposeChunkId("walkthrough"),
      toolSchemaVersion: "wt-tsv-1",
    } as const;

    const first = countingSdk(REPLAYABLE_RESPONSE);
    const client1 = strictClient({ sdk: first.sdk, ledger });
    const r1 = await client1.invokeModel({
      role: "primary",
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      installationId: TEST_INSTALLATION_ID,
      idempotency,
    });
    expect(first.calls()).toBe(1);
    expect(r1.content).toBe("walkthrough body.");

    // A fresh strict client over the SAME ledger — a HIT replays, the SDK is NOT called again.
    const second = countingSdk({ content: [{ type: "text", text: "must not be used" }] });
    const client2 = strictClient({ sdk: second.sdk, ledger });
    const r2 = await client2.invokeModel({
      role: "primary",
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      installationId: TEST_INSTALLATION_ID,
      idempotency,
    });
    expect(second.calls()).toBe(0);
    expect(r2.content).toBe("walkthrough body.");
  });

  it("DEFAULT (non-strict) client pays un-ledgered with no idempotency — Temporal-legacy behavior intact", async () => {
    const sdk = countingSdk(REPLAYABLE_RESPONSE);
    const client = new LlmClient({
      sdk: sdk.sdk,
      costCap: newCostCap(),
      blobStore: new InMemoryBlobStoreAdapter(),
      clock: new FakeClock(),
    });
    const r = await client.invokeModel({
      role: "primary",
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      installationId: TEST_INSTALLATION_ID,
    });
    expect(sdk.calls()).toBe(1);
    expect(r.content).toBe("walkthrough body.");
  });
});
