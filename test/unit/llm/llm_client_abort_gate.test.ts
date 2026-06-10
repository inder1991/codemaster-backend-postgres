import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import {
  InMemoryCostCapEnforcer,
  type CostCapDecision,
  type CostCapEnforcer,
} from "#backend/cost/enforcer.js";
import { LlmClient, type LlmCallsTelemetryWriter, type LlmSdk } from "#backend/integrations/llm/client.js";
import type {
  LlmInvocationKeyInputs,
  LlmInvocationLedgerEntry,
  LlmInvocationLedgerPort,
} from "#backend/integrations/llm/invocation_ledger.js";

import { InMemoryBlobStoreAdapter } from "../../support/llm/cassette_sdk.js";

import type { LlmMessage } from "#contracts/llm_message.v1.js";

// de-Temporal Phase 2 (W4.2, gate ①) — the abort gate before the paid Bedrock call. The enforceable
// guarantee (F7) is "no NEW paid call STARTS after abort": an already-aborted `signal` rejects a ledger
// MISS BEFORE the SDK call AND BEFORE the cost-cap reservation (counting stubs see ZERO of both). A ledger
// HIT is a PURE READ (replay): an aborted signal MAY still replay — the assertion is that replay does NOT
// reach the SDK. When `signal` is passed AND ledgering is on, the in-flight SDK call also RECEIVES the
// signal via the SDK request options (preflight #8: the @anthropic-ai/sdk request options accept
// `signal?: AbortSignal`). Absent `signal` → byte-identical to the pre-W4.2 client (the existing
// llm_client_invoke / llm_client_idempotency suites prove no regression).

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

/** A recorded-response SDK that COUNTS createMessage invocations AND records the last `signal` passed. */
function countingSdk(response: Record<string, unknown>): {
  sdk: LlmSdk;
  calls: () => number;
  lastSignal: () => AbortSignal | undefined;
} {
  let n = 0;
  let seen: AbortSignal | undefined;
  return {
    sdk: {
      async createMessage(args: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
        n += 1;
        seen = args.signal;
        return response;
      },
    },
    calls: () => n,
    lastSignal: () => seen,
  };
}

/** A cost-cap that delegates to a real in-memory enforcer but COUNTS each surface separately. */
class CountingCostCap implements CostCapEnforcer {
  public checks = 0;
  public records = 0;
  private readonly inner = new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 });
  public async checkOrRaise(args: {
    installationId: string;
    estimatedCents: number;
    today: string;
  }): Promise<CostCapDecision> {
    this.checks += 1;
    return this.inner.checkOrRaise(args);
  }
  public async recordCallCost(args: {
    installationId: string;
    costCents: number;
    today: string;
    estimatedCents?: number;
  }): Promise<void> {
    this.records += 1;
    return this.inner.recordCallCost(args);
  }
}

/** A telemetry writer that COUNTS recordCall invocations (proves the gate fires before telemetry too). */
function countingTelemetry(): { writer: LlmCallsTelemetryWriter; calls: () => number } {
  let n = 0;
  return { writer: { async recordCall() { n += 1; } }, calls: () => n };
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

describe("LlmClient.invokeModel — abort gate before the paid call (W4.2, gate ①)", () => {
  it("ledger MISS + already-aborted signal rejects BEFORE the SDK call AND before the cost-cap reservation", async () => {
    const ledger = new FakeLedger();
    const costCap = new CountingCostCap();
    const tele = countingTelemetry();
    const sdk = countingSdk(REPLAYABLE_RESPONSE);
    const client = new LlmClient({
      sdk: sdk.sdk,
      costCap,
      blobStore: new InMemoryBlobStoreAdapter(),
      telemetry: tele.writer,
      clock: new FakeClock(),
      ledger,
    });

    const aborted = AbortSignal.abort();
    await expect(
      client.invokeModel({
        role: "primary",
        model: "claude-sonnet-4-6",
        messages: MESSAGES,
        installationId: TEST_INSTALLATION_ID,
        idempotency: IDEMPOTENCY,
        signal: aborted,
      }),
    ).rejects.toThrow();

    // No NEW paid call started: the SDK was never invoked.
    expect(sdk.calls()).toBe(0);
    // The gate sits BEFORE the cost-cap reservation — checkOrRaise + recordCallCost both untouched.
    expect(costCap.checks).toBe(0);
    expect(costCap.records).toBe(0);
    // Nothing was stored in the ledger (no paid completion to persist).
    expect(ledger.stores).toBe(0);
    // No telemetry row for a call that never started.
    expect(tele.calls()).toBe(0);
  });

  it("ledger MISS abort gate also fires WITHOUT an idempotency context (no-ledger path)", async () => {
    const costCap = new CountingCostCap();
    const sdk = countingSdk(REPLAYABLE_RESPONSE);
    const client = new LlmClient({
      sdk: sdk.sdk,
      costCap,
      blobStore: new InMemoryBlobStoreAdapter(),
      clock: new FakeClock(),
    });

    await expect(
      client.invokeModel({
        role: "primary",
        model: "claude-sonnet-4-6",
        messages: MESSAGES,
        installationId: TEST_INSTALLATION_ID,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(sdk.calls()).toBe(0);
    expect(costCap.checks).toBe(0);
  });

  it("ledger HIT + already-aborted signal STILL replays (replay is a read) and does NOT hit the SDK", async () => {
    const ledger = new FakeLedger();

    // Pass 1 — populate the shared ledger with a LIVE (non-aborted) invoke.
    const first = countingSdk(REPLAYABLE_RESPONSE);
    const client1 = new LlmClient({
      sdk: first.sdk,
      costCap: new CountingCostCap(),
      blobStore: new InMemoryBlobStoreAdapter(),
      clock: new FakeClock(),
      ledger,
    });
    const r1 = await client1.invokeModel({
      role: "primary",
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      installationId: TEST_INSTALLATION_ID,
      idempotency: IDEMPOTENCY,
    });
    expect(first.calls()).toBe(1);

    // Pass 2 — a FRESH client over the SAME ledger, invoked with an ALREADY-ABORTED signal. The HIT is a
    // pure read: replay returns the stored response WITHOUT calling the SDK, so the abort gate (which only
    // guards the paid MISS edge) does not reject it.
    const second = countingSdk({ content: [{ type: "text", text: "DIFFERENT — must not be used" }] });
    const costCap2 = new CountingCostCap();
    const client2 = new LlmClient({
      sdk: second.sdk,
      costCap: costCap2,
      blobStore: new InMemoryBlobStoreAdapter(),
      clock: new FakeClock(),
      ledger,
    });
    const r2 = await client2.invokeModel({
      role: "primary",
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      installationId: TEST_INSTALLATION_ID,
      idempotency: IDEMPOTENCY,
      signal: AbortSignal.abort(),
    });

    // The replay did NOT reach the SDK.
    expect(second.calls()).toBe(0);
    // The replayed (stored) response is returned, not the second SDK's different content.
    expect(r2.content).toBe(r1.content);
    expect(r2.content).toBe("I will surface findings.");
    // A replay HIT never reaches the cost-cap reservation (the spend was gated on the first invoke).
    expect(costCap2.checks).toBe(0);
    expect(costCap2.records).toBe(0);
  });

  it("a LIVE signal is forwarded INTO the SDK request options on a paid MISS (in-flight call receives it)", async () => {
    const sdk = countingSdk(REPLAYABLE_RESPONSE);
    const controller = new AbortController();
    const client = new LlmClient({
      sdk: sdk.sdk,
      costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
      blobStore: new InMemoryBlobStoreAdapter(),
      clock: new FakeClock(),
    });

    await client.invokeModel({
      role: "primary",
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      installationId: TEST_INSTALLATION_ID,
      signal: controller.signal,
    });

    expect(sdk.calls()).toBe(1);
    // The in-flight SDK call RECEIVED the signal (so a cancel after dispatch aborts the on-the-wire call).
    expect(sdk.lastSignal()).toBe(controller.signal);
  });

  it("absent signal → byte-identical: the SDK receives no signal in its request options", async () => {
    const sdk = countingSdk(REPLAYABLE_RESPONSE);
    const client = new LlmClient({
      sdk: sdk.sdk,
      costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
      blobStore: new InMemoryBlobStoreAdapter(),
      clock: new FakeClock(),
    });

    await client.invokeModel({
      role: "primary",
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      installationId: TEST_INSTALLATION_ID,
    });

    expect(sdk.calls()).toBe(1);
    expect(sdk.lastSignal()).toBeUndefined();
  });
});
