// W2.2 (prompt caching) — end-to-end pin of the cache-hit telemetry + cache-aware cost accounting in
// LlmClient.invokeModel:
//
//   * the provider usage fields `cache_read_input_tokens` / `cache_creation_input_tokens` are parsed
//     and emitted through the llm_prompt_cache_metrics counters (purpose-labelled, bounded), ONLY for
//     marked requests on the paid (non-replay) path;
//   * cost accounting prices the cached prefix honestly: input_tokens EXCLUDES cached tokens on the
//     Anthropic usage shape, so without the correction a cached chunk call would record ~zero spend in
//     cost_daily — cache reads bill at 0.1x and 5-minute-TTL cache writes at 1.25x the prompt rate.
//
// COUNTER-TIMING GOTCHA (same as chunk_response_parser.counters.test.ts): the metrics module caches
// its Counter instruments at MODULE scope, so the MeterProvider is registered in beforeAll and the
// client + metrics modules are DYNAMICALLY imported afterwards.

import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { InMemoryCostCapEnforcer } from "#backend/cost/enforcer.js";
import type { LlmInvocationLedgerPort } from "#backend/integrations/llm/invocation_ledger.js";

import { InMemoryBlobStoreAdapter } from "../../support/llm/cassette_sdk.js";

import type { LlmMessage } from "#contracts/llm_message.v1.js";

type ClientModule = typeof import("#backend/integrations/llm/client.js");

let exporter: InMemoryMetricExporter;
let provider: MeterProvider;
let clientModule: ClientModule;

beforeAll(async () => {
  exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 2_147_483_647,
  });
  provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  // Dynamic import AFTER provider registration so module-scope counters bind to the real meter.
  clientModule = await import("#backend/integrations/llm/client.js");
});

afterAll(async () => {
  await provider.shutdown();
  metrics.disable();
});

beforeEach(() => {
  exporter.reset();
});

async function flushedPointsFor(name: string): Promise<Array<DataPoint<number>>> {
  await provider.forceFlush();
  const out: Array<DataPoint<number>> = [];
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name === name) {
          out.push(...(m.dataPoints as Array<DataPoint<number>>));
        }
      }
    }
  }
  return out;
}

const TEST_INSTALLATION_ID = "11111111-2222-3333-4444-555555555555";
const MESSAGES: Array<LlmMessage> = [
  { role: "system", content: "sys prompt" },
  { role: "user", content: "stable PR prefix" },
  { role: "user", content: "per-chunk suffix" },
];

/** usage chosen so each cost component is exactly 3.0 cents on claude-sonnet-4-6:
 *  10_000 uncached prompt tokens x 0.0003   = 3.0
 *  100_000 cache-read tokens x 0.0003 x 0.1 = 3.0
 *  8_000 cache-write tokens x 0.0003 x 1.25 = 3.0
 *  2_000 completion tokens x 0.0015         = 3.0   → 12 cents total */
const CACHED_USAGE = {
  input_tokens: 10_000,
  output_tokens: 2_000,
  cache_read_input_tokens: 100_000,
  cache_creation_input_tokens: 8_000,
};

function responseWith(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: "text", text: "No issues identified." }],
    usage,
    stop_reason: "end_turn",
  };
}

function newClient(
  response: Record<string, unknown>,
  ledger?: LlmInvocationLedgerPort,
): InstanceType<ClientModule["LlmClient"]> {
  return new clientModule.LlmClient({
    sdk: {
      async createMessage(): Promise<Record<string, unknown>> {
        return response;
      },
    },
    costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
    blobStore: new InMemoryBlobStoreAdapter(),
    clock: new FakeClock(),
    ...(ledger !== undefined ? { ledger } : {}),
  });
}

const IDEMPOTENCY = {
  reviewId: "11111111-1111-4111-8111-111111111111",
  chunkId: "22222222-2222-4222-8222-222222222222",
  toolSchemaVersion: "rfs-test",
  ledgerPurpose: "bedrock_review_chunk",
};

describe("LlmClient — prompt-cache telemetry + cache-aware cost (W2.2)", () => {
  it("a marked call emits read/creation/uncached token counters + a purpose-labelled hit outcome", async () => {
    const client = newClient(responseWith(CACHED_USAGE));
    await client.invokeModel({
      role: "primary",
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      installationId: TEST_INSTALLATION_ID,
      cachePrefixMessages: 2,
      idempotency: IDEMPOTENCY,
    });

    const read = await flushedPointsFor("codemaster_llm_prompt_cache_read_tokens_total");
    expect(read).toHaveLength(1);
    expect(read[0]!.value).toBe(100_000);
    expect(read[0]!.attributes).toEqual({ purpose: "bedrock_review_chunk" });

    const creation = await flushedPointsFor("codemaster_llm_prompt_cache_creation_tokens_total");
    expect(creation[0]!.value).toBe(8_000);

    const uncached = await flushedPointsFor(
      "codemaster_llm_prompt_cache_uncached_prompt_tokens_total",
    );
    expect(uncached[0]!.value).toBe(10_000);

    const requests = await flushedPointsFor("codemaster_llm_prompt_cache_requests_total");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.value).toBe(1);
    expect(requests[0]!.attributes).toEqual({ purpose: "bedrock_review_chunk", outcome: "hit" });
  });

  it("cost accounting includes cache reads at 0.1x and cache writes at 1.25x the prompt rate", async () => {
    const client = newClient(responseWith(CACHED_USAGE));
    const result = await client.invokeModel({
      role: "primary",
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      installationId: TEST_INSTALLATION_ID,
      cachePrefixMessages: 2,
    });
    expect(result.cost_usd_cents).toBe(12);
    // the contract field prompt_tokens stays the provider's input_tokens (uncached remainder).
    expect(result.prompt_tokens).toBe(10_000);
  });

  it("without cache usage fields the cost is unchanged from the legacy computation", async () => {
    const client = newClient(responseWith({ input_tokens: 10_000, output_tokens: 2_000 }));
    const result = await client.invokeModel({
      role: "primary",
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      installationId: TEST_INSTALLATION_ID,
    });
    expect(result.cost_usd_cents).toBe(6); // 10_000x0.0003 + 2_000x0.0015
  });

  it("an UNMARKED call emits NO cache counters even if the provider returns cache fields", async () => {
    const client = newClient(responseWith(CACHED_USAGE));
    await client.invokeModel({
      role: "primary",
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      installationId: TEST_INSTALLATION_ID,
    });
    expect(await flushedPointsFor("codemaster_llm_prompt_cache_requests_total")).toHaveLength(0);
    expect(await flushedPointsFor("codemaster_llm_prompt_cache_read_tokens_total")).toHaveLength(0);
  });

  it("a ledger replay HIT emits NO cache counters (no provider request was made)", async () => {
    const ledger: LlmInvocationLedgerPort = {
      computeKey: () => "stable-key",
      lookup: async () => responseWith(CACHED_USAGE),
      store: async () => undefined,
    };
    const client = newClient(responseWith(CACHED_USAGE), ledger);
    await client.invokeModel({
      role: "primary",
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      installationId: TEST_INSTALLATION_ID,
      cachePrefixMessages: 2,
      idempotency: IDEMPOTENCY,
    });
    expect(await flushedPointsFor("codemaster_llm_prompt_cache_requests_total")).toHaveLength(0);
  });
});
