// W1.3 capstone integration test (mandated by the MASTER hardening plan, W1.3): a SECURITY-RELEVANT
// diff retrieves the security knowledge chunk ABOVE noise — through the REAL RetrieveKnowledgeActivity
// over live Postgres ports on the disposable PG.
//
// What this proves end-to-end (RC4 + RH10 together):
//   1. The query is CODE-BEARING (buildRetrievalQueryText): the diff hunk introducing a SQL-injection
//      sink — not just `path + title` — drives the search. The legacy query for this PR
//      ("src/db/users.py Add user lookup") carried no security semantics at all (the RC4 scenario).
//   2. The ANN leg ranks the security guidance FIRST for that query vector, and the
//      minimum-similarity floor EXCLUDES the irrelevant README instead of padding it in as
//      "knowledge" (the RH10 scenario: a near-orthogonal match must not reach the LLM).
//
// DETERMINISTIC: vectors are SYNTHETIC (the query vector is threaded via query_vector_override —
// exactly how the orchestrator threads the memoized embed), so no live embedder is required and the
// cosine arithmetic is exact. GATING: runs ONLY when CODEMASTER_PG_CORE_DSN is set (describeDb).

import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { RetrieveKnowledgeActivity } from "#backend/activities/retrieve_knowledge.activity.js";
import { RecordingEmbeddingsClient } from "#backend/adapters/embeddings_port.js";
import { AnnRetriever } from "#backend/retrieval/ann_retriever.js";
import { PostgresAnnPort } from "#backend/retrieval/ann_port.js";
import { PostgresBm25Port } from "#backend/retrieval/bm25_port.js";
import { Bm25Retriever } from "#backend/retrieval/bm25_retriever.js";
import { formatPgvectorLiteral } from "#backend/retrieval/pgvector_literal.js";
import { buildRetrievalQueryText } from "#backend/review/pipeline/retrieval_query.js";

import { disposeAllPools, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const DIM = 1024;
const INSTALLATION_ID = randomUUID();
const REPO_ID = randomUUID();

let db: Kysely<unknown>;
let securityChunkId = "";

function uniqueGithubId(): bigint {
  return BigInt(`0x${randomUUID().replace(/-/g, "").slice(0, 12)}`);
}

/** A 1024-dim vector with the given (dim → weight) components; all else 0. */
function syntheticVector(components: Readonly<Record<number, number>>): ReadonlyArray<number> {
  const v = new Array<number>(DIM).fill(0);
  for (const [dim, weight] of Object.entries(components)) {
    v[Number(dim)] = weight;
  }
  return v;
}

// The (synthetic) embedding of the CODE-BEARING query below: anchored at dim 0.
const QUERY_VEC = syntheticVector({ 0: 1 });
// The security ADR sits right on the query anchor (the semantically-near doc).
const SECURITY_VEC = syntheticVector({ 0: 1 });
// Tangential style guidance: cos = 0.5 — relevant-ish, must rank BELOW the security chunk.
const STYLE_VEC = syntheticVector({ 0: 0.5, 1: Math.sqrt(0.75) });
// The README: cos = 0 — the RH10 noise that used to pad top_k; must be EXCLUDED by the floor.
const README_VEC = syntheticVector({ 1: 1 });

async function seedChunk(args: {
  relativePath: string;
  body: string;
  vector: ReadonlyArray<number>;
}): Promise<string> {
  const chunkId = randomUUID();
  await sql`
    INSERT INTO core.knowledge_chunks
      (chunk_id, installation_id, repository_id, relative_path, chunk_index,
       content_sha256, heading_path, body, vector, doc_kind, doc_status)
    VALUES (${chunkId}, ${INSTALLATION_ID}, ${REPO_ID}, ${args.relativePath}, 0,
            ${"0".repeat(64)}, ${sql`ARRAY[]::text[]`}, ${args.body},
            ${formatPgvectorLiteral(args.vector)}::vector, 'adr', 'active'::core.knowledge_doc_status)
  `.execute(db);
  return chunkId;
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  db = tenantKysely<unknown>(INTEGRATION_DSN);
  await sql`
    INSERT INTO core.installations
      (installation_id, github_installation_id, account_login, account_type)
    VALUES (${INSTALLATION_ID}, ${uniqueGithubId().toString()},
            ${"acct-" + INSTALLATION_ID.slice(0, 8)}, 'Organization')
  `.execute(db);
  await sql`
    INSERT INTO core.repositories
      (repository_id, installation_id, github_repo_id, full_name, default_branch)
    VALUES (${REPO_ID}, ${INSTALLATION_ID}, ${uniqueGithubId().toString()},
            ${"org/repo-" + REPO_ID.slice(0, 8)}, 'main')
  `.execute(db);
  securityChunkId = await seedChunk({
    relativePath: "docs/security/sql-injection.md",
    body:
      "Always use parameterized queries: never interpolate user input into a SELECT statement. " +
      "String-formatted SQL passed to cursor.execute is an injection sink.",
    vector: SECURITY_VEC,
  });
  await seedChunk({
    relativePath: "docs/style.md",
    body: "Prefer descriptive variable names and small functions.",
    vector: STYLE_VEC,
  });
  await seedChunk({
    relativePath: "README.md",
    body: "Project setup: install dependencies and run the dev server.",
    vector: README_VEC,
  });
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  await sql`DELETE FROM core.knowledge_chunks WHERE repository_id = ${REPO_ID}`.execute(db);
  await sql`DELETE FROM core.repositories WHERE repository_id = ${REPO_ID}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${INSTALLATION_ID}`.execute(db);
  await disposeAllPools();
});

describeDb("W1.3 capstone — a security-relevant diff retrieves the security chunk above noise", () => {
  it("ranks the SQL-injection guidance FIRST and floor-excludes the README noise", async () => {
    // The RC4 scenario diff: a PR titled "Add user lookup" introducing a SQL-injection sink.
    const queryText = buildRetrievalQueryText({
      prTitle: "Add user lookup",
      prDescription: "Adds a lookup endpoint for users by name.",
      chunkPath: "src/db/users.py",
      chunkBody: `cursor.execute(f"SELECT * FROM users WHERE name = '{name}'")`,
    });
    expect(queryText).toContain("cursor.execute"); // the CODE drives the search, not just path+title

    const activity = new RetrieveKnowledgeActivity({
      bm25Retriever: new Bm25Retriever({ port: new PostgresBm25Port({ db }) }),
      annRetriever: new AnnRetriever({
        port: new PostgresAnnPort({ db }),
        // query_vector_override is threaded (the orchestrator's memoized embed) → no embed RPC fires.
        embeddings: new RecordingEmbeddingsClient(),
        modelName: "unused-under-override",
      }),
      topK: 5,
    });

    const result = await activity.retrieveKnowledge({
      schema_version: 1,
      installation_id: INSTALLATION_ID,
      repo_id: REPO_ID,
      query: queryText,
      top_k: 5,
      query_vector_override: [...QUERY_VEC],
      include_confluence: false,
      pr_context: null,
      yaml_config: null,
      platform_exposed_labels: [],
    });

    expect(result.retrieval_degraded).toBe(false);
    const paths = result.items.map((c) => c.relative_path);
    // The security chunk is the TOP result for the security-relevant diff.
    expect(result.items[0]!.chunk_id).toBe(securityChunkId);
    expect(paths[0]).toBe("docs/security/sql-injection.md");
    // The tangential doc may follow (cos 0.5 clears the 0.3 floor) — but NEVER above security.
    if (paths.includes("docs/style.md")) {
      expect(paths.indexOf("docs/style.md")).toBeGreaterThan(0);
    }
    // RH10: the orthogonal README is EXCLUDED by the similarity floor, not padded in as "knowledge".
    expect(paths).not.toContain("README.md");
  });
});
