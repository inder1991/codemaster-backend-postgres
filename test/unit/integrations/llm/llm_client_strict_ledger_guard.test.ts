import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { InMemoryCostCapEnforcer } from "#backend/cost/enforcer.js";
import {
  LedgerRequiredError,
  LlmClient,
  type LlmCallsTelemetryWriter,
  type LlmSdk,
} from "#backend/integrations/llm/client.js";
import type {
  LlmInvocationKeyInputs,
  LlmInvocationLedgerEntry,
  LlmInvocationLedgerPort,
} from "#backend/integrations/llm/invocation_ledger.js";

import { InMemoryBlobStoreAdapter } from "../../../support/llm/cassette_sdk.js";

import type { LlmMessage } from "#contracts/llm_message.v1.js";

// F5 (review remediation) — strict-ledger mode must NEVER be misconfigured into an UNLEDGERED paid call.
//
// The pre-F5 client only forbade a paid call when `args.idempotency === undefined`. That left a GAP: a
// client constructed with `strictLedger:true` but NO `ledger` would, when handed an idempotency CONTEXT,
// compute `idempotencyKey = null` (the key derivation requires `this.ledger !== undefined`) — yet the old
// paid-path check (`strictLedger && idempotency === undefined`) was FALSE because the context was present.
// So the call PROCEEDED and PAID while storing NOTHING (no ledger row), defeating strict mode entirely.
//
// Defense in depth, both layers:
//   (1) CONSTRUCTOR guard — `strictLedger:true` with no `ledger` is a HARD config error at construction,
//       BEFORE any paid path can run.
//   (2) PAID-PATH guard — the paid-edge check keys off `idempotencyKey === null` (not `idempotency ===
//       undefined`), so an un-minted key under strict mode throws LedgerRequiredError BEFORE the SDK call.

const MESSAGES: Array<LlmMessage> = [
  { role: "system", content: "sys" },
  { role: "user", content: "review this chunk" },
];

const REPLAYABLE_RESPONSE: Record<string, unknown> = {
  content: [{ type: "text", text: "I will surface findings." }],
  usage: { input_tokens: 220, output_tokens: 180 },
  stop_reason: "end_turn",
};

const TEST_INSTALLATION_ID = "11111111-2222-3333-4444-555555555555";
const REVIEW_ID = "22222222-3333-4444-5555-666666666666";
const CHUNK_ID = "33333333-4444-5555-6666-777777777777";

const IDEMPOTENCY = { reviewId: REVIEW_ID, chunkId: CHUNK_ID, toolSchemaVersion: "tsv-1" } as const;

/** A recorded-response SDK that COUNTS createMessage invocations (the unreachable-Bedrock stand-in). */
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

/** A telemetry writer that COUNTS recordCall invocations (proves the guard fires before any paid row). */
function countingTelemetry(): { writer: LlmCallsTelemetryWriter; calls: () => number } {
  let n = 0;
  return {
    writer: {
      async recordCall(): Promise<void> {
        n += 1;
      },
    },
    calls: () => n,
  };
}

function newCostCap(): InMemoryCostCapEnforcer {
  return new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 });
}

/** A minimal in-memory ledger (no Postgres) implementing the injection PORT — for the layer-2 probe. */
class InMemoryLedgerProbe implements LlmInvocationLedgerPort {
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
    return this.rows.get(args.key) ?? null;
  }
  public async store(args: { key: string; entry: LlmInvocationLedgerEntry }): Promise<void> {
    if (!this.rows.has(args.key)) this.rows.set(args.key, args.entry.providerResponse);
  }
}

describe("LlmClient — strict-ledger requires a ledger (F5, defense-in-depth)", () => {
  it("(constructor guard) `strictLedger:true` with NO ledger THROWS at construction (fail-fast)", () => {
    // Fail-fast on the misconfiguration BEFORE any paid path can run. Under exactOptionalPropertyTypes the
    // "no ledger" shape is the OMITTED key (passing `ledger: undefined` is itself a type error); the guard
    // reads `this.ledger === undefined`, which the omitted key produces.
    expect(
      () =>
        new LlmClient({
          sdk: countingSdk(REPLAYABLE_RESPONSE).sdk,
          costCap: newCostCap(),
          blobStore: new InMemoryBlobStoreAdapter(),
          clock: new FakeClock(),
          strictLedger: true,
        }),
    ).toThrow(LedgerRequiredError);
  });

  it("(non-strict) `strictLedger:false` (default) with no ledger constructs fine — Temporal-legacy path", () => {
    // Belt-and-suspenders: the guard fires ONLY under strict mode. The default (Temporal-legacy) client with
    // no ledger must still construct, so the legacy pay-un-ledgered path is unaffected.
    expect(
      () =>
        new LlmClient({
          sdk: countingSdk(REPLAYABLE_RESPONSE).sdk,
          costCap: newCostCap(),
          blobStore: new InMemoryBlobStoreAdapter(),
          clock: new FakeClock(),
        }),
    ).not.toThrow();
  });

  it("(F5 defect) a strict client with an idempotency context but NO ledger never reaches a paid SDK call", async () => {
    // The exact F5 gap: strictLedger:true + NO ledger + idempotency PRESENT. Pre-fix, the constructor accepted
    // this AND the paid-path check (keyed on `idempotency === undefined`) was FALSE, so the call PROCEEDED +
    // PAID while storing nothing. Post-fix it throws LedgerRequiredError (at construction, layer 1) and the
    // SDK is NEVER reached. The OBSERVABLE F5 property — no un-ledgered paid SDK call — holds: the counting
    // SDK sees ZERO calls.
    const sdk = countingSdk(REPLAYABLE_RESPONSE);
    const tele = countingTelemetry();
    const costCap = newCostCap();

    const constructAndInvoke = async (): Promise<void> => {
      const client = new LlmClient({
        sdk: sdk.sdk,
        costCap,
        blobStore: new InMemoryBlobStoreAdapter(),
        telemetry: tele.writer,
        clock: new FakeClock(),
        strictLedger: true,
      });
      await client.invokeModel({
        role: "primary",
        model: "claude-sonnet-4-6",
        messages: MESSAGES,
        installationId: TEST_INSTALLATION_ID,
        idempotency: IDEMPOTENCY,
      });
    };

    await expect(constructAndInvoke()).rejects.toBeInstanceOf(LedgerRequiredError);
    // The paid edge was NEVER reached: no SDK call, no telemetry row for a call that never started.
    expect(sdk.calls()).toBe(0);
    expect(tele.calls()).toBe(0);
  });

  it("(paid-path guard, layer 2) strict + ledger present but NO idempotency context throws on the null key", async () => {
    // Independent exercise of layer 2: the paid-path check keys off `idempotencyKey === null`. With a ledger
    // wired but NO idempotency context the key is null, so a paid MISS still throws LedgerRequiredError
    // BEFORE the SDK call — proving the guard does not depend on the (now-impossible) ledger-undefined case.
    const sdk = countingSdk(REPLAYABLE_RESPONSE);
    const client = new LlmClient({
      sdk: sdk.sdk,
      costCap: newCostCap(),
      blobStore: new InMemoryBlobStoreAdapter(),
      clock: new FakeClock(),
      strictLedger: true,
      ledger: new InMemoryLedgerProbe(),
    });
    await expect(
      client.invokeModel({
        role: "primary",
        model: "claude-sonnet-4-6",
        messages: MESSAGES,
        installationId: TEST_INSTALLATION_ID,
      }),
    ).rejects.toBeInstanceOf(LedgerRequiredError);
    expect(sdk.calls()).toBe(0);
  });
});
