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
import type { LangfuseExporterPort } from "#backend/observability/langfuse_exporter.js";

import { InMemoryBlobStoreAdapter } from "../../support/llm/cassette_sdk.js";

import type { LlmMessage } from "#contracts/llm_message.v1.js";

// ADR-0068 "check the idempotency record FIRST" refinement (owner decision verbatim). The DB-gated
// integration test (llm_invocation_ledger.integration.test.ts) proves replay → SDK×0 + telemetry/Langfuse
// re-fire against the REAL Postgres ledger. THIS unit test (always-on tier; no DB) pins the cost-cap
// accounting contract the integration test can't see with its non-counting enforcer: a replay HIT is a
// PURE READ — it does NOT re-run the cost-cap pre-call reservation (checkOrRaise) NOR recordCallCost, so a
// retried chunk does NOT double-count spend in cost_daily. The provider invocation is the only
// non-repeatable, paid edge; the cost was gated + recorded on the FIRST invoke. telemetry + Langfuse DO
// re-fire (replayable observability side effects, per the owner decision).

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

/** A telemetry writer that COUNTS recordCall invocations (proves telemetry re-fires on replay). */
function countingTelemetry(): { writer: LlmCallsTelemetryWriter; calls: () => number } {
  let n = 0;
  return { writer: { async recordCall() { n += 1; } }, calls: () => n };
}

/** A Langfuse exporter that COUNTS exports (proves Langfuse re-fires on replay). */
function countingLangfuse(): { exporter: LangfuseExporterPort; calls: () => number } {
  let n = 0;
  return { exporter: { async export() { n += 1; } }, calls: () => n };
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
    // ON CONFLICT DO NOTHING — first writer wins.
    if (!this.rows.has(args.key)) this.rows.set(args.key, args.entry.providerResponse);
  }
}

const IDEMPOTENCY = { reviewId: REVIEW_ID, chunkId: CHUNK_ID, toolSchemaVersion: "tsv-1" } as const;

function invoke(client: LlmClient) {
  return client.invokeModel({
    role: "primary",
    model: "claude-sonnet-4-6",
    messages: MESSAGES,
    installationId: TEST_INSTALLATION_ID,
    idempotency: IDEMPOTENCY,
  });
}

describe("LlmClient.invokeModel — replay HIT is a pure read (ADR-0068 check-first)", () => {
  it("FIRST invoke runs the cost-cap check + recordCallCost + SDK once", async () => {
    const ledger = new FakeLedger();
    const costCap = new CountingCostCap();
    const sdk = countingSdk(REPLAYABLE_RESPONSE);
    const client = new LlmClient({
      sdk: sdk.sdk,
      costCap,
      blobStore: new InMemoryBlobStoreAdapter(),
      clock: new FakeClock(),
      ledger,
    });
    const r1 = await invoke(client);
    expect(sdk.calls()).toBe(1);
    expect(costCap.checks).toBe(1);
    expect(costCap.records).toBe(1);
    expect(ledger.stores).toBe(1);
    expect(r1.content).toBe("I will surface findings.");
  });

  it("REPLAY HIT skips checkOrRaise + recordCallCost (no cost double-count) but re-fires telemetry + Langfuse", async () => {
    const ledger = new FakeLedger();

    // Pass 1 — populate the shared ledger.
    const first = countingSdk(REPLAYABLE_RESPONSE);
    const client1 = new LlmClient({
      sdk: first.sdk,
      costCap: new CountingCostCap(),
      blobStore: new InMemoryBlobStoreAdapter(),
      clock: new FakeClock(),
      ledger,
    });
    const r1 = await invoke(client1);
    expect(first.calls()).toBe(1);

    // Pass 2 — a FRESH client (simulating a Temporal retry on a fresh worker) over the SAME ledger.
    const second = countingSdk({ content: [{ type: "text", text: "DIFFERENT — must not be used" }] });
    const costCap2 = new CountingCostCap();
    const tele2 = countingTelemetry();
    const lf2 = countingLangfuse();
    const client2 = new LlmClient({
      sdk: second.sdk,
      costCap: costCap2,
      blobStore: new InMemoryBlobStoreAdapter(),
      telemetry: tele2.writer,
      langfuse: lf2.exporter,
      clock: new FakeClock(),
      ledger,
    });
    const r2 = await invoke(client2);

    // The paid SDK call was NOT made on the replay.
    expect(second.calls()).toBe(0);
    // REFINEMENT: the cost-cap was NOT re-gated and the spend was NOT re-recorded (no double-count).
    expect(costCap2.checks).toBe(0);
    expect(costCap2.records).toBe(0);
    // The ledger was probed (the read that drives the replay) but NOT re-stored.
    expect(ledger.lookups).toBeGreaterThanOrEqual(1);
    expect(ledger.stores).toBe(1);
    // telemetry + Langfuse STILL fire on the replay (replayable observability side effects).
    expect(tele2.calls()).toBe(1);
    expect(lf2.calls()).toBe(1);
    // The REPLAYED (stored) response is returned — NOT the second SDK's different content.
    expect(r2.content).toBe("I will surface findings.");
    expect(r2.content).toBe(r1.content);
    expect(r2.prompt_tokens).toBe(r1.prompt_tokens);
    expect(r2.completion_tokens).toBe(r1.completion_tokens);
  });
});
