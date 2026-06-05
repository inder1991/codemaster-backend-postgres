// AnnPort + PostgresAnnPort + InMemoryAnnPort — port of the frozen Python
//   vendor/codemaster-py/codemaster/retrieval/ann_retriever.py::AnnPort / InMemoryAnnPort
//   vendor/codemaster-py/codemaster/retrieval/postgres_ann_port.py::PostgresAnnPort (the _sql_no_cache branch only).
//
// Dense ANN over chunk embedding vectors using pgvector cosine distance. The narrow {@link AnnPort}
// type lets the retriever depend on EITHER the production Postgres adapter OR a pure-Python(/TS) test
// double, without the retriever knowing which.
//
// ── PostgresAnnPort: REAL pgvector query (NO stub) ──
// Production reads `core.knowledge_chunks` directly via the `_sql_no_cache` SQL (1:1 with the Python
// `_sql_no_cache` branch; the `_sql_phase_a` / `_sql_phase_c` EmbedderCache branches are DEFERRED —
// `embedder_cache` is `None` in the current composition so those are never taken). The pgvector `<=>`
// operator returns cosine DISTANCE ∈ [0, 2]; we return `1 - distance` as a SIMILARITY ∈ [-1, 1] in the
// SELECT clause, matching the {@link InMemoryAnnPort} `cosine` semantics (descending = better).
//
// ── Tenancy (CLAUDE.md default-deny / GF-3 raw-SQL gate) ──
// `core.knowledge_chunks` is tenant-scoped (`installation_id NOT NULL`). The query ALWAYS filters
// `installation_id = :iid AND repository_id = :rid` — the `installation_id` token in the SQL satisfies
// the check_tenant_scoped_raw_sql gate without a `// tenant:exempt` marker.
//
// ── pgvector text-bind ──
// asyncpg/pg cannot encode a raw array for the `vector` column, so the query vector is bound as the
// pgvector text literal `"[f1,f2,...]"` and CAST AS vector in the SQL (1:1 with the Python `qvec`
// bind). The cast guarantees the value is parsed as a vector, not a text param.
//
// ── Hygiene ──
// `include_stale=false` (default) appends `AND doc_status = 'active'` so deprecated/superseded/draft
// chunks are excluded; an admin override (`include_stale=true`) drops the predicate.

import { type Kysely, sql } from "kysely";

import {
  type KnowledgeChunkV1,
  type KnowledgeDocKind,
  type KnowledgeDocStatus,
} from "#contracts/knowledge_chunks.v1.js";

/** Arguments to one ANN search. `repoId` maps to the `repository_id` column (the Python kwarg is `repo_id`). */
export type AnnSearchArgs = {
  installationId: string;
  repoId: string;
  queryVector: ReadonlyArray<number>;
  topK: number;
  includeStale?: boolean;
};

/**
 * Narrow port over pgvector's cosine-similarity index (Python `AnnPort` Protocol).
 *
 * `installation_id` is the primary tenancy key. `includeStale=false` (default) filters to
 * `doc_status='active'` only; admin override sets `true`. Returns top-K `[chunk, similarity]` pairs
 * sorted by DESCENDING similarity.
 */
export type AnnPort = {
  search(args: AnnSearchArgs): Promise<ReadonlyArray<readonly [KnowledgeChunkV1, number]>>;
};

/**
 * Cosine similarity in [-1, 1]; 0 for either zero-vector (1:1 with the Python `_cosine`). Used by the
 * test-only {@link InMemoryAnnPort}; the production path computes this in pgvector.
 */
export function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length !== b.length) {
    // Python uses `zip(..., strict=True)` which raises on a length mismatch — mirror that contract.
    throw new Error(`cosine: vector length mismatch (a=${a.length} b=${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  // `.at(i)` is a method call (NOT a computed-member-access object-injection sink) — keeps the
  // security/detect-object-injection rule closed on this production-source loop.
  for (const [i, ax] of a.entries()) {
    const x = ax;
    const y = b.at(i) ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / denom;
}

/** The row shape the `_sql_no_cache` SELECT materializes (snake_case = the DB column names). */
type AnnRow = {
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
function rowToChunkAndScore(row: AnnRow): readonly [KnowledgeChunkV1, number] {
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
  // The pgvector `(1 - distance)` arithmetic comes back as a numeric (string under pg's numeric); coerce.
  const score = typeof row.score === "string" ? Number(row.score) : row.score;
  return [chunk, score] as const;
}

/**
 * Format the query vector as the pgvector text literal `"[f1,f2,...]"` (1:1 with the Python `qvec`
 * bind). asyncpg/pg cannot encode a raw array for the `vector` column, so we bind this text + CAST.
 */
function toPgVectorLiteral(vec: ReadonlyArray<number>): string {
  return `[${vec.map((x) => String(x)).join(",")}]`;
}

/**
 * Production {@link AnnPort} against `core.knowledge_chunks` using pgvector cosine distance over the
 * `vector` column. The injected {@link Kysely} is the shared-pool tenant-scoped builder (ADR-0062).
 *
 * Only the `_sql_no_cache` branch is ported — the EmbedderCache phase-A/phase-C JOINs are DEFERRED
 * (`embedder_cache` is `None` in the current composition, so those branches are never reachable).
 */
export class PostgresAnnPort implements AnnPort {
  private readonly db: Kysely<unknown>;

  public constructor({ db }: { db: Kysely<unknown> }) {
    this.db = db;
  }

  public async search(
    args: AnnSearchArgs,
  ): Promise<ReadonlyArray<readonly [KnowledgeChunkV1, number]>> {
    const includeStale = args.includeStale ?? false;
    const qvec = toPgVectorLiteral(args.queryVector);
    // The `_sql_no_cache` SQL: cosine SIMILARITY = `1 - (vector <=> :qvec)`; tenancy filtered on
    // `installation_id` AND `repository_id`; ordered by ascending DISTANCE (= descending similarity);
    // `LIMIT :top_k` is the only cut. The `installation_id` token satisfies the raw-SQL tenancy gate.
    // The stale predicate is appended via two sql fragments so the bound params stay parameterized.
    const stalePredicate = includeStale ? sql`` : sql` AND doc_status = 'active' `;
    const result = await sql<AnnRow>`
      SELECT chunk_id, installation_id, repository_id,
             relative_path, chunk_index, heading_path,
             body, doc_kind, doc_status,
             (1 - (vector <=> ${qvec}::vector)) AS score
        FROM core.knowledge_chunks
       WHERE installation_id = ${args.installationId}::uuid
         AND repository_id = ${args.repoId}::uuid${stalePredicate}
       ORDER BY vector <=> ${qvec}::vector
       LIMIT ${args.topK}
    `.execute(this.db);
    return result.rows.map(rowToChunkAndScore);
  }
}

/** One `(chunk, vector)` row the {@link InMemoryAnnPort} scores via TS cosine. */
export type InMemoryAnnRow = readonly [KnowledgeChunkV1, ReadonlyArray<number>];

/**
 * TEST-ONLY {@link AnnPort} that scores via TS {@link cosine} (1:1 with the Python `InMemoryAnnPort`).
 * NEVER used on the shipped path — the production retriever is wired with {@link PostgresAnnPort}.
 */
export class InMemoryAnnPort implements AnnPort {
  private readonly rows: ReadonlyArray<InMemoryAnnRow>;

  public constructor({ rows }: { rows: ReadonlyArray<InMemoryAnnRow> }) {
    this.rows = rows;
  }

  public async search(
    args: AnnSearchArgs,
  ): Promise<ReadonlyArray<readonly [KnowledgeChunkV1, number]>> {
    const includeStale = args.includeStale ?? false;
    const scored: Array<readonly [KnowledgeChunkV1, number]> = [];
    for (const [chunk, vec] of this.rows) {
      if (chunk.installation_id !== args.installationId) continue;
      if (chunk.repo_id !== args.repoId) continue;
      if (!includeStale && chunk.doc_status !== "active") continue;
      scored.push([chunk, cosine(args.queryVector, vec)] as const);
    }
    scored.sort((p, q) => q[1] - p[1]);
    return scored.slice(0, args.topK);
  }
}
