import { randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { AnalysisCurator, CURATE_TOOL_SCHEMA_VERSION } from "#backend/analysis/curator.js";
import { InMemoryCostCapEnforcer } from "#backend/cost/enforcer.js";
import { LlmClient, type LlmCallsTelemetryWriter, type LlmSdk } from "#backend/integrations/llm/client.js";
import {
  LlmInvocationLedger,
  purposeChunkId,
} from "#backend/integrations/llm/invocation_ledger.js";
import type { LangfuseExporterPort } from "#backend/observability/langfuse_exporter.js";
import {
  LlmBackedRerankPort,
  RERANK_TOOL_SCHEMA_VERSION,
} from "#backend/retrieval/llm_backed_rerank.js";
import {
  FIX_PROMPT_THEME_TOOL_NAME,
  FIX_PROMPT_THEME_TOOL_SCHEMA_VERSION,
  buildFixPrompt,
} from "#backend/review/fix_prompt/fix_prompt_theme_activity.js";
import {
  WALKTHROUGH_TOOL_SCHEMA_VERSION,
  doGenerateWalkthrough,
} from "#backend/review/walkthrough_activity.js";

import { InMemoryBlobStoreAdapter } from "../../support/llm/cassette_sdk.js";

import type { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import { AggregatedFindingsV1 as AggregatedFindingsV1Schema } from "#contracts/aggregated_findings.v1.js";
import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import { AnalysisFindingV1 as AnalysisFindingV1Schema } from "#contracts/analysis_findings.v1.js";
import type { KnowledgeChunkV1 } from "#contracts/knowledge_chunks.v1.js";
import type { LlmMessage } from "#contracts/llm_message.v1.js";
import { PrMetaV1 } from "#contracts/walkthrough.v1.js";
import type { PrMetaV1 as PrMetaV1Type } from "#contracts/walkthrough.v1.js";

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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// W2.2 (D2 / F9) — the FOUR PR-level paid call sites (walkthrough / curator / rerank / fix-prompt) are
// ledgered by purpose. Each site is driven TWICE against a counting SDK stub + the REAL ledger; the
// paid SDK call count is 1 across both runs (the second is a HIT replay), the ledger row's chunk_id is
// `purposeChunkId(<purpose>)` (F9: the SAME token drives the metric purpose label), and a CHANGED prompt
// produces a MISS + a second row (invalidation direction pinned). `run_id` is deliberately NOT in the
// key (D2: output need not change per run). The cache returns a REAL LlmClient wired with the counting
// SDK + the real ledger — the production replay seam, exercised end-to-end against disposable PG.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A cache whose forRole always returns the given (real, counting-SDK + real-ledger) client. */
function cacheReturningClient(client: LlmClient): {
  forRole(role: string): Promise<LlmClient>;
} {
  return {
    async forRole(): Promise<LlmClient> {
      return client;
    },
  };
}

/** Build a real LlmClient wired with the counting SDK + the real ledger over the shared pool. */
function ledgeredClient(sdk: LlmSdk): LlmClient {
  return new LlmClient({
    sdk,
    costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
    blobStore: new InMemoryBlobStoreAdapter(),
    clock: FIXED_CLOCK,
    ledger: new LlmInvocationLedger({ db }),
  });
}

function walkthroughPrMeta(installationId: string, prId: string): PrMetaV1Type {
  return PrMetaV1.parse({
    pr_id: prId,
    installation_id: installationId,
    repo: "acme/widget",
    pr_title: "Add a feature",
    pr_description: "## Summary\n\nDoes a thing.",
  });
}

function aggregatedFindings(
  findings: ReadonlyArray<Record<string, unknown>> = [],
): AggregatedFindingsV1 {
  return AggregatedFindingsV1Schema.parse({
    findings,
    dedupe_stats: {
      input_count: findings.length,
      exact_dropped: 0,
      semantic_merged: 0,
      capped: 0,
      semantic_skipped: false,
    },
    policy_revision: 0,
  });
}

function aggFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file: "src/app.ts",
    start_line: 10,
    end_line: 12,
    severity: "issue",
    category: "bug",
    title: "A finding",
    body: "Body text describing the issue.",
    confidence: 0.8,
    ...overrides,
  };
}

let analysisFindingSeq = 0;
function analysisFinding(overrides: Record<string, unknown> = {}): AnalysisFindingV1 {
  analysisFindingSeq += 1;
  const hex = analysisFindingSeq.toString(16).padStart(12, "0");
  return AnalysisFindingV1Schema.parse({
    finding_id: `00000000-0000-4000-8000-${hex}`,
    tool: "eslint",
    rule_id: "no-unused-vars",
    file: "src/app.ts",
    start_line: 10,
    end_line: 12,
    severity_raw: "warning",
    message: "Unused variable.",
    ...overrides,
  });
}

function knowledgeChunk(id: string, body: string): KnowledgeChunkV1 {
  return {
    schema_version: 2,
    chunk_id: id,
    installation_id: "11111111-1111-1111-1111-111111111111",
    repo_id: "22222222-2222-2222-2222-222222222222",
    relative_path: `docs/${id}.md`,
    chunk_index: 0,
    heading_path: [],
    body,
    doc_kind: "other",
    doc_status: "active",
    source: "repo_knowledge",
    space_key: null,
    page_id: null,
    page_version: null,
    labels: [],
    match_specificity_score: 0,
    age_days: 0,
  };
}

/** Read the single ledger row for one purpose chunk_id (scope-keyed) — proves purposeChunkId keying. */
async function ledgerRowsForChunk(installationId: string, chunkId: string): Promise<Array<LedgerRow>> {
  const r = await sql<LedgerRow>`
    SELECT idempotency_key, installation_id, review_id, chunk_id, role, model,
           prompt_sha256, tool_schema_version
      FROM core.llm_invocation_ledger
     WHERE installation_id = ${installationId}::uuid AND chunk_id = ${chunkId}::uuid
  `.execute(db);
  return r.rows;
}

describeDb("W2.2 — walkthrough paid call ledgered by purpose (disposable PG)", () => {
  it("replays across two runs (paid SDK count 1), keys chunk_id=purposeChunkId('walkthrough'), CHANGED prompt → MISS + 2nd row", async () => {
    const installationId = randomUUID();
    const prId = randomUUID();
    let sdkCalls = 0;
    const sdk: LlmSdk = {
      async createMessage(): Promise<Record<string, unknown>> {
        sdkCalls += 1;
        return {
          content: [{ type: "tool_use", id: "w1", name: "emit_walkthrough", input: { tldr: "OK." } }],
          usage: { input_tokens: 80, output_tokens: 40 },
          stop_reason: "tool_use",
        };
      },
    };
    const cache = cacheReturningClient(ledgeredClient(sdk));
    try {
      // Run 1 — MISS → paid SDK call + a stored row.
      const r1 = await doGenerateWalkthrough(
        {
          prMeta: walkthroughPrMeta(installationId, prId),
          aggregated: aggregatedFindings([aggFinding()]),
          linkedIssues: [],
          suggestedReviewers: [],
        },
        { cache },
      );
      expect(r1.tldr).toBe("OK.");
      expect(sdkCalls).toBe(1);

      // Run 2 — identical inputs → HIT replay, the paid SDK is NOT called again.
      await doGenerateWalkthrough(
        {
          prMeta: walkthroughPrMeta(installationId, prId),
          aggregated: aggregatedFindings([aggFinding()]),
          linkedIssues: [],
          suggestedReviewers: [],
        },
        { cache },
      );
      expect(sdkCalls).toBe(1); // still 1 — the HIT replayed.

      const chunkId = purposeChunkId("walkthrough");
      const rows = await ledgerRowsForChunk(installationId, chunkId);
      expect(rows.length).toBe(1);
      expect(rows[0]!.chunk_id).toBe(chunkId);
      expect(rows[0]!.review_id).toBe(prId);
      expect(rows[0]!.tool_schema_version).toBe(WALKTHROUGH_TOOL_SCHEMA_VERSION);

      // CHANGED prompt (different aggregated findings → different user message) → MISS + a SECOND row.
      await doGenerateWalkthrough(
        {
          prMeta: walkthroughPrMeta(installationId, prId),
          aggregated: aggregatedFindings([aggFinding({ title: "A DIFFERENT finding" })]),
          linkedIssues: [],
          suggestedReviewers: [],
        },
        { cache },
      );
      expect(sdkCalls).toBe(2); // a new paid call for the changed prompt.
      expect((await ledgerRowsForChunk(installationId, chunkId)).length).toBe(2);
    } finally {
      await cleanup(installationId);
    }
  });
});

describeDb("W2.2 — curator paid call ledgered by purpose (disposable PG)", () => {
  it("replays across two runs (paid SDK count 1), keys chunk_id=purposeChunkId('curator'), CHANGED prompt → MISS + 2nd row", async () => {
    const installationId = randomUUID();
    const prId = randomUUID();
    let sdkCalls = 0;
    const sdk: LlmSdk = {
      async createMessage(): Promise<Record<string, unknown>> {
        sdkCalls += 1;
        return {
          content: [],
          usage: { input_tokens: 50, output_tokens: 30 },
          stop_reason: "tool_use",
        };
      },
    };
    const curator = new AnalysisCurator({ cache: cacheReturningClient(ledgeredClient(sdk)) });
    const prMeta = PrMetaV1.parse({
      pr_id: prId,
      installation_id: installationId,
      repo: "acme/widget",
      pr_title: "Add a feature",
      pr_description: "## Summary",
    });
    try {
      await curator.curate([analysisFinding({ message: "v1 message" })], { prMeta });
      expect(sdkCalls).toBe(1);
      // A SECOND finding with the SAME prompt-relevant fields but a DIFFERENT auto-incremented finding_id
      // (finding_id is NOT part of the curator user message) → identical prompt → HIT replay.
      await curator.curate([analysisFinding({ message: "v1 message" })], { prMeta });
      expect(sdkCalls).toBe(1);

      const chunkId = purposeChunkId("curator");
      const rows = await ledgerRowsForChunk(installationId, chunkId);
      expect(rows.length).toBe(1);
      expect(rows[0]!.chunk_id).toBe(chunkId);
      expect(rows[0]!.review_id).toBe(prId);
      expect(rows[0]!.tool_schema_version).toBe(CURATE_TOOL_SCHEMA_VERSION);

      // CHANGED prompt → MISS + a SECOND row.
      await curator.curate([analysisFinding({ message: "a DIFFERENT message" })], { prMeta });
      expect(sdkCalls).toBe(2);
      expect((await ledgerRowsForChunk(installationId, chunkId)).length).toBe(2);
    } finally {
      await cleanup(installationId);
    }
  });
});

describeDb("W2.2 — rerank paid call ledgered by purpose (disposable PG)", () => {
  it("replays across two runs (paid SDK count 1), keys chunk_id=purposeChunkId('rerank'), CHANGED prompt → MISS + 2nd row", async () => {
    const installationId = randomUUID();
    const prId = randomUUID();
    let sdkCalls = 0;
    const sdk: LlmSdk = {
      async createMessage(): Promise<Record<string, unknown>> {
        sdkCalls += 1;
        return {
          content: [
            { type: "tool_use", name: "submit_relevance_scores", input: { scores: [0.9, 0.1] } },
          ],
          usage: { input_tokens: 30, output_tokens: 10 },
          stop_reason: "tool_use",
        };
      },
    };
    const port = new LlmBackedRerankPort({
      cache: cacheReturningClient(ledgeredClient(sdk)),
      installationId,
      reviewId: prId,
    });
    const candidates = [knowledgeChunk("aaaaaaaa-0000-4000-8000-000000000001", "alpha body")];
    try {
      const s1 = await port.rerank({ query: "find auth", candidates });
      expect(s1).toEqual([0.9, 0.1]);
      expect(sdkCalls).toBe(1);
      await port.rerank({ query: "find auth", candidates });
      expect(sdkCalls).toBe(1); // HIT.

      const chunkId = purposeChunkId("rerank");
      const rows = await ledgerRowsForChunk(installationId, chunkId);
      expect(rows.length).toBe(1);
      expect(rows[0]!.chunk_id).toBe(chunkId);
      expect(rows[0]!.review_id).toBe(prId);
      expect(rows[0]!.tool_schema_version).toBe(RERANK_TOOL_SCHEMA_VERSION);

      // CHANGED prompt (different query) → MISS + a SECOND row.
      await port.rerank({ query: "a DIFFERENT query", candidates });
      expect(sdkCalls).toBe(2);
      expect((await ledgerRowsForChunk(installationId, chunkId)).length).toBe(2);
    } finally {
      await cleanup(installationId);
    }
  });

  it("WITHOUT reviewId → back-compat: paid every run, NO ledger row", async () => {
    const installationId = randomUUID();
    let sdkCalls = 0;
    const sdk: LlmSdk = {
      async createMessage(): Promise<Record<string, unknown>> {
        sdkCalls += 1;
        return {
          content: [
            { type: "tool_use", name: "submit_relevance_scores", input: { scores: [0.5] } },
          ],
          usage: { input_tokens: 30, output_tokens: 10 },
          stop_reason: "tool_use",
        };
      },
    };
    const port = new LlmBackedRerankPort({
      cache: cacheReturningClient(ledgeredClient(sdk)),
      installationId,
      // no reviewId → no idempotency context → no ledgering (Temporal-legacy back-compat).
    });
    const candidates = [knowledgeChunk("bbbbbbbb-0000-4000-8000-000000000001", "body")];
    try {
      await port.rerank({ query: "q", candidates });
      await port.rerank({ query: "q", candidates });
      expect(sdkCalls).toBe(2); // paid every run — no replay.
      expect((await ledgerRowsForChunk(installationId, purposeChunkId("rerank"))).length).toBe(0);
    } finally {
      await cleanup(installationId);
    }
  });
});

describeDb("W2.2 — fix-prompt paid call ledgered by purpose (disposable PG)", () => {
  it("replays across two runs (paid SDK count 1), keys chunk_id=purposeChunkId('fix_prompt'), CHANGED prompt → MISS + 2nd row", async () => {
    const installationId = randomUUID();
    const reviewId = randomUUID();
    let sdkCalls = 0;
    const sdk: LlmSdk = {
      async createMessage(): Promise<Record<string, unknown>> {
        sdkCalls += 1;
        return {
          content: [
            { type: "tool_use", id: "t1", name: FIX_PROMPT_THEME_TOOL_NAME, input: { themes: "## Cross-cutting patterns\n\n- thing" } },
          ],
          usage: { input_tokens: 50, output_tokens: 30 },
          stop_reason: "tool_use",
        };
      },
    };
    const cache = cacheReturningClient(ledgeredClient(sdk));
    try {
      const r1 = await buildFixPrompt({
        reviewId,
        aggregated: aggregatedFindings([aggFinding()]),
        prNumber: 42,
        installationId,
        cache,
        clock: FIXED_CLOCK,
      });
      expect(r1.generation_mode).toBe("llm");
      expect(sdkCalls).toBe(1);

      await buildFixPrompt({
        reviewId,
        aggregated: aggregatedFindings([aggFinding()]),
        prNumber: 42,
        installationId,
        cache,
        clock: FIXED_CLOCK,
      });
      expect(sdkCalls).toBe(1); // HIT.

      const chunkId = purposeChunkId("fix_prompt");
      const rows = await ledgerRowsForChunk(installationId, chunkId);
      expect(rows.length).toBe(1);
      expect(rows[0]!.chunk_id).toBe(chunkId);
      expect(rows[0]!.review_id).toBe(reviewId);
      expect(rows[0]!.tool_schema_version).toBe(FIX_PROMPT_THEME_TOOL_SCHEMA_VERSION);

      // CHANGED prompt (different findings → different deterministic base = the user message) → MISS + 2nd row.
      await buildFixPrompt({
        reviewId,
        aggregated: aggregatedFindings([aggFinding({ title: "A DIFFERENT finding" })]),
        prNumber: 42,
        installationId,
        cache,
        clock: FIXED_CLOCK,
      });
      expect(sdkCalls).toBe(2);
      expect((await ledgerRowsForChunk(installationId, chunkId)).length).toBe(2);
    } finally {
      await cleanup(installationId);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// W2.3 (D2) — ledger retention pruner. `pruneOlderThan(days)` is a cross-tenant maintenance sweep that
// DELETEs rows whose `created_at` is older than `days` days (default 7 via
// CODEMASTER_LLM_LEDGER_RETENTION_DAYS). An OLD row (created 8 days ago) is pruned; a FRESH row (created
// now) survives. The DELETE is the cross-tenant sweep the W6.4 schedule wires (mechanism only here).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Insert a ledger row with an EXPLICIT created_at so the pruner's age cutoff can be exercised. */
async function insertLedgerRowAt(
  installationId: string,
  key: string,
  createdAt: Date,
): Promise<void> {
  await sql`
    INSERT INTO core.llm_invocation_ledger
        (idempotency_key, installation_id, provider_response, created_at)
    VALUES
        (${key}, ${installationId}::uuid, CAST(${"{}"} AS jsonb), ${createdAt.toISOString()}::timestamptz)
  `.execute(db);
}

describeDb("W2.3 — ledger retention pruner (disposable PG)", () => {
  it("pruneOlderThan(7) deletes a row older than 7 days and keeps a fresh row", async () => {
    const installationId = randomUUID();
    const oldKey = `old-${randomUUID()}`;
    const freshKey = `fresh-${randomUUID()}`;
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);
    const oneHourAgo = new Date(now - 60 * 60 * 1000);
    const ledger = new LlmInvocationLedger({ db });
    try {
      await insertLedgerRowAt(installationId, oldKey, eightDaysAgo);
      await insertLedgerRowAt(installationId, freshKey, oneHourAgo);
      expect((await ledgerRows(installationId)).length).toBe(2);

      const deleted = await ledger.pruneOlderThan(7);
      // The sweep is cross-tenant; assert the returned count >= 1 (our old row at minimum) and that OUR
      // fresh row survived while OUR old row is gone.
      expect(deleted).toBeGreaterThanOrEqual(1);

      const survivors = await ledgerRows(installationId);
      expect(survivors.map((r) => r.idempotency_key)).toEqual([freshKey]);
    } finally {
      await cleanup(installationId);
    }
  });
});
