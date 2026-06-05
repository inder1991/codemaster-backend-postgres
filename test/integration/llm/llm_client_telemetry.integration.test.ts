import { randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { InMemoryCostCapEnforcer } from "#backend/cost/enforcer.js";
import {
  LlmClient,
  PostgresLlmCallsTelemetryWriter,
  type LlmSdk,
} from "#backend/integrations/llm/client.js";
import { LlmInvocationError } from "#backend/integrations/llm/errors.js";

import { InMemoryBlobStoreAdapter } from "../../support/llm/cassette_sdk.js";

import type { LlmMessage } from "#contracts/llm_message.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// DB-gated integration test for the REAL telemetry.llm_calls write the LlmClient performs via the
// PRODUCTION PostgresLlmCallsTelemetryWriter (de-stub part 2), against a DISPOSABLE Postgres
// (telemetry.llm_calls already migrated). Runs ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb);
// SKIPS otherwise so validate-fast stays green without a DB. NEVER the in-cluster DB.
//
// The SDK stays a recorded-response double (unreachable Bedrock — NO @anthropic-ai/* construction): a
// success invoke writes one llm_calls row (status='ok' with the right columns); the failure path (SDK
// throws) writes status='failed' with zero tokens/cost; a SDK error whose name is 'TimeoutError' writes
// status='timeout'. The cost-cap is the in-memory allow-all (the cassette default) so the row write is
// the only DB side-effect under assertion. Each test owns a UNIQUE installation_id and cleans up.

const FIXED_CLOCK = new FakeClock({ now: new Date("2026-06-01T12:00:00.000Z") });

const MESSAGES: Array<LlmMessage> = [
  { role: "system", content: "sys" },
  { role: "user", content: "review this chunk" },
];

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

/** A recorded-response SDK double returning a fixed dict (the unreachable-Bedrock cassette stand-in). */
function recordedSdk(response: Record<string, unknown>): LlmSdk {
  return {
    async createMessage(): Promise<Record<string, unknown>> {
      return response;
    },
  };
}

/** An SDK double that throws — optionally a named TimeoutError to exercise the timeout status branch. */
function throwingSdk(name: string, message: string): LlmSdk {
  return {
    async createMessage(): Promise<Record<string, unknown>> {
      const err = new Error(message);
      err.name = name;
      throw err;
    },
  };
}

/** Build an LlmClient over the recorded SDK with the REAL telemetry writer + in-memory cost-cap. */
function clientWith(sdk: LlmSdk): LlmClient {
  return new LlmClient({
    sdk,
    costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
    blobStore: new InMemoryBlobStoreAdapter(),
    telemetry: new PostgresLlmCallsTelemetryWriter({ db }),
    clock: FIXED_CLOCK,
  });
}

type CallRow = {
  installation_id: string;
  request_id: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  cost_usd_cents: number | null;
  payload_blob_id: string | null;
  status: string;
};

/** Read every llm_calls row for one installation_id (scope-keyed). */
async function callRows(installationId: string): Promise<Array<CallRow>> {
  const r = await sql<CallRow>`
    SELECT installation_id, request_id, model, prompt_tokens, completion_tokens, latency_ms,
           cost_usd_cents, payload_blob_id, status
      FROM telemetry.llm_calls WHERE installation_id = ${installationId}::uuid
  `.execute(db);
  return r.rows;
}

async function cleanup(installationId: string): Promise<void> {
  await sql`DELETE FROM telemetry.llm_calls WHERE installation_id = ${installationId}::uuid`.execute(
    db,
  );
}

describeDb("LlmClient telemetry.llm_calls write (production writer, disposable PG)", () => {
  it("a successful invoke writes exactly one llm_calls row with status='ok' and the right columns", async () => {
    const installationId = randomUUID();
    const client = clientWith(
      recordedSdk({
        content: [{ type: "text", text: "I will surface findings." }],
        usage: { input_tokens: 220, output_tokens: 180 },
        stop_reason: "end_turn",
      }),
    );
    try {
      const result = await client.invokeModel({
        role: "primary",
        model: "claude-sonnet-4-6",
        messages: MESSAGES,
        installationId,
      });

      const rows = await callRows(installationId);
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row.status).toBe("ok");
      expect(row.installation_id).toBe(installationId);
      // request_id on the row matches the result's request_id (the same minted UUID).
      expect(row.request_id).toBe(result.request_id);
      expect(row.model).toBe("claude-sonnet-4-6");
      expect(row.prompt_tokens).toBe(220);
      expect(row.completion_tokens).toBe(180);
      // latency_ms is a non-negative integer (FakeClock monotonic is fixed → 0).
      expect(Number.isInteger(row.latency_ms)).toBe(true);
      expect(row.latency_ms).toBeGreaterThanOrEqual(0);
      // cost_usd_cents matches the result's computed cents.
      expect(row.cost_usd_cents).toBe(result.cost_usd_cents);
      // payload_blob_id is a placeholder UUID (minted; non-null) — mirrors the frozen Python.
      expect(row.payload_blob_id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await cleanup(installationId);
    }
  });

  it("a blocked (output-unsafe) completion still writes a row, with status='failed'", async () => {
    const installationId = randomUUID();
    // An AWS key in the text trips the OutputSafetyValidator → blocked → status='failed' but the row
    // (and cost accounting) still run because the tokens were spent.
    const client = clientWith(
      recordedSdk({
        content: [{ type: "text", text: "Found AKIAREALKEY12345678X at secrets.py:5." }],
        usage: { input_tokens: 10, output_tokens: 10 },
        stop_reason: "end_turn",
      }),
    );
    try {
      await expect(
        client.invokeModel({
          role: "primary",
          model: "claude-sonnet-4-6",
          messages: MESSAGES,
          installationId,
        }),
      ).rejects.toThrow();

      const rows = await callRows(installationId);
      expect(rows.length).toBe(1);
      expect(rows[0]!.status).toBe("failed");
      // Tokens WERE counted on the blocked path (unlike the SDK-error path).
      expect(rows[0]!.prompt_tokens).toBe(10);
      expect(rows[0]!.completion_tokens).toBe(10);
    } finally {
      await cleanup(installationId);
    }
  });

  it("the SDK-error path writes status='failed' with zero tokens + zero cost", async () => {
    const installationId = randomUUID();
    const client = clientWith(throwingSdk("Error", "connection reset"));
    try {
      await expect(
        client.invokeModel({
          role: "primary",
          model: "claude-sonnet-4-6",
          messages: MESSAGES,
          installationId,
        }),
      ).rejects.toBeInstanceOf(LlmInvocationError);

      const rows = await callRows(installationId);
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row.status).toBe("failed");
      expect(row.prompt_tokens).toBe(0);
      expect(row.completion_tokens).toBe(0);
      // cost_usd_cents is the literal 0 the failure-row write binds.
      expect(row.cost_usd_cents).toBe(0);
    } finally {
      await cleanup(installationId);
    }
  });

  it("a TimeoutError from the SDK writes status='timeout'", async () => {
    const installationId = randomUUID();
    const client = clientWith(throwingSdk("TimeoutError", "bedrock read timed out"));
    try {
      await expect(
        client.invokeModel({
          role: "primary",
          model: "claude-sonnet-4-6",
          messages: MESSAGES,
          installationId,
        }),
      ).rejects.toBeInstanceOf(LlmInvocationError);

      const rows = await callRows(installationId);
      expect(rows.length).toBe(1);
      expect(rows[0]!.status).toBe("timeout");
      expect(rows[0]!.prompt_tokens).toBe(0);
      expect(rows[0]!.completion_tokens).toBe(0);
    } finally {
      await cleanup(installationId);
    }
  });
});
