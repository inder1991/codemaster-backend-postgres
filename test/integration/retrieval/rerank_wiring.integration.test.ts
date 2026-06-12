// W1.3 RH9 — LIVE integration test for the PRODUCTION Bedrock-rerank wiring against the DISPOSABLE
// Postgres (NEVER the cluster). Proves, over the REAL readRerankSettings + the REAL retrieval
// composition (buildRetrieveKnowledgeActivity):
//
//   1. DEFAULT OFF — with no core.rerank_settings row and no CODEMASTER_RERANK_* env, the resolver
//      yields undefined and a full activity retrieval is byte-identical to today (not degraded,
//      identity pass-through).
//   2. The admin-API enable path — an UPSERTed enabled row flips the resolver to an LlmRerank
//      override WITHOUT any env/redeploy.
//   3. FAIL-OPEN end-to-end — enabled row but NO enabled bedrock credential row: the rerank port
//      faults (credentials_missing), the slot falls back to the pre-rerank order, the review
//      context still ships (confluence chunk present) with degraded=true + a structured WARN.
//
// Seeding mirrors retrieve_knowledge_confluence.activity.integration.test.ts (deterministic hot
// vectors + query_vector_override; unique space_key; cleanup by space_key).

import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { readRerankSettings, upsertRerankSettings } from "#backend/api/admin/llm_catalog_write.js";
import { type EmbeddingsPort } from "#backend/adapters/embeddings_port.js";
import { LlmRerank } from "#backend/retrieval/llm_rerank.js";
import {
  buildBedrockRerankResolverFromDsn,
  buildRetrieveKnowledgeActivity,
} from "#backend/wiring/retrievers.js";

import { disposeAllPools, tenantKysely } from "#platform/db/database.js";

import { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";
import { PRContext } from "#contracts/pr_context.v1.js";
import type { RetrieveKnowledgeInputV1 } from "#contracts/retrieve_knowledge.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const DIM = 1024;
const SPACE_KEY = `IT-RRW-${randomUUID().slice(0, 8)}`;
const INSTALLATION_ID = randomUUID();
const REPO_ID = randomUUID();
const UPDATER = "abababab-1111-2222-3333-444444444444";

let db: Kysely<unknown>;

function hotVector(dim: number): ReadonlyArray<number> {
  const v = new Array<number>(DIM).fill(0);
  v[dim] = 1;
  return v;
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  db = tenantKysely<unknown>(INTEGRATION_DSN);
  await sql`
    INSERT INTO core.confluence_chunks
      (chunk_id, space_key, page_id, page_title, version, chunk_index, chunk_text,
       content_sha256, labels, quarantined, quarantine_reasons, embedding)
    VALUES
      (${randomUUID()}, ${SPACE_KEY}, ${"p-py"}, ${"Page p-py"}, 1, 0, ${"body p-py"},
       ${"0".repeat(64)}, ${sql`${["lang:python"]}::text[]`}, false, ${sql`ARRAY[]::text[]`},
       ${`[${hotVector(0).map(String).join(",")}]`}::vector)
  `.execute(db);
});

beforeEach(async () => {
  if (!INTEGRATION_DSN) return;
  await sql`DELETE FROM core.rerank_settings`.execute(db);
  // Deterministic env: no Helm baseline, legacy LLM-rerank flag off, no vault reachability assumed.
  delete process.env.CODEMASTER_RERANK_ENABLED;
  delete process.env.CODEMASTER_RERANK_MODEL_ID;
  delete process.env.CODEMASTER_RERANK_REGION;
  delete process.env.CODEMASTER_RERANK_TOP_N;
  delete process.env.CODEMASTER_LLM_RERANK_ENABLED;
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  await sql`DELETE FROM core.confluence_chunks WHERE space_key = ${SPACE_KEY}`.execute(db);
  await sql`DELETE FROM core.rerank_settings`.execute(db);
  await disposeAllPools();
});

const PR_CTX = PRContext.parse({
  pr_id: randomUUID(),
  head_sha: "a".repeat(40),
  repo_default_branch: "main",
  changed_files: [{ path: "services/api/handler.py", additions: 12, deletions: 1 }],
});

function gatedInput(): RetrieveKnowledgeInputV1 {
  return {
    schema_version: 1,
    installation_id: INSTALLATION_ID,
    repo_id: REPO_ID,
    query: "services/api/handler.py review",
    top_k: 5,
    query_vector_override: [...hotVector(0)],
    include_confluence: true,
    pr_context: PR_CTX,
    yaml_config: CodemasterConfigV1.parse({}),
    platform_exposed_labels: ["default", "lang:python"],
  };
}

/** The activity-injected embedder is never reached here (query_vector_override short-circuits R-11). */
const embedderStub: EmbeddingsPort = {
  embed: async () => {
    throw new Error("embedder must not be called (query_vector_override present)");
  },
} as unknown as EmbeddingsPort;

describeDb("Bedrock-rerank production wiring (disposable PG)", () => {
  it("(1) DEFAULT OFF: no row + no env → resolver undefined; retrieval not degraded", async ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    expect(await readRerankSettings(db)).toBeNull();
    const resolver = buildBedrockRerankResolverFromDsn(INTEGRATION_DSN!);
    await expect(resolver()).resolves.toBeUndefined();

    const activity = buildRetrieveKnowledgeActivity({ embedder: embedderStub });
    const result = await activity.retrieveKnowledge(gatedInput());
    expect(result.items.some((c) => c.relative_path === `confluence/${SPACE_KEY}/p-py`)).toBe(true);
    expect(result.retrieval_degraded).toBe(false);
  });

  it("(2) the admin-API enable path: an UPSERTed enabled row flips the resolver, no env change", async ({
    skip,
  }) => {
    if (!INTEGRATION_DSN) skip();
    const resolver = buildBedrockRerankResolverFromDsn(INTEGRATION_DSN!);
    await expect(resolver()).resolves.toBeUndefined();
    await upsertRerankSettings(db, {
      enabled: true,
      modelId: "cohere.rerank-v3-5:0",
      region: "us-west-2",
      topN: 20,
      updatedAt: new Date("2026-06-12T12:00:00.000Z"),
      updatedByUserId: UPDATER,
    });
    await expect(resolver()).resolves.toBeInstanceOf(LlmRerank);
  });

  it("(3) FAIL-OPEN end-to-end: enabled row + no bedrock credentials → context still ships, degraded", async ({
    skip,
  }) => {
    if (!INTEGRATION_DSN) skip();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await upsertRerankSettings(db, {
        enabled: true,
        modelId: "cohere.rerank-v3-5:0",
        region: "us-west-2",
        topN: 20,
        updatedAt: new Date("2026-06-12T12:00:00.000Z"),
        updatedByUserId: UPDATER,
      });

      const activity = buildRetrieveKnowledgeActivity({ embedder: embedderStub });
      const result = await activity.retrieveKnowledge(gatedInput());

      // The rerank fault NEVER fails the review: the confluence context still ships...
      expect(result.items.some((c) => c.relative_path === `confluence/${SPACE_KEY}/p-py`)).toBe(true);
      // ...but the degradation is visible (the pre-rerank order fallback) + the structured WARN fired.
      expect(result.retrieval_degraded).toBe(true);
      expect(result.degradation_reason).toMatch(/rerank/i);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("bedrock_rerank_failed");
    } finally {
      warn.mockRestore();
    }
  });
});
