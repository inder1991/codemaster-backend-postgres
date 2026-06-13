/**
 * PostgresConfluenceChunksRepo — single-pass upsert over `core.confluence_chunks` (Sub-spec A T11)
 * plus `reconcile_deletions` soft-delete (brought into the data layer for self-containment).
 *
 * Single-pass upsert that handles all the schema columns Sub-spec 0 + A added. Called by the
 * upsert_chunks activity AFTER it has applied hard limits and resolved default_approval lookups.
 *
 * Audit fixes preserved byte-faithfully from the Python source:
 *   P1-1 — stale_at = NULL on every active write (ON CONFLICT DO UPDATE).
 *   P0-4 — findExistingChunkEmbedding lets the activity skip Bedrock on retry when (chunk_id,
 *          content_sha256) already has a stored vector (avoids double-billing).
 *
 * Methods:
 *   - makeChunkId               — deterministic uuid5(NAMESPACE_URL, "confluence/<space>/<page>@<ver>#<idx>").
 *   - upsertChunks              — natural-key UPSERT writing all columns; quarantine + default_approval
 *                                 gating; optional dual-write to core.chunk_embeddings.
 *   - findExistingChunkEmbedding— idempotency lookup returning the stored embedding tuple (or null).
 *   - reconcileDeletions        — soft-delete (deleted_at = now()) chunks for pages absent from the
 *                                 live set of a sync pass.
 *
 * Tenancy: the confluence tables are PLATFORM-WIDE — `installation_id` was dropped in migration
 * 0063 (the TS baseline `core.confluence_chunks` carries no `installation_id`), so they are NOT in
 * `TENANT_SCOPED_TABLES` and the raw-SQL tenancy gate does not fire on them. The inline
 * `// tenant:exempt` markers document the platform-wide intent.
 *
 * ADR-0062 (Postgres connection-pool lifecycle): this repo owns NO pool/engine cache. It is handed a
 * `Kysely<unknown>` over the process-wide single pool (via {@link tenantKysely}) and a {@link Clock} by
 * injection so every repo shares one engine across the worker.
 */

import { type Kysely, sql, type Transaction } from "kysely";

import type { Clock } from "#platform/clock.js";
import { uuid5 } from "#platform/randomness.js";

import type { DefaultApprovalV1 } from "#contracts/page_approval.v1.js";

import { canonicalize } from "../../retrieval/label_taxonomy.js";

// ─── uuid5 namespace (deterministic; NOT randomness — outside the clock/random gate's scope) ─────
//
// The SHA-1 minter is the shared `#platform/randomness.js::uuid5` seam (deterministic hashing only).

/** RFC 4122 URL namespace. */
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/**
 * Deterministic chunk_id for idempotency across Temporal replays.
 *
 * F-36 (P1): `version` is part of the seed, so chunks at versions 5 and 6 of the same page produce
 * DIFFERENT chunk_ids (a fresh row per version bump). The seed is:
 *   `confluence/<space_key>/<page_id>@<version>#<chunk_index>`.
 */
export function makeChunkId(args: {
  spaceKey: string;
  pageId: string;
  version: number;
  chunkIndex: number;
}): string {
  return uuid5(
    NAMESPACE_URL,
    `confluence/${args.spaceKey}/${args.pageId}@${args.version}#${args.chunkIndex}`,
  );
}

// ─── Input row ───────────────────────────────────────────────────────────────────────────────────

/** One row the repo is asked to insert or update. */
export type UpsertChunkRow = {
  readonly chunkId: string;
  readonly spaceKey: string;
  readonly pageId: string;
  readonly pageTitle: string;
  readonly version: number;
  readonly chunkIndex: number;
  /** post-redactor body (carries the `<doc trust="untrusted">` wrapper). */
  readonly body: string;
  readonly contentSha256: string;
  readonly embedding: ReadonlyArray<number>;
  /** pre-canonicalization raw labels. */
  readonly rawLabels: ReadonlyArray<string>;
  readonly quarantined: boolean;
  readonly quarantineReasons: ReadonlyArray<string>;
  readonly pageStatus: string;
  readonly lastModifiedAt: Date;
  readonly tokenCount: number;
  readonly defaultApproval: DefaultApprovalV1 | null;
  readonly redactionApplied: boolean;
};

/**
 * Format an embedding as the pgvector text literal `"[f1,f2,...]"`. pg cannot encode a raw array for
 * the `vector` column, so we bind this text + CAST AS vector in the SQL.
 */
function toPgVectorLiteral(vec: ReadonlyArray<number>): string {
  return `[${vec.map((x) => String(x)).join(",")}]`;
}

// ─── The repo ───────────────────────────────────────────────────────────────────────────────────

/** Async repo over `core.confluence_chunks` (+ dual-write to `core.chunk_embeddings`). */
export class PostgresConfluenceChunksRepo {
  private readonly db: Kysely<unknown>;
  private readonly clock: Clock;

  public constructor({ db, clock }: { db: Kysely<unknown>; clock: Clock }) {
    this.db = db;
    this.clock = clock;
  }

  /**
   * Upsert chunks with canonicalized labels + quarantine + default approval. Returns the number of
   * rows upserted.
   *
   * Audit fixes preserved:
   *   - P1-1: stale_at = NULL on every active write (clears any prior stale mark).
   *   - Default-label/approval biconditional: a 'default'-tagged row arriving WITHOUT default_approval
   *     is rejected immediately (defense-in-depth; the activity should have filtered these out).
   *
   * Dual-write (Phase 4 T4.3): when BOTH `activeGeneration` AND `activeModelName` are provided, each
   * chunk's vector is ALSO written to `core.chunk_embeddings` under `chunk_table='confluence_chunks'` and
   * the supplied generation. When EITHER is undefined/null, dual-write is skipped (legacy column only).
   *
   * The whole batch (legacy writes + optional dual-writes) runs in ONE transaction so a partial failure
   * rolls both back atomically.
   */
  public async upsertChunks(
    rows: ReadonlyArray<UpsertChunkRow>,
    opts: { activeGeneration?: number | null; activeModelName?: string | null } = {},
  ): Promise<number> {
    const activeGeneration = opts.activeGeneration ?? null;
    const activeModelName = opts.activeModelName ?? null;
    const dualWrite = activeGeneration !== null && activeModelName !== null;

    // Validate + pre-compute every row BEFORE opening the transaction so a default-approval violation
    // throws without leaving a half-open transaction.
    type Prepared = {
      row: UpsertChunkRow;
      labels: Array<string>;
      defaultApprovalJson: string | null;
      embeddingStr: string;
    };
    const prepared: Array<Prepared> = rows.map((row) => {
      const labels = row.rawLabels.map((label) => canonicalize(label));
      if (labels.includes("default") && row.defaultApproval === null) {
        // Defense-in-depth: the activity should have caught this; reject loudly so the error surfaces in
        // the Temporal activity retry.
        throw new Error(
          `refusing default-tagged chunk without default_approval: ` +
            `space=${row.spaceKey} page=${row.pageId} chunk=${row.chunkIndex}`,
        );
      }
      const defaultApprovalJson =
        row.defaultApproval !== null ? JSON.stringify(row.defaultApproval) : null;
      return {
        row,
        labels,
        defaultApprovalJson,
        embeddingStr: toPgVectorLiteral(row.embedding),
      };
    });

    if (prepared.length === 0) {
      return 0;
    }

    let upserted = 0;
    await this.db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;
      for (const p of prepared) {
        const { row, labels, defaultApprovalJson, embeddingStr } = p;
        // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
        await sql`
          INSERT INTO core.confluence_chunks (
            chunk_id, space_key, page_id, page_title, version, chunk_index,
            chunk_text, content_sha256, embedding, redaction_applied,
            labels, quarantined, quarantine_reasons,
            page_status, last_modified_at, stale_at, default_approval,
            token_count
          ) VALUES (
            ${row.chunkId}, ${row.spaceKey}, ${row.pageId}, ${row.pageTitle}, ${row.version}, ${row.chunkIndex},
            ${row.body}, ${row.contentSha256}, CAST(${embeddingStr} AS vector), ${row.redactionApplied},
            ${labels}::text[], ${row.quarantined}, ${[...row.quarantineReasons]}::text[],
            ${row.pageStatus}, ${row.lastModifiedAt}, NULL, CAST(${defaultApprovalJson} AS jsonb),
            ${row.tokenCount}
          ) ON CONFLICT (chunk_id) DO UPDATE SET
            version            = EXCLUDED.version,
            page_title         = EXCLUDED.page_title,
            chunk_text         = EXCLUDED.chunk_text,
            content_sha256     = EXCLUDED.content_sha256,
            embedding          = EXCLUDED.embedding,
            labels             = EXCLUDED.labels,
            quarantined        = EXCLUDED.quarantined,
            quarantine_reasons = EXCLUDED.quarantine_reasons,
            page_status        = EXCLUDED.page_status,
            last_modified_at   = EXCLUDED.last_modified_at,
            stale_at           = NULL,
            default_approval   = EXCLUDED.default_approval,
            token_count        = EXCLUDED.token_count,
            redaction_applied  = EXCLUDED.redaction_applied
        `.execute(tx);

        // Phase 4 T4.3 — dual-write to core.chunk_embeddings under the active generation. Same txn as
        // the legacy write above, so the batch's commit makes both atomic. ON CONFLICT DO UPDATE keeps
        // re-syncs idempotent (content_sha256 changes flow through to both rows).
        if (dualWrite) {
          // tenant:exempt reason=embedder-platform-global follow_up=PERMANENT-EXEMPTION-embedder-corpus-upsert
          await sql`
            INSERT INTO core.chunk_embeddings (
              chunk_table, chunk_id, generation_id,
              embedding_model_name, embedding, content_sha256
            ) VALUES (
              'confluence_chunks', ${row.chunkId}, ${activeGeneration},
              ${activeModelName}, CAST(${embeddingStr} AS vector), ${row.contentSha256}
            ) ON CONFLICT (chunk_table, chunk_id, generation_id) DO UPDATE SET
              embedding_model_name = EXCLUDED.embedding_model_name,
              embedding            = EXCLUDED.embedding,
              content_sha256       = EXCLUDED.content_sha256
          `.execute(tx);
        }
        upserted += 1;
      }
    });

    return upserted;
  }

  /**
   * Audit P0-4 — idempotency check before Bedrock embed.
   *
   * Returns the stored embedding tuple if a chunk with this (chunk_id, content_sha256) exists and is not
   * soft-deleted, enabling the chunk_and_embed activity to skip the Bedrock call on a Temporal retry.
   */
  public async findExistingChunkEmbedding(args: {
    chunkId: string;
    contentSha256: string;
  }): Promise<ReadonlyArray<number> | null> {
    // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
    const result = await sql<{ embedding: string | Array<number> | null }>`
      SELECT embedding FROM core.confluence_chunks
       WHERE chunk_id = ${args.chunkId}
         AND content_sha256 = ${args.contentSha256}
         AND deleted_at IS NULL
    `.execute(this.db);

    const first = result.rows[0];
    if (first === undefined) {
      return null;
    }
    const raw = first.embedding;
    if (raw === null) {
      return null;
    }
    // pgvector may return a string like "[0.1,0.2,...]" or an array depending on driver.
    if (typeof raw === "string") {
      return raw
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((x) => Number(x));
    }
    return raw.map((x) => Number(x));
  }

  /**
   * Soft-delete chunks for pages that disappeared from the live space. Pages observed during this sync
   * pass are safe; any page NOT in
   * `livePageIds` gets its chunks marked `deleted_at = now()`. Returns the number of rows soft-deleted.
   *
   * Already-soft-deleted rows (`deleted_at IS NOT NULL`) are skipped, so a re-run over the same live set
   * is idempotent (returns 0 the second time).
   */
  public async reconcileDeletions(args: {
    spaceKey: string;
    livePageIds: ReadonlyArray<string>;
  }): Promise<number> {
    const now = this.clock.now();
    // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
    const result = await sql`
      UPDATE core.confluence_chunks
         SET deleted_at = ${now}
       WHERE space_key = ${args.spaceKey}
         AND deleted_at IS NULL
         AND NOT (page_id = ANY(${[...args.livePageIds]}::text[]))
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
  }
}
