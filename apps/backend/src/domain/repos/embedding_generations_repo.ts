/**
 * PostgresEmbeddingGenerationsRepo — 1:1 TypeScript port of the frozen Python
 * `vendor/codemaster-py/codemaster/embedder/generations_repo.py`.
 *
 * Pure I/O on `core.embedding_generations` (+ counts on `core.chunk_embeddings` /
 * `core.confluence_chunks` / `core.knowledge_chunks`). State-machine VALIDATION lives in the
 * EmbedderGenerationService (not ported here); this repo provides the raw read/write surface plus the
 * atomic state transitions whose SQL must satisfy the on-disk biconditional CHECKs.
 *
 * The load-bearing correctness properties (ported byte-faithfully from the Python):
 *   - insertNew uses the bigint SEQUENCE default (generation_id allocated by the DB) + RETURNING.
 *   - Every transition writes `state` AND its paired timestamp(s) ATOMICALLY so the on-disk
 *     `embedding_generations_state_biconditional` CHECK holds. A transition that set `state` without its
 *     timestamp is REJECTED by PG — that rejection is the safety mechanism, not a bug.
 *   - transitionToActive enforces the SINGLE-ACTIVE invariant: it demotes ANY currently-active
 *     generation to 'ready' in the SAME transaction (COALESCE'ing a NULL backfill_completed_at to now()
 *     so the migration-seed gen-1 case still satisfies the ready biconditional — see project memory
 *     [[embedder-seed-demote]]), then promotes the target to 'active' (clearing retired_at/retire_reason
 *     so the rollback path retired→active satisfies the active biconditional).
 *
 * Tenancy: `core.embedding_generations` / `core.embedder_runtime_state` / `core.chunk_embeddings` are
 * PLATFORM-WIDE (no `installation_id`) → NOT in `TENANT_SCOPED_TABLES`, so the raw-SQL tenancy gate does
 * not fire on them. The inline `// tenant:exempt` markers mirror the platform-wide intent.
 *
 * ADR-0062 (Postgres connection-pool lifecycle): this repo owns NO pool/engine cache. It is handed a
 * `Kysely<unknown>` over the process-wide single pool (via {@link tenantKysely}); transitions run inside
 * `db.transaction()` so the two-statement transitionToActive is atomic (mirroring the Python
 * `async with session.begin()`).
 */

import { type Kysely, sql, type Transaction } from "kysely";

import type {
  EmbeddingGenerationRowV1,
  RetireReason,
} from "#contracts/embedding_generation.v1.js";

// The full column projection (1:1 with the Python `_GEN_COLUMNS`), in the dataclass field order.
const GEN_COLUMNS = sql`
  generation_id, state, generation_label, generation_reason,
  provider_name, provider_version, model_name, embedding_dimension,
  created_from_generation, chunker_version, preprocessing_version, normalization_version,
  created_at, created_by_email,
  backfill_started_at, backfill_completed_at,
  validation_started_at, validation_completed_at, validation_report_json, validation_passed,
  activated_at, retired_at, retire_reason, gc_started_at, gc_completed_at,
  total_chunks, chunks_backfilled, chunks_failed, last_error
`;

/** The raw row shape pg hands back for the GEN_COLUMNS projection (driver-native types). */
type RawGenRow = {
  generation_id: string | number;
  state: EmbeddingGenerationRowV1["state"];
  generation_label: string | null;
  generation_reason: string | null;
  provider_name: string;
  provider_version: string | null;
  model_name: string;
  embedding_dimension: string | number;
  created_from_generation: string | number | null;
  chunker_version: string;
  preprocessing_version: string;
  normalization_version: string;
  created_at: Date;
  created_by_email: string | null;
  backfill_started_at: Date | null;
  backfill_completed_at: Date | null;
  validation_started_at: Date | null;
  validation_completed_at: Date | null;
  // pg parses a JSONB column to an already-deserialized object/array (mirrors asyncpg in the Python).
  validation_report_json: unknown;
  validation_passed: boolean | null;
  activated_at: Date | null;
  retired_at: Date | null;
  retire_reason: RetireReason | null;
  gc_started_at: Date | null;
  gc_completed_at: Date | null;
  total_chunks: string | number;
  chunks_backfilled: string | number;
  chunks_failed: string | number;
  last_error: string | null;
};

/**
 * Map a raw DB row to the typed contract row (1:1 with the Python `_row_to_dataclass`).
 *
 * The `validation_report_json` branch mirrors the Python exactly: pg (like asyncpg) deserializes a JSONB
 * column to a Python `dict`/`list` (here: a JS object/array), so we re-encode to canonical JSON TEXT via
 * `JSON.stringify`; the legacy code path where the driver returns the raw text payload is preserved via
 * the `String(...)` fallback.
 */
function rowToContract(m: RawGenRow): EmbeddingGenerationRowV1 {
  const report = m.validation_report_json;
  const validationReportJson =
    report === null || report === undefined
      ? null
      : typeof report === "object"
        ? JSON.stringify(report)
        : String(report);

  return {
    generation_id: Number(m.generation_id),
    state: m.state,
    generation_label: m.generation_label,
    generation_reason: m.generation_reason,
    provider_name: m.provider_name,
    provider_version: m.provider_version,
    model_name: m.model_name,
    embedding_dimension: Number(m.embedding_dimension),
    created_from_generation:
      m.created_from_generation === null ? null : Number(m.created_from_generation),
    chunker_version: m.chunker_version,
    preprocessing_version: m.preprocessing_version,
    normalization_version: m.normalization_version,
    created_at: m.created_at,
    created_by_email: m.created_by_email,
    backfill_started_at: m.backfill_started_at,
    backfill_completed_at: m.backfill_completed_at,
    validation_started_at: m.validation_started_at,
    validation_completed_at: m.validation_completed_at,
    validation_report_json: validationReportJson,
    validation_passed: m.validation_passed,
    activated_at: m.activated_at,
    retired_at: m.retired_at,
    retire_reason: m.retire_reason,
    gc_started_at: m.gc_started_at,
    gc_completed_at: m.gc_completed_at,
    total_chunks: Number(m.total_chunks),
    chunks_backfilled: Number(m.chunks_backfilled),
    chunks_failed: Number(m.chunks_failed),
    last_error: m.last_error,
  };
}

/** Pure I/O repo over `core.embedding_generations` (+ chunk-count helpers). */
export class PostgresEmbeddingGenerationsRepo {
  private readonly db: Kysely<unknown>;

  public constructor({ db }: { db: Kysely<unknown> }) {
    this.db = db;
  }

  /**
   * Insert a fresh generation in state 'backfilling' (1:1 with the Python `insert_new`).
   *
   * generation_id is allocated by the bigint SEQUENCE (the column DEFAULT); `backfill_started_at = now()`
   * satisfies the backfilling biconditional. RETURNING projects the full row.
   *
   * Defaults match the Python keyword defaults: chunker/preprocessing/normalization version "1",
   * provider_name "qwen", provider_version null.
   */
  public async insertNew(args: {
    modelName: string;
    embeddingDimension: number;
    generationLabel: string | null;
    generationReason: string | null;
    createdByEmail: string;
    createdFromGeneration: number | null;
    chunkerVersion?: string;
    preprocessingVersion?: string;
    normalizationVersion?: string;
    providerName?: string;
    providerVersion?: string | null;
  }): Promise<EmbeddingGenerationRowV1> {
    const chunkerVersion = args.chunkerVersion ?? "1";
    const preprocessingVersion = args.preprocessingVersion ?? "1";
    const normalizationVersion = args.normalizationVersion ?? "1";
    const providerName = args.providerName ?? "qwen";
    const providerVersion = args.providerVersion ?? null;

    return this.db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;
      // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
      const result = await sql<RawGenRow>`
        INSERT INTO core.embedding_generations (
          state, generation_label, generation_reason,
          provider_name, provider_version, model_name, embedding_dimension,
          created_from_generation,
          chunker_version, preprocessing_version, normalization_version,
          created_by_email, backfill_started_at
        ) VALUES (
          'backfilling', ${args.generationLabel}, ${args.generationReason},
          ${providerName}, ${providerVersion}, ${args.modelName}, ${args.embeddingDimension},
          ${args.createdFromGeneration},
          ${chunkerVersion}, ${preprocessingVersion}, ${normalizationVersion},
          ${args.createdByEmail}, now()
        )
        RETURNING ${GEN_COLUMNS}
      `.execute(tx);
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("insertNew: INSERT ... RETURNING produced no row");
      }
      return rowToContract(row);
    });
  }

  /** Fetch one generation by id, or null if absent (1:1 with the Python `get`). */
  public async get(generationId: number): Promise<EmbeddingGenerationRowV1 | null> {
    // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
    const result = await sql<RawGenRow>`
      SELECT ${GEN_COLUMNS} FROM core.embedding_generations WHERE generation_id = ${generationId}
    `.execute(this.db);
    const row = result.rows[0];
    return row === undefined ? null : rowToContract(row);
  }

  /** The N most-recent generations, newest-first (1:1 with the Python `list_recent`). */
  public async listRecent(limit = 20): Promise<ReadonlyArray<EmbeddingGenerationRowV1>> {
    // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
    const result = await sql<RawGenRow>`
      SELECT ${GEN_COLUMNS} FROM core.embedding_generations
      ORDER BY generation_id DESC LIMIT ${limit}
    `.execute(this.db);
    return result.rows.map(rowToContract);
  }

  /**
   * Update backfill progress counters (1:1 with the Python `update_backfill_progress`). When
   * `totalChunks` is supplied it is updated too; otherwise it is left untouched.
   */
  public async updateBackfillProgress(args: {
    generationId: number;
    chunksBackfilled: number;
    chunksFailed: number;
    totalChunks?: number | null;
  }): Promise<void> {
    await this.db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;
      if (args.totalChunks !== undefined && args.totalChunks !== null) {
        // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
        await sql`
          UPDATE core.embedding_generations
             SET chunks_backfilled = ${args.chunksBackfilled},
                 chunks_failed = ${args.chunksFailed},
                 total_chunks = ${args.totalChunks}
           WHERE generation_id = ${args.generationId}
        `.execute(tx);
      } else {
        // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
        await sql`
          UPDATE core.embedding_generations
             SET chunks_backfilled = ${args.chunksBackfilled},
                 chunks_failed = ${args.chunksFailed}
           WHERE generation_id = ${args.generationId}
        `.execute(tx);
      }
    });
  }

  /**
   * backfilling → ready (1:1 with the Python `transition_to_ready`). Sets `backfill_completed_at = now()`
   * so the ready biconditional holds; only fires when the row is currently 'backfilling'.
   */
  public async transitionToReady(generationId: number): Promise<void> {
    await this.db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;
      // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
      await sql`
        UPDATE core.embedding_generations
           SET state = 'ready', backfill_completed_at = now()
         WHERE generation_id = ${generationId} AND state = 'backfilling'
      `.execute(tx);
    });
  }

  /**
   * Promote `generationId` to 'active', enforcing the SINGLE-ACTIVE invariant (1:1 with the Python
   * `transition_to_active`).
   *
   * Two statements in ONE transaction:
   *   1. Demote ANY currently-active generation (other than the target) to 'ready': clear activated_at,
   *      and COALESCE backfill_completed_at to now() so the migration-seed gen-1 case (completed_at NULL)
   *      still satisfies the ready biconditional. See project memory [[embedder-seed-demote]].
   *   2. Promote the target to 'active' (activated_at = now()), clearing retired_at + retire_reason so
   *      the rollback path retired→active satisfies the active biconditional. For the ready→active path
   *      both are already NULL so the clear is a no-op.
   */
  public async transitionToActive(generationId: number): Promise<void> {
    await this.db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;
      // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
      await sql`
        UPDATE core.embedding_generations
           SET state = 'ready',
               activated_at = NULL,
               backfill_completed_at = COALESCE(backfill_completed_at, now())
         WHERE state = 'active' AND generation_id <> ${generationId}
      `.execute(tx);
      // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
      await sql`
        UPDATE core.embedding_generations
           SET state = 'active', activated_at = now(),
               retired_at = NULL, retire_reason = NULL
         WHERE generation_id = ${generationId}
      `.execute(tx);
    });
  }

  /**
   * backfilling|ready → retired (1:1 with the Python `transition_to_retired`). Sets retired_at = now()
   * and retire_reason (the retire_reason biconditional holds). Only fires on 'backfilling'/'ready'.
   */
  public async transitionToRetired(
    generationId: number,
    retireReason: RetireReason,
  ): Promise<void> {
    await this.db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;
      // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
      await sql`
        UPDATE core.embedding_generations
           SET state = 'retired', retired_at = now(), retire_reason = ${retireReason}
         WHERE generation_id = ${generationId} AND state IN ('backfilling', 'ready')
      `.execute(tx);
    });
  }

  /**
   * Record a validation run (1:1 with the Python `record_validation`). Stamps validation_started_at
   * (only if NULL), validation_completed_at = now(), the report (CAST to jsonb), and the pass flag.
   */
  public async recordValidation(args: {
    generationId: number;
    reportJson: string;
    passed: boolean;
  }): Promise<void> {
    await this.db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;
      // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
      await sql`
        UPDATE core.embedding_generations
           SET validation_started_at = COALESCE(validation_started_at, now()),
               validation_completed_at = now(),
               validation_report_json = CAST(${args.reportJson} AS jsonb),
               validation_passed = ${args.passed}
         WHERE generation_id = ${args.generationId}
      `.execute(tx);
    });
  }

  /** Stamp gc_started_at = now() (1:1 with the Python `record_gc_started`). */
  public async recordGcStarted(generationId: number): Promise<void> {
    await this.db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;
      // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
      await sql`
        UPDATE core.embedding_generations SET gc_started_at = now() WHERE generation_id = ${generationId}
      `.execute(tx);
    });
  }

  /** Stamp gc_completed_at = now() (1:1 with the Python `record_gc_completed`). */
  public async recordGcCompleted(generationId: number): Promise<void> {
    await this.db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;
      // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
      await sql`
        UPDATE core.embedding_generations SET gc_completed_at = now() WHERE generation_id = ${generationId}
      `.execute(tx);
    });
  }

  /**
   * Record the last error, truncated to 8192 chars (1:1 with the Python `record_error`, where
   * `error_msg[:8192]` bounds the column write).
   */
  public async recordError(args: { generationId: number; errorMsg: string }): Promise<void> {
    const truncated = args.errorMsg.slice(0, 8192);
    await this.db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;
      // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
      await sql`
        UPDATE core.embedding_generations SET last_error = ${truncated} WHERE generation_id = ${args.generationId}
      `.execute(tx);
    });
  }

  /**
   * Count canonical (live) chunks across the two corpora (1:1 with the Python `count_canonical_chunks`).
   * Filters per the canonical-chunks-schema memory:
   *   confluence_chunks: deleted_at IS NULL AND superseded_at IS NULL
   *   knowledge_chunks:  doc_status = 'active'
   */
  public async countCanonicalChunks(): Promise<{
    confluence_chunks: number;
    knowledge_chunks: number;
  }> {
    // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
    const c = await sql<{ count: string | number }>`
      SELECT COUNT(*) AS count FROM core.confluence_chunks
       WHERE deleted_at IS NULL AND superseded_at IS NULL
    `.execute(this.db);
    // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
    const k = await sql<{ count: string | number }>`
      SELECT COUNT(*) AS count FROM core.knowledge_chunks WHERE doc_status = 'active'
    `.execute(this.db);
    return {
      confluence_chunks: Number(c.rows[0]?.count ?? 0),
      knowledge_chunks: Number(k.rows[0]?.count ?? 0),
    };
  }

  /** Count chunk_embeddings rows under a generation (1:1 with the Python `count_chunk_embeddings`). */
  public async countChunkEmbeddings(generationId: number): Promise<number> {
    // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
    const result = await sql<{ count: string | number }>`
      SELECT COUNT(*) AS count FROM core.chunk_embeddings WHERE generation_id = ${generationId}
    `.execute(this.db);
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * v4 §8 Phase B coverage gate (1:1 with the Python `count_coverage_gap`): count canonical chunks with
   * NO chunk_embeddings row under `activeGeneration`. Returns [confluence_missing, knowledge_missing];
   * both should be 0 before flipping retrieval_mode to 'generation_only'.
   */
  public async countCoverageGap(args: {
    activeGeneration: number;
  }): Promise<[number, number]> {
    // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
    const confluence = await sql<{ count: string | number }>`
      SELECT COUNT(*) AS count FROM core.confluence_chunks c
        LEFT JOIN core.chunk_embeddings ce
          ON ce.chunk_table = 'confluence_chunks'
         AND ce.chunk_id = c.chunk_id
         AND ce.generation_id = ${args.activeGeneration}
       WHERE c.deleted_at IS NULL AND c.superseded_at IS NULL
         AND ce.chunk_id IS NULL
    `.execute(this.db);
    // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
    const knowledge = await sql<{ count: string | number }>`
      SELECT COUNT(*) AS count FROM core.knowledge_chunks c
        LEFT JOIN core.chunk_embeddings ce
          ON ce.chunk_table = 'knowledge_chunks'
         AND ce.chunk_id = c.chunk_id
         AND ce.generation_id = ${args.activeGeneration}
       WHERE c.doc_status = 'active'
         AND ce.chunk_id IS NULL
    `.execute(this.db);
    return [
      Number(confluence.rows[0]?.count ?? 0),
      Number(knowledge.rows[0]?.count ?? 0),
    ];
  }
}
