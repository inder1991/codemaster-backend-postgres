import { randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { InMemoryCostCapEnforcer } from "#backend/cost/enforcer.js";
import { LlmClient, type LlmCallsTelemetryWriter, type LlmSdk } from "#backend/integrations/llm/client.js";
import { LlmInvocationLedger } from "#backend/integrations/llm/invocation_ledger.js";
import type { LangfuseExporterPort } from "#backend/observability/langfuse_exporter.js";

import { InMemoryBlobStoreAdapter } from "../../support/llm/cassette_sdk.js";

import type { LlmMessage } from "#contracts/llm_message.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// DB-gated integration test for the NARROW LLM-invocation idempotency ledger (ADR-0068) against a
// DISPOSABLE Postgres (core.llm_invocation_ledger migrated by 0003). Runs ONLY when CODEMASTER_PG_CORE_DSN
// is set (via describeDb); SKIPS otherwise so validate-fast stays green without a DB. NEVER the in-cluster
// DB. Each test owns a UNIQUE installation_id + ids and cleans up; SERIAL (--no-file-parallelism).
//
// What is proven:
//   1. FIRST invoke with an idempotency context → the SDK is called once, a ledger row is written, and
//      the structured result is returned.
//   2. SECOND invoke with the SAME inputs (→ same key) → the SDK is NOT called again (the spy asserts
//      zero ADDITIONAL calls), the stored provider response is REPLAYED, the SAME structured result is
//      returned, and telemetry + Langfuse STILL fire on the replay (replayable side effects).
//   3. A no-idempotency invoke → unchanged: the SDK is called and NO ledger row is written.

const FIXED_CLOCK = new FakeClock({ now: new Date("2026-06-01T12:00:00.000Z") });

const MESSAGES: Array<LlmMessage> = [
  { role: "system", content: "sys" },
  { role: "user", content: "review this chunk" },
];

const REPLAYABLE_RESPONSE: Record<string, unknown> = {
  content: [{ type: "text", text: "I will surface findings." }],
  usage: { input_tokens: 220, output_tokens: 180 },
  stop_reason: "end_turn",
};

let pool: Pool;
let db: Kysely<unknown>;

beforeAll(() => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
});

afterAll(async () => {
  await db?.destroy();
});

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
  return {
    writer: {
      async recordCall(): Promise<void> {
        n += 1;
      },
    },
    calls: () => n,
  };
}

/** A Langfuse exporter that COUNTS exports (proves Langfuse re-fires on replay). */
function countingLangfuse(): { exporter: LangfuseExporterPort; calls: () => number } {
  let n = 0;
  return {
    exporter: {
      async export(): Promise<void> {
        n += 1;
      },
    },
    calls: () => n,
  };
}

type LedgerRow = {
  idempotency_key: string;
  installation_id: string;
  review_id: string;
  chunk_id: string;
  role: string;
  model: string;
  prompt_sha256: string;
  tool_schema_version: string;
};

/** Read every ledger row for one installation_id (scope-keyed). */
async function ledgerRows(installationId: string): Promise<Array<LedgerRow>> {
  const r = await sql<LedgerRow>`
    SELECT idempotency_key, installation_id, review_id, chunk_id, role, model,
           prompt_sha256, tool_schema_version
      FROM core.llm_invocation_ledger WHERE installation_id = ${installationId}::uuid
  `.execute(db);
  return r.rows;
}

async function cleanup(installationId: string): Promise<void> {
  await sql`DELETE FROM core.llm_invocation_ledger WHERE installation_id = ${installationId}::uuid`.execute(
    db,
  );
}

describeDb("LlmInvocationLedger — replay skips the paid SDK call (disposable PG)", () => {
  it("FIRST invoke calls the SDK once + writes a ledger row + returns the result", async () => {
    const installationId = randomUUID();
    const reviewId = randomUUID();
    const chunkId = randomUUID();
    const { sdk, calls } = countingSdk(REPLAYABLE_RESPONSE);
    const client = new LlmClient({
      sdk,
      costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
      blobStore: new InMemoryBlobStoreAdapter(),
      clock: FIXED_CLOCK,
      ledger: new LlmInvocationLedger({ db }),
    });
    try {
      const result = await client.invokeModel({
        role: "primary",
        model: "claude-sonnet-4-6",
        messages: MESSAGES,
        installationId,
        idempotency: { reviewId, chunkId, toolSchemaVersion: "tsv-1" },
      });

      // The SDK was called exactly once (the paid edge).
      expect(calls()).toBe(1);
      // The structured result came back.
      expect(result.content).toBe("I will surface findings.");
      expect(result.prompt_tokens).toBe(220);
      expect(result.completion_tokens).toBe(180);

      // Exactly one ledger row, with the recorded deterministic-input projection.
      const rows = await ledgerRows(installationId);
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row.installation_id).toBe(installationId);
      expect(row.review_id).toBe(reviewId);
      expect(row.chunk_id).toBe(chunkId);
      expect(row.role).toBe("primary");
      expect(row.model).toBe("claude-sonnet-4-6");
      expect(row.tool_schema_version).toBe("tsv-1");
      expect(row.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
      // The PK is the sha256 hex computeKey returns for the SAME inputs.
      expect(row.idempotency_key).toBe(
        new LlmInvocationLedger({ db }).computeKey({
          reviewId,
          chunkId,
          role: "primary",
          model: "claude-sonnet-4-6",
          promptSha256: row.prompt_sha256,
          toolSchemaVersion: "tsv-1",
        }),
      );
    } finally {
      await cleanup(installationId);
    }
  });

  it("SECOND invoke with the SAME key replays the stored response WITHOUT calling the SDK again; telemetry + Langfuse still fire", async () => {
    const installationId = randomUUID();
    const reviewId = randomUUID();
    const chunkId = randomUUID();
    const ledger = new LlmInvocationLedger({ db });

    // Pass 1 — populate the ledger.
    const first = countingSdk(REPLAYABLE_RESPONSE);
    const firstTelemetry = countingTelemetry();
    const firstLangfuse = countingLangfuse();
    const client1 = new LlmClient({
      sdk: first.sdk,
      costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
      blobStore: new InMemoryBlobStoreAdapter(),
      telemetry: firstTelemetry.writer,
      langfuse: firstLangfuse.exporter,
      clock: FIXED_CLOCK,
      ledger,
    });
    try {
      const r1 = await client1.invokeModel({
        role: "primary",
        model: "claude-sonnet-4-6",
        messages: MESSAGES,
        installationId,
        idempotency: { reviewId, chunkId, toolSchemaVersion: "tsv-1" },
      });
      expect(first.calls()).toBe(1);
      expect(firstTelemetry.calls()).toBe(1);
      expect(firstLangfuse.calls()).toBe(1);
      expect((await ledgerRows(installationId)).length).toBe(1);

      // Pass 2 — a SEPARATE client (simulating a Temporal retry on a fresh worker) with a FRESH SDK spy.
      // The stored response must be replayed; the SDK must NOT be invoked.
      const second = countingSdk({ content: [{ type: "text", text: "DIFFERENT — must not be used" }] });
      const secondTelemetry = countingTelemetry();
      const secondLangfuse = countingLangfuse();
      const client2 = new LlmClient({
        sdk: second.sdk,
        costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
        blobStore: new InMemoryBlobStoreAdapter(),
        telemetry: secondTelemetry.writer,
        langfuse: secondLangfuse.exporter,
        clock: FIXED_CLOCK,
        ledger,
      });
      const r2 = await client2.invokeModel({
        role: "primary",
        model: "claude-sonnet-4-6",
        messages: MESSAGES,
        installationId,
        idempotency: { reviewId, chunkId, toolSchemaVersion: "tsv-1" },
      });

      // The paid SDK was NOT called on the replay (zero ADDITIONAL calls).
      expect(second.calls()).toBe(0);
      // The REPLAYED response was used (the stored one), not the second SDK's different content.
      expect(r2.content).toBe("I will surface findings.");
      expect(r2.content).toBe(r1.content);
      expect(r2.prompt_tokens).toBe(r1.prompt_tokens);
      expect(r2.completion_tokens).toBe(r1.completion_tokens);
      // Telemetry + Langfuse STILL fired on the replay (replayable side effects against the stored result).
      expect(secondTelemetry.calls()).toBe(1);
      expect(secondLangfuse.calls()).toBe(1);
      // Still exactly ONE ledger row (the replay does not insert a duplicate).
      expect((await ledgerRows(installationId)).length).toBe(1);
    } finally {
      await cleanup(installationId);
    }
  });

  it("a no-idempotency invoke is unchanged — the SDK is called and NO ledger row is written", async () => {
    const installationId = randomUUID();
    const { sdk, calls } = countingSdk(REPLAYABLE_RESPONSE);
    // Ledger IS wired, but NO idempotency context is passed → back-compat (invoke, no ledger).
    const client = new LlmClient({
      sdk,
      costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
      blobStore: new InMemoryBlobStoreAdapter(),
      clock: FIXED_CLOCK,
      ledger: new LlmInvocationLedger({ db }),
    });
    try {
      const result = await client.invokeModel({
        role: "primary",
        model: "claude-sonnet-4-6",
        messages: MESSAGES,
        installationId,
        // no idempotency context
      });
      expect(calls()).toBe(1);
      expect(result.content).toBe("I will surface findings.");
      // No ledger row written for this installation.
      expect((await ledgerRows(installationId)).length).toBe(0);
    } finally {
      await cleanup(installationId);
    }
  });
});
