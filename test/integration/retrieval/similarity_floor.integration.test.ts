// LIVE integration test for the W1.3 (RH10) minimum cosine-similarity floor against a DISPOSABLE
// Postgres — proves the REAL SQL predicate in BOTH pgvector adapters (NO Ollama dependency: the
// vectors are SYNTHETIC unit vectors, so the cosine arithmetic is exact and deterministic):
//
//   1. PostgresAnnPort: rows hot at dim0 (cos=1 with the e0 query), 30°-band (cos=0.5), orthogonal
//      (cos=0). The DEFAULT floor (0.3) drops the orthogonal row instead of padding to top_k; an
//      explicit tighter floor (0.6) drops the mid row too; minSimilarity=0 restores legacy padding.
//   2. PostgresConfluenceRetrieval (legacy no-cache path): same shape over `core.confluence_chunks`
//      with a non-default label (no approval row required).
//
// GATING: runs ONLY when CODEMASTER_PG_CORE_DSN is set (describeDb) — the disposable PG, NEVER the
// in-cluster DB. ISOLATION: unique installation/repository/space per run; FK-safe cleanup in afterAll.

import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { PostgresConfluenceRetrieval } from "#backend/adapters/postgres_confluence_retrieval.js";
import { PostgresAnnPort } from "#backend/retrieval/ann_port.js";
import { formatPgvectorLiteral } from "#backend/retrieval/pgvector_literal.js";

import { disposeAllPools, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const DIM = 1024;
const INSTALLATION_ID = randomUUID();
const REPO_ID = randomUUID();
const SPACE_KEY = `IT-FLOOR-${randomUUID().slice(0, 8)}`;
const LABEL = "lang:python";

let db: Kysely<unknown>;

/** A unique positive bigint for the github_* UNIQUE columns (derived from a fresh UUID). */
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

// Query anchor: e0. Seeded bodies: cos=1 (hot e0), cos=0.5 (30°-band), cos=0 (orthogonal e1).
const QUERY_VEC = syntheticVector({ 0: 1 });
const NEAR_VEC = syntheticVector({ 0: 1 });
const MID_VEC = syntheticVector({ 0: 0.5, 1: Math.sqrt(0.75) });
const FAR_VEC = syntheticVector({ 1: 1 });

async function seedKnowledgeChunk(args: {
  relativePath: string;
  vector: ReadonlyArray<number>;
}): Promise<void> {
  await sql`
    INSERT INTO core.knowledge_chunks
      (chunk_id, installation_id, repository_id, relative_path, chunk_index,
       content_sha256, heading_path, body, vector, doc_kind, doc_status)
    VALUES (${randomUUID()}, ${INSTALLATION_ID}, ${REPO_ID}, ${args.relativePath}, 0,
            ${"0".repeat(64)}, ${sql`ARRAY[]::text[]`}, ${"body of " + args.relativePath},
            ${formatPgvectorLiteral(args.vector)}::vector, 'adr', 'active'::core.knowledge_doc_status)
  `.execute(db);
}

async function seedConfluenceChunk(args: {
  pageId: string;
  vector: ReadonlyArray<number>;
}): Promise<void> {
  await sql`
    INSERT INTO core.confluence_chunks
      (chunk_id, space_key, page_id, page_title, version, chunk_index, chunk_text,
       content_sha256, labels, quarantined, quarantine_reasons, embedding)
    VALUES
      (${randomUUID()}, ${SPACE_KEY}, ${args.pageId}, ${"Page " + args.pageId}, 1, 0,
       ${"text of " + args.pageId}, ${"0".repeat(64)}, ${sql`${[LABEL]}::text[]`}, false,
       ${sql`ARRAY[]::text[]`}, ${formatPgvectorLiteral(args.vector)}::vector)
  `.execute(db);
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
  await seedKnowledgeChunk({ relativePath: "near.md", vector: NEAR_VEC });
  await seedKnowledgeChunk({ relativePath: "mid.md", vector: MID_VEC });
  await seedKnowledgeChunk({ relativePath: "far.md", vector: FAR_VEC });
  await seedConfluenceChunk({ pageId: "p-near", vector: NEAR_VEC });
  await seedConfluenceChunk({ pageId: "p-far", vector: FAR_VEC });
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  await sql`DELETE FROM core.confluence_chunks WHERE space_key = ${SPACE_KEY}`.execute(db);
  await sql`DELETE FROM core.knowledge_chunks WHERE repository_id = ${REPO_ID}`.execute(db);
  await sql`DELETE FROM core.repositories WHERE repository_id = ${REPO_ID}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${INSTALLATION_ID}`.execute(db);
  await disposeAllPools();
});

describeDb("PostgresAnnPort — minimum-similarity floor (RH10)", () => {
  it("applies the default floor in SQL: the orthogonal row is dropped instead of padding to top_k", async () => {
    const port = new PostgresAnnPort({ db });
    const hits = await port.search({
      installationId: INSTALLATION_ID,
      repoId: REPO_ID,
      queryVector: QUERY_VEC,
      topK: 5,
    });
    expect(hits.map(([c]) => c.relative_path)).toEqual(["near.md", "mid.md"]);
    for (const [, score] of hits) {
      expect(score).toBeGreaterThanOrEqual(0.3);
    }
  });

  it("an explicit tighter floor drops the mid-band row too", async () => {
    const port = new PostgresAnnPort({ db });
    const hits = await port.search({
      installationId: INSTALLATION_ID,
      repoId: REPO_ID,
      queryVector: QUERY_VEC,
      topK: 5,
      minSimilarity: 0.6,
    });
    expect(hits.map(([c]) => c.relative_path)).toEqual(["near.md"]);
  });

  it("minSimilarity=0 restores the legacy padding (explicit opt-out)", async () => {
    const port = new PostgresAnnPort({ db });
    const hits = await port.search({
      installationId: INSTALLATION_ID,
      repoId: REPO_ID,
      queryVector: QUERY_VEC,
      topK: 5,
      minSimilarity: 0,
    });
    expect(hits.map(([c]) => c.relative_path)).toEqual(["near.md", "mid.md", "far.md"]);
  });
});

describeDb("PostgresConfluenceRetrieval — minimum-similarity floor (RH10)", () => {
  it("applies the default floor in SQL on the legacy no-cache path", async () => {
    const adapter = new PostgresConfluenceRetrieval({ db });
    const hits = await adapter.search({
      queryEmbedding: QUERY_VEC,
      topK: 5,
      effectiveLabels: new Set([LABEL]),
    });
    expect(hits.map((c) => c.page_id)).toEqual(["p-near"]);
  });

  it("minSimilarity=0 restores the legacy padding (explicit opt-out)", async () => {
    const adapter = new PostgresConfluenceRetrieval({ db, minSimilarity: 0 });
    const hits = await adapter.search({
      queryEmbedding: QUERY_VEC,
      topK: 5,
      effectiveLabels: new Set([LABEL]),
    });
    expect(hits.map((c) => c.page_id)).toEqual(["p-near", "p-far"]);
  });

  it("computes the label-overlap match_specificity_score from effective_labels (RH8 — no longer hardcoded 0)", async () => {
    const adapter = new PostgresConfluenceRetrieval({ db });
    const hits = await adapter.search({
      queryEmbedding: QUERY_VEC,
      topK: 5,
      effectiveLabels: new Set([LABEL, "topic:security"]),
    });
    expect(hits).toHaveLength(1);
    // The seeded chunk carries labels=[lang:python]; overlap with the effective set = {lang:python}
    // → the `lang` namespace weight (3), per spec §3.5 / the Python compute_match_specificity.
    expect(hits[0]!.match_specificity_score).toBe(3);
  });
});
