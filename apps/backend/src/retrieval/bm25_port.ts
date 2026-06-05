// Bm25Port + PostgresBm25Port + InMemoryBm25Port — port of the frozen Python
//   vendor/codemaster-py/codemaster/retrieval/bm25_retriever.py::Bm25Port / InMemoryBm25Port
//   vendor/codemaster-py/codemaster/retrieval/postgres_bm25_port.py::PostgresBm25Port
//
// Lexical (BM25-ish) retrieval over `core.knowledge_chunks` using Postgres `ts_rank_cd` over the
// `body_tsv` GIN-indexed generated tsvector column (baseline migration 0001 / Python migration 0059).
// The narrow {@link Bm25Port} type lets the retriever depend on EITHER the production Postgres adapter
// OR a pure-TS test double, without the retriever knowing which.
//
// ── PostgresBm25Port: REAL ts_rank_cd query (NO stub) ──
// Production reads `core.knowledge_chunks` directly: `ts_rank_cd(body_tsv, plainto_tsquery('english',
// :query))` is the lexical score; the candidate set is gated by `body_tsv @@ plainto_tsquery(...)` so
// only rows that match the query terms are scored; ordered by score DESC; `LIMIT :top_k`. The column
// projection is identical to PostgresAnnPort → maps 1:1 to {@link KnowledgeChunkV1}.
//
// ── Tenancy (CLAUDE.md default-deny / GF-3 raw-SQL gate) ──
// `core.knowledge_chunks` is tenant-scoped (`installation_id NOT NULL`). The query ALWAYS filters
// `installation_id = :iid AND repository_id = :rid` — the `installation_id` token in the SQL satisfies
// the check_tenant_scoped_raw_sql gate without a `// tenant:exempt` marker.
//
// ── Hygiene ──
// `include_stale=false` (default) appends `AND doc_status = 'active'` so deprecated/superseded/draft
// chunks are excluded; an admin override (`include_stale=true`) drops the predicate (1:1 with the
// Python two-SQL-path branch).

import { type Kysely, sql } from "kysely";

import {
  type KnowledgeChunkV1,
  type KnowledgeDocKind,
  type KnowledgeDocStatus,
} from "#contracts/knowledge_chunks.v1.js";

/** Arguments to one BM25 search. `repoId` maps to the `repository_id` column (the Python kwarg is `repo_id`). */
export type Bm25SearchArgs = {
  installationId: string;
  repoId: string;
  query: string;
  topK: number;
  includeStale?: boolean;
};

/**
 * Narrow port over Postgres `ts_rank_cd` lexical search (Python `Bm25Port` Protocol).
 *
 * `installation_id` is the primary tenancy key. `includeStale=false` (default) filters to
 * `doc_status='active'` only; admin override sets `true`. Returns top-K `[chunk, score]` pairs sorted
 * by DESCENDING `ts_rank_cd`. Empty result when no chunks match the query.
 */
export type Bm25Port = {
  search(args: Bm25SearchArgs): Promise<ReadonlyArray<readonly [KnowledgeChunkV1, number]>>;
};

/** The row shape the `ts_rank_cd` SELECT materializes (snake_case = the DB column names). */
type Bm25Row = {
  chunk_id: string;
  installation_id: string;
  repository_id: string;
  relative_path: string;
  chunk_index: number;
  heading_path: ReadonlyArray<string> | null;
  body: string;
  doc_kind: string;
  doc_status: string;
  score: number | string;
};

/** Map a SELECT row to `[KnowledgeChunkV1, score]` (1:1 with the Python `_row_to_chunk_and_score`). */
function rowToChunkAndScore(row: Bm25Row): readonly [KnowledgeChunkV1, number] {
  const chunk: KnowledgeChunkV1 = {
    schema_version: 2,
    chunk_id: row.chunk_id,
    installation_id: row.installation_id,
    repo_id: row.repository_id,
    relative_path: row.relative_path,
    chunk_index: row.chunk_index,
    heading_path: row.heading_path === null ? [] : [...row.heading_path],
    body: row.body,
    doc_kind: row.doc_kind as KnowledgeDocKind,
    doc_status: row.doc_status as KnowledgeDocStatus,
    source: "repo_knowledge",
    space_key: null,
    page_id: null,
    page_version: null,
    labels: [],
    match_specificity_score: 0,
    age_days: 0,
  };
  // `ts_rank_cd` comes back as a float4/numeric (string under pg's numeric); coerce defensively.
  const score = typeof row.score === "string" ? Number(row.score) : row.score;
  return [chunk, score] as const;
}

/**
 * Production {@link Bm25Port} against `core.knowledge_chunks` using `ts_rank_cd` over the GIN-indexed
 * `body_tsv` generated column. The injected {@link Kysely} is the shared-pool tenant-scoped builder
 * (ADR-0062) — NOT a per-port pool.
 */
export class PostgresBm25Port implements Bm25Port {
  private readonly db: Kysely<unknown>;

  public constructor({ db }: { db: Kysely<unknown> }) {
    this.db = db;
  }

  public async search(
    args: Bm25SearchArgs,
  ): Promise<ReadonlyArray<readonly [KnowledgeChunkV1, number]>> {
    const includeStale = args.includeStale ?? false;
    // Two SQL paths (1:1 with the Python include_stale branch): the default appends
    // `AND doc_status = 'active'`. Both filter `installation_id` AND `repository_id` — the
    // `installation_id` token satisfies the raw-SQL tenancy gate. The stale predicate is a separate
    // sql`` fragment so the bound params stay parameterized. The `plainto_tsquery('english', :query)`
    // call is repeated in the SELECT, the WHERE (the `@@` candidate gate), and is the same query text;
    // pg evaluates the identical immutable function once per row.
    const stalePredicate = includeStale ? sql`` : sql` AND doc_status = 'active' `;
    const result = await sql<Bm25Row>`
      SELECT chunk_id, installation_id, repository_id,
             relative_path, chunk_index, heading_path,
             body, doc_kind, doc_status,
             ts_rank_cd(body_tsv, plainto_tsquery('english', ${args.query})) AS score
        FROM core.knowledge_chunks
       WHERE installation_id = ${args.installationId}::uuid
         AND repository_id = ${args.repoId}::uuid${stalePredicate}
         AND body_tsv @@ plainto_tsquery('english', ${args.query})
       ORDER BY score DESC
       LIMIT ${args.topK}
    `.execute(this.db);
    return result.rows.map(rowToChunkAndScore);
  }
}

/** Match Postgres `plainto_tsquery` lexing closely enough for the in-memory parity double. */
const TOKEN_RE = /[a-z0-9_]+/g;

/** Lowercase + strip punctuation (1:1 with the Python `_tokenize`). */
function tokenize(text: string): Array<string> {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

/**
 * TEST-ONLY {@link Bm25Port} that scores by tf-idf token overlap (1:1 with the Python
 * `InMemoryBm25Port`). Ordering is consistent enough for behavioural tests; absolute score values are
 * NOT compared against Postgres. NEVER used on the shipped path — production wires {@link
 * PostgresBm25Port}.
 */
export class InMemoryBm25Port implements Bm25Port {
  // (chunk, pre-tokenized body) pairs — the TS analogue of the Python `zip(self._chunks, self._tokens,
  // strict=True)`. Pairing them at construction lets `search` iterate without an index access (keeps the
  // security/detect-object-injection sink closed).
  private readonly chunkTokenPairs: ReadonlyArray<readonly [KnowledgeChunkV1, ReadonlyArray<string>]>;
  private readonly idf: ReadonlyMap<string, number>;

  public constructor({ chunks }: { chunks: ReadonlyArray<KnowledgeChunkV1> }) {
    // Pre-tokenize per chunk for repeated scoring runs.
    this.chunkTokenPairs = chunks.map((c) => [c, tokenize(c.body)] as const);
    // Per-token document-frequency for IDF.
    const df = new Map<string, number>();
    for (const [, toks] of this.chunkTokenPairs) {
      for (const t of new Set(toks)) {
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
    const nDocs = Math.max(chunks.length, 1);
    const idf = new Map<string, number>();
    for (const [t, count] of df) {
      idf.set(t, Math.log(1 + nDocs / count));
    }
    this.idf = idf;
  }

  public async search(
    args: Bm25SearchArgs,
  ): Promise<ReadonlyArray<readonly [KnowledgeChunkV1, number]>> {
    const includeStale = args.includeStale ?? false;
    const qTokens = tokenize(args.query);
    if (qTokens.length === 0) {
      return [];
    }
    const scored: Array<readonly [KnowledgeChunkV1, number]> = [];
    for (const [chunk, tokens] of this.chunkTokenPairs) {
      if (chunk.installation_id !== args.installationId) continue;
      if (chunk.repo_id !== args.repoId) continue;
      if (!includeStale && chunk.doc_status !== "active") continue;
      const tf = new Map<string, number>();
      for (const t of tokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }
      let score = 0;
      for (const q of qTokens) {
        const count = tf.get(q);
        if (count !== undefined) {
          score += count * (this.idf.get(q) ?? 0);
        }
      }
      if (score > 0) {
        scored.push([chunk, score] as const);
      }
    }
    scored.sort((p, q) => q[1] - p[1]);
    return scored.slice(0, args.topK);
  }
}
