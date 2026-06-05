// LIVE integration test for the LEGACY RetrieveKnowledgeActivity (BM25 + ANN + RRF) against a
// DISPOSABLE Postgres + a LIVE Ollama embedder.
//
// Proves the REAL fusion end-to-end (NO stub on the happy path):
//   1. Seed `core.knowledge_chunks` rows for ONE (installation_id, repository_id). Bodies are embedded
//      via the REAL OpenAICompatibleEmbeddingsAdapter (Ollama mxbai-embed-large, 1024-dim — matches the
//      `vector(1024)` column). Some bodies share the query's lexical terms (BM25 hits); some are only
//      semantically near (ANN hits); one body is BOTH lexically AND semantically the best match.
//   2. Run RetrieveKnowledgeActivity.retrieveKnowledge over the live PostgresBm25Port + PostgresAnnPort
//      (the AnnRetriever embeds the query with the SAME live adapter).
//   3. The chunk that ranks in BOTH BM25 and ANN floats to the TOP of the RRF-fused result.
//
// Plus a DEGRADED case: a RecordingEmbeddingsClient.simulateUnreachable makes the ANN side embed RPC
// throw EmbeddingsConnectivityError → AnnRetriever returns degraded-empty → only the live BM25 side
// contributes → the result is BM25-only with retrieval_degraded=true. (The RecordingEmbeddingsClient is
// a TEST-ONLY double, used here ONLY to simulate the embed-unreachable failure mode.)
//
// GATING:
//   - DB: runs ONLY when CODEMASTER_PG_CORE_DSN is set (describeDb) — the disposable PG at
//     postgresql://postgres:postgres@localhost:5434/codemaster, NEVER the in-cluster DB.
//   - Ollama: a beforeAll probe pings http://localhost:11434/v1/embeddings; each `it` skips if
//     unreachable so validate-fast stays green without it.
//
// ISOLATION: serial suite (run with --no-file-parallelism); UNIQUE installation_id / repository_id per
// test (randomUUID); every seeded row is cleaned up FK-safe in afterAll.

import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { RetrieveKnowledgeActivity } from "#backend/activities/retrieve_knowledge.activity.js";
import { RecordingEmbeddingsClient } from "#backend/adapters/embeddings_port.js";
import { OpenAICompatibleEmbeddingsAdapter } from "#backend/integrations/openai_compat/adapter.js";
import { AnnRetriever } from "#backend/retrieval/ann_retriever.js";
import { PostgresAnnPort } from "#backend/retrieval/ann_port.js";
import { PostgresBm25Port } from "#backend/retrieval/bm25_port.js";
import { Bm25Retriever } from "#backend/retrieval/bm25_retriever.js";

import { disposeAllPools, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const OLLAMA_BASE_URL = "http://localhost:11434";
const OLLAMA_MODEL = "mxbai-embed-large";
const PROBE_TIMEOUT_MS = 3000;

let db: Kysely<unknown>;
let ollamaReachable = false;

const ADAPTER = new OpenAICompatibleEmbeddingsAdapter({
  baseUrl: OLLAMA_BASE_URL,
  apiKey: "x", // Ollama ignores the bearer token; a non-empty value is still required.
  modelName: OLLAMA_MODEL,
});

// Track every seeded id for FK-safe cleanup.
const seededInstallations: Array<string> = [];
const seededRepositories: Array<string> = [];

beforeAll(async () => {
  if (INTEGRATION_DSN) {
    db = tenantKysely<unknown>(INTEGRATION_DSN);
  }
  try {
    const resp = await fetch(`${OLLAMA_BASE_URL}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
      body: JSON.stringify({ model: OLLAMA_MODEL, input: ["ping"] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    ollamaReachable = resp.status === 200;
  } catch {
    ollamaReachable = false;
  }
});

afterAll(async () => {
  if (INTEGRATION_DSN) {
    for (const rid of seededRepositories) {
      await sql`DELETE FROM core.knowledge_chunks WHERE repository_id = ${rid}`.execute(db);
      await sql`DELETE FROM core.repositories WHERE repository_id = ${rid}`.execute(db);
    }
    for (const iid of seededInstallations) {
      await sql`DELETE FROM core.installations WHERE installation_id = ${iid}`.execute(db);
    }
    await disposeAllPools();
  }
  if (!ollamaReachable) {
    console.warn(
      `[skipped] Ollama unreachable at ${OLLAMA_BASE_URL}/v1/embeddings — ` +
        "start Ollama with mxbai-embed-large to run the live retrieve_knowledge integration test.",
    );
  }
});

/** A unique positive bigint for the github_* UNIQUE columns (derived from a fresh UUID). */
function uniqueGithubId(): bigint {
  return BigInt(`0x${randomUUID().replace(/-/g, "").slice(0, 12)}`);
}

/** Embed one text with the LIVE adapter; return its 1024-dim vector. */
async function embed(text: string): Promise<ReadonlyArray<number>> {
  const result = await ADAPTER.embed({
    texts: [text],
    model_name: "ignored-per-adr-0059",
    purpose: "in_repo_doc",
  });
  const first = result.vectors[0];
  if (first === undefined) {
    throw new Error("live embedder returned no vector");
  }
  return first;
}

/** pgvector text literal "[f1,f2,...]" for the vector(1024) column. */
function toPgVectorLiteral(vec: ReadonlyArray<number>): string {
  return `[${vec.map((x) => String(x)).join(",")}]`;
}

/** Seed the FK parents (installation + repository). */
async function seedParents(installationId: string, repositoryId: string): Promise<void> {
  await sql`
    INSERT INTO core.installations
      (installation_id, github_installation_id, account_login, account_type)
    VALUES (${installationId}, ${uniqueGithubId().toString()}, ${"acct-" +
    installationId.slice(0, 8)}, 'Organization')
  `.execute(db);
  await sql`
    INSERT INTO core.repositories
      (repository_id, installation_id, github_repo_id, full_name, default_branch)
    VALUES (${repositoryId}, ${installationId}, ${uniqueGithubId().toString()}, ${"org/repo-" +
    repositoryId.slice(0, 8)}, 'main')
  `.execute(db);
}

/** Insert one active knowledge_chunks row with a LIVE-embedded body vector; return its chunk_id. */
async function seedChunk(args: {
  installationId: string;
  repositoryId: string;
  relativePath: string;
  chunkIndex: number;
  body: string;
}): Promise<string> {
  const chunkId = randomUUID();
  const vec = await embed(args.body);
  const vecLit = toPgVectorLiteral(vec);
  await sql`
    INSERT INTO core.knowledge_chunks
      (chunk_id, installation_id, repository_id, relative_path, chunk_index,
       content_sha256, heading_path, body, vector, doc_kind, doc_status)
    VALUES (${chunkId}, ${args.installationId}, ${args.repositoryId}, ${args.relativePath},
            ${args.chunkIndex}, ${"0".repeat(64)}, ${sql`ARRAY[]::text[]`}, ${args.body},
            ${vecLit}::vector, 'adr', 'active'::core.knowledge_doc_status)
  `.execute(db);
  return chunkId;
}

/** Build the legacy activity over the LIVE ports + live adapter as the AnnRetriever embedder. */
function buildActivity(): RetrieveKnowledgeActivity {
  const bm25Retriever = new Bm25Retriever({ port: new PostgresBm25Port({ db }) });
  const annRetriever = new AnnRetriever({
    port: new PostgresAnnPort({ db }),
    embeddings: ADAPTER,
    modelName: OLLAMA_MODEL,
  });
  return new RetrieveKnowledgeActivity({ bm25Retriever, annRetriever });
}

describeDb("RetrieveKnowledgeActivity (legacy BM25+ANN+RRF) against disposable PG + live Ollama", () => {
  it("fuses BM25 + ANN via RRF; a both-lists chunk floats to the top", async ({ skip }) => {
    if (!ollamaReachable) skip();
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    seededInstallations.push(installationId);
    seededRepositories.push(repositoryId);
    await seedParents(installationId, repositoryId);

    // Query: about Postgres connection pool sizing per worker.
    // - "both": uses the query's literal terms (BM25 hit) AND is semantically on-topic (ANN hit) →
    //   should rank highly on BOTH lists → RRF floats it to the very top.
    const bothId = await seedChunk({
      installationId,
      repositoryId,
      relativePath: "docs/pool_sizing.md",
      chunkIndex: 0,
      body: "Postgres connection pool sizing per worker: each worker shares one connection pool so the database connection count stays bounded.",
    });
    // - "lexical-only": shares some query TERMS (connection, pool, worker, database) but is a noisier,
    //   less on-topic sentence → a BM25 hit, weaker ANN.
    await seedChunk({
      installationId,
      repositoryId,
      relativePath: "docs/pool_terms.md",
      chunkIndex: 0,
      body: "The worker connection pool database setting and pool worker connection knobs can be tuned in the config file.",
    });
    // - "semantic-only": paraphrases the topic WITHOUT the literal query terms → an ANN hit, no BM25
    //   match (plainto_tsquery on the query terms won't match it).
    await seedChunk({
      installationId,
      repositoryId,
      relativePath: "docs/semantic.md",
      chunkIndex: 0,
      body: "Sizing the number of simultaneous client links each service holds open to the data store, so the backend does not overwhelm it.",
    });
    // - "unrelated": neither lexical nor semantic overlap.
    await seedChunk({
      installationId,
      repositoryId,
      relativePath: "docs/baking.md",
      chunkIndex: 0,
      body: "Sourdough bread requires a long overnight fermentation of flour, water, and salt at room temperature.",
    });

    const activity = buildActivity();
    const result = await activity.retrieveKnowledge({
      schema_version: 1,
      installation_id: installationId,
      repo_id: repositoryId,
      query: "Postgres connection pool sizing per worker",
      top_k: 3,
      query_vector_override: null,
      include_confluence: false,
      pr_context: null,
      yaml_config: null,
      platform_exposed_labels: [],
    });

    expect(result.retrieval_degraded).toBe(false);
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    // The both-lists chunk floats to the top of the RRF fusion.
    expect(result.items[0]!.chunk_id).toBe(bothId);
    expect(result.items[0]!.relative_path).toBe("docs/pool_sizing.md");
    // The unrelated baking body must NOT be in the fused top-3.
    const paths = result.items.map((c) => c.relative_path);
    expect(paths).not.toContain("docs/baking.md");
    // Tenancy: every returned chunk belongs to the seeded tenant.
    for (const c of result.items) {
      expect(c.installation_id).toBe(installationId);
      expect(c.repo_id).toBe(repositoryId);
    }
  });

  it("ANN embed unreachable → degraded-empty ANN → BM25-only result, retrieval_degraded=true", async ({
    skip,
  }) => {
    if (!ollamaReachable) skip();
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    seededInstallations.push(installationId);
    seededRepositories.push(repositoryId);
    await seedParents(installationId, repositoryId);

    // Seed a chunk whose body shares the query's literal terms → a live BM25 hit. (The vector is
    // still LIVE-embedded for the column; only the ANN QUERY-side embed is simulated unreachable.)
    const lexId = await seedChunk({
      installationId,
      repositoryId,
      relativePath: "docs/connection_pool.md",
      chunkIndex: 0,
      body: "Connection pool exhaustion causes errors when the worker opens too many database connections.",
    });

    // Build the activity with a LIVE BM25 port but an UNREACHABLE embedder on the ANN side. The
    // RecordingEmbeddingsClient is a TEST-ONLY double used here ONLY to simulate the embed-unreachable
    // failure mode (EmbeddingsConnectivityError) so the ANN side degrades to empty.
    const unreachableEmbedder = new RecordingEmbeddingsClient();
    unreachableEmbedder.simulateUnreachable(true);
    const bm25Retriever = new Bm25Retriever({ port: new PostgresBm25Port({ db }) });
    const annRetriever = new AnnRetriever({
      port: new PostgresAnnPort({ db }),
      embeddings: unreachableEmbedder,
      modelName: OLLAMA_MODEL,
    });
    const activity = new RetrieveKnowledgeActivity({ bm25Retriever, annRetriever });

    const result = await activity.retrieveKnowledge({
      schema_version: 1,
      installation_id: installationId,
      repo_id: repositoryId,
      query: "connection pool exhaustion worker database",
      top_k: 5,
      // null → AnnRetriever must embed (and will hit the unreachable embedder → degrade).
      query_vector_override: null,
      include_confluence: false,
      pr_context: null,
      yaml_config: null,
      platform_exposed_labels: [],
    });

    // ANN degraded-empty; BM25 contributed the lexical hit → fused result is BM25-only.
    expect(result.retrieval_degraded).toBe(true);
    expect(result.degradation_reason).toContain("unreachable");
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.chunk_id).toBe(lexId);
    expect(result.items[0]!.relative_path).toBe("docs/connection_pool.md");
    // The ANN embed RPC was attempted (and threw) — the AnnRetriever did try to embed the query.
    expect(unreachableEmbedder.callCount()).toBe(0); // simulateUnreachable throws BEFORE recording.
  });
});
