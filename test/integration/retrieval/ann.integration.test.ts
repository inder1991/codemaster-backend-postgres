// LIVE integration test for PostgresAnnPort against a DISPOSABLE Postgres + a LIVE Ollama embedder.
//
// Proves the REAL pgvector cosine search end-to-end (NO stub):
//   1. Seed ~5 `core.knowledge_chunks` rows for ONE (installation_id, repository_id), bodies embedded
//      via the REAL OpenAICompatibleEmbeddingsAdapter (Ollama mxbai-embed-large, 1024-dim — matches the
//      `vector(1024)` column). One row is doc_status=deprecated (stale).
//   2. Embed a query string with the SAME live adapter.
//   3. PostgresAnnPort.search returns top_k ordered by cosine similarity — the semantically-nearest body
//      first — and the stale (deprecated) row is excluded by the include_stale=false predicate.
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

import { OpenAICompatibleEmbeddingsAdapter } from "#backend/integrations/openai_compat/adapter.js";
import { PostgresAnnPort } from "#backend/retrieval/ann_port.js";

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
    // ADR-0062: seed/assert Kysely over the ONE shared pool from the central factory.
    db = tenantKysely<unknown>(INTEGRATION_DSN);
  }
  // Probe the live Ollama OpenAI-compat endpoint. AbortSignal.timeout here is in a TEST file (excluded
  // from check_clock_random, which only scans production src trees).
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
    // ADR-0062 teardown: end the shared pool(s) via the central seam.
    await disposeAllPools();
  }
  if (!ollamaReachable) {
    console.warn(
      `[skipped] Ollama unreachable at ${OLLAMA_BASE_URL}/v1/embeddings — ` +
        "start Ollama with mxbai-embed-large to run the live ANN integration test.",
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

/** Insert one knowledge_chunks row with a LIVE-embedded body vector. */
async function seedChunk(args: {
  installationId: string;
  repositoryId: string;
  relativePath: string;
  chunkIndex: number;
  body: string;
  docStatus: "active" | "deprecated";
}): Promise<string> {
  const chunkId = randomUUID();
  const vec = await embed(args.body);
  const vecLit = toPgVectorLiteral(vec);
  // content_sha256 is a NOT NULL char(64); a 64-char hex placeholder satisfies the column. The vector
  // is bound as the pgvector text literal + CAST AS vector (same idiom as PostgresAnnPort).
  await sql`
    INSERT INTO core.knowledge_chunks
      (chunk_id, installation_id, repository_id, relative_path, chunk_index,
       content_sha256, heading_path, body, vector, doc_kind, doc_status)
    VALUES (${chunkId}, ${args.installationId}, ${args.repositoryId}, ${args.relativePath},
            ${args.chunkIndex}, ${"0".repeat(64)}, ${sql`ARRAY[]::text[]`}, ${args.body},
            ${vecLit}::vector, 'adr', ${args.docStatus}::core.knowledge_doc_status)
  `.execute(db);
  return chunkId;
}

describeDb("PostgresAnnPort against disposable PG + live Ollama mxbai", () => {
  it("returns top_k ordered by cosine similarity; nearest body first", async ({ skip }) => {
    if (!ollamaReachable) skip();
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    seededInstallations.push(installationId);
    seededRepositories.push(repositoryId);
    await seedParents(installationId, repositoryId);

    // Five distinct topical bodies. The query is about database connection pooling, so the
    // pooling/Postgres body should be the nearest neighbor; an unrelated body should rank last.
    await seedChunk({
      installationId,
      repositoryId,
      relativePath: "docs/pooling.md",
      chunkIndex: 0,
      body: "Postgres connection pool sizing: each worker shares one pool to avoid exhausting connections.",
      docStatus: "active",
    });
    await seedChunk({
      installationId,
      repositoryId,
      relativePath: "docs/temporal.md",
      chunkIndex: 0,
      body: "Temporal workflow activities run in a sandbox isolate separate from the worker process.",
      docStatus: "active",
    });
    await seedChunk({
      installationId,
      repositoryId,
      relativePath: "docs/vault.md",
      chunkIndex: 0,
      body: "Vault is the only secret store; keys are fetched from Vault KV at pod startup.",
      docStatus: "active",
    });
    await seedChunk({
      installationId,
      repositoryId,
      relativePath: "docs/baking.md",
      chunkIndex: 0,
      body: "Sourdough bread requires a long overnight fermentation of flour, water, and salt.",
      docStatus: "active",
    });
    await seedChunk({
      installationId,
      repositoryId,
      relativePath: "docs/pooling.md",
      chunkIndex: 1,
      body: "Database pool lifecycle: memoize the engine so the connection count stays bounded per worker.",
      docStatus: "active",
    });

    const port = new PostgresAnnPort({ db });
    const queryVector = await embed("how should we size the database connection pool per worker?");
    const hits = await port.search({ installationId, repoId: repositoryId, queryVector, topK: 3 });

    expect(hits.length).toBe(3);
    // Scores are descending similarities.
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i - 1]![1]).toBeGreaterThanOrEqual(hits[i]![1]);
    }
    // The nearest body is one of the two pooling chunks (semantically about DB connection pools).
    const topPath = hits[0]![0].relative_path;
    expect(topPath).toBe("docs/pooling.md");
    // The unrelated baking body must NOT be in the top-3.
    const paths = hits.map((h) => h[0].relative_path);
    expect(paths).not.toContain("docs/baking.md");
    // Tenancy + shape: every returned chunk belongs to the seeded tenant.
    for (const [chunk] of hits) {
      expect(chunk.installation_id).toBe(installationId);
      expect(chunk.repo_id).toBe(repositoryId);
      expect(chunk.doc_status).toBe("active");
    }
  });

  it("excludes stale (deprecated) rows when include_stale is false", async ({ skip }) => {
    if (!ollamaReachable) skip();
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    seededInstallations.push(installationId);
    seededRepositories.push(repositoryId);
    await seedParents(installationId, repositoryId);

    // One ACTIVE chunk + one DEPRECATED chunk with the SAME body — so without the stale filter both
    // would tie at the top. With the filter, only the active one is returned.
    const sharedBody =
      "Connection pool exhaustion causes TooManyConnectionsError on a rolling deploy with no headroom.";
    const activeId = await seedChunk({
      installationId,
      repositoryId,
      relativePath: "docs/active.md",
      chunkIndex: 0,
      body: sharedBody,
      docStatus: "active",
    });
    await seedChunk({
      installationId,
      repositoryId,
      relativePath: "docs/stale.md",
      chunkIndex: 0,
      body: sharedBody,
      docStatus: "deprecated",
    });

    const port = new PostgresAnnPort({ db });
    const queryVector = await embed("connection pool exhaustion on deploy");

    // Default (include_stale=false): the deprecated row is excluded.
    const active = await port.search({ installationId, repoId: repositoryId, queryVector, topK: 10 });
    expect(active.length).toBe(1);
    expect(active[0]![0].chunk_id).toBe(activeId);
    expect(active[0]![0].doc_status).toBe("active");

    // Admin override (include_stale=true): BOTH rows come back.
    const all = await port.search({
      installationId,
      repoId: repositoryId,
      queryVector,
      topK: 10,
      includeStale: true,
    });
    expect(all.length).toBe(2);
    const statuses = all.map((h) => h[0].doc_status).sort();
    expect(statuses).toEqual(["active", "deprecated"]);
  });
});
