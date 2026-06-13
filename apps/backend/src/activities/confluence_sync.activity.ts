/**
 * `ConfluenceSyncActivities` (Sub-spec A T11) — bound-method holder for the 6 Confluence sync
 * activities the ConfluenceIngestWorkflow composes:
 *   1. fetch_space_pages_activity   — cursor-paginate a space → all PageRefs.
 *   2. fetch_page_body_activity     — fetch one page body + metadata.
 *   3. sanitize_page_activity       — sanitize HTML + macros + detect injection patterns (PURE — no I/O).
 *   4. chunk_and_embed_activity     — chunk + redact + embed (audit P0-4: idempotency check before Bedrock).
 *   5. upsert_chunks_activity       — approvals JOIN + hard limits + quarantine recompute → repo upsert.
 *   6. reconcile_deletions_activity — soft-delete chunks for pages absent from the live space.
 *
 * Runtime context: activities run in the NORMAL Node runtime (NOT the workflow V8-isolate sandbox), so
 * real I/O is fine. The constructor is called ONCE at worker lifespan time (Stage 8) with all
 * collaborators injected; Stage 8 registers each bound method under its snake_case Temporal name (see
 * the `*_activity` names in the JSDoc above).
 *
 * ## Injected seams (NARROW ports, not the concrete classes)
 *
 * Injects NARROW structural ports — the exact slice each method needs — so the holder is
 * unit-testable with stubs (no Temporal, no DB) and Stage 8 wires the real {@link ConfluenceClient}
 * + {@link PostgresConfluenceChunksRepo} + {@link PostgresConfluencePageApprovalsRepo} by structural
 * match.
 *
 * ## Divergences
 *
 *  - **Idempotency lookup / writer / approvals are PORTS, not a session factory.** The TS repos are
 *    CLASS instances bound to a process-shared Kysely (ADR-0062); this holder takes them as narrow
 *    ports directly. The transaction/commit lives INSIDE `PostgresConfluenceChunksRepo.upsertChunks`.
 *
 *  - **Hard-limit count/sum are PURE.** `hard_limits.ts` are PURE predicates over chunk-row
 *    projections (see that module's header). This holder owns ONE narrow reader
 *    ({@link ExistingChunkRowsReader}) that fetches the candidate rows (active default-tagged chunks)
 *    and feeds them to {@link countDefaultChunksInSpace} / {@link sumDefaultCorpusTokens} — split
 *    across a fetch + a pure filter. The reader query carries the `// tenant:exempt` marker (the
 *    confluence tables are platform-wide post-migration-0063 → NOT tenant-scoped).
 *
 *  - **`get_default_corpus_limits()` is synchronous** (inlines spec-pinned fallbacks per ADR-0075).
 *
 *  - **EmbedderCache dual-write is NOW wired (SCOPE-A).** When an `embedderCache` collaborator is injected,
 *    `upsertChunks` resolves the active generation + model from it (awaiting one lazy-TTL `refresh()` so a
 *    config_version bump propagates) and passes `{ activeGeneration, activeModelName }` to the repo, which
 *    dual-writes each vector to `core.chunk_embeddings` under the active generation IN ADDITION to the
 *    legacy `core.confluence_chunks.embedding` column. When `embedderCache` is undefined (test holders
 *    that don't wire it), the legacy-only write is preserved (the repo skips the dual-write). This is
 *    SAFE-DEFAULT: the dual-write only POPULATES `chunk_embeddings`; it does not change what retrieval
 *    reads until an operator flips `retrieval_mode` to 'generation_only'. The cache is the SAME
 *    DSN-memoized singleton the confluence retrieval adapter shares.
 *
 *  - **No `activity.heartbeat` / `activity.info().heartbeat_details`.** The prior `fetch_space_pages`
 *    emitted a heartbeat per cursor round-trip (F-41) and resumed from heartbeat details on retry. The
 *    Temporal-context-bound heartbeat seam is shared-wiring (Stage 8); this port enumerates the full
 *    space in one pass and is replay-safe (no clock/random). Tracked FOLLOW-UP-confluence-fetch-heartbeat.
 */

import {
  type EmbeddingsPort,
  type EmbedRequest,
  EmbeddingsValidationError,
} from "#backend/adapters/embeddings_port.js";
import { recordChunkEmbedSkipped } from "#backend/observability/confluence_ingest_metrics.js";

import { chunkSanitizedBody } from "#backend/ingest/confluence/chunker.js";
import { contentSha256 } from "#backend/ingest/confluence/chunker.js";
import {
  type ConfluenceChunkRow,
  countDefaultChunksInSpace,
  getDefaultCorpusLimits,
  sumDefaultCorpusTokens,
} from "#backend/ingest/confluence/hard_limits.js";
import { redactChunk } from "#backend/ingest/confluence/redactor.js";
import { sanitizePage } from "#backend/ingest/confluence/sanitizer.js";

import { type UpsertChunkRow } from "#backend/domain/repos/confluence_chunks_repo.js";
import { makeChunkId } from "#backend/domain/repos/confluence_chunks_repo.js";

import { PLATFORM_EXPOSED_LABELS } from "#backend/retrieval/platform_labels.js";

import { getPool } from "#platform/db/database.js";

import {
  ChunkAndEmbedInputV1,
  type ChunkAndEmbedOutputV1,
  type ConfluencePageV1,
  FetchPageBodyInputV1,
  type FetchPageBodyOutputV1,
  FetchSpacePagesInputV1,
  type FetchSpacePagesOutputV1,
  type PageRef,
  ReconcileDeletionsInputV1,
  type ReconcileDeletionsOutputV1,
  SanitizePageInputV1,
  type SanitizePageOutputV1,
  UpsertChunksInputV1,
  type UpsertChunksOutputV1,
} from "#contracts/confluence_sync.v1.js";
import { DefaultApprovalV1 } from "#contracts/page_approval.v1.js";

// ─── Constants ───────────────────────────────────────────────────────────────────────────────────

/** Maximum texts per embed call (EmbedRequest.texts max_length=128 → MAX_TEXTS). */
const EMBED_BATCH_SIZE = 128;
/** Floor below which we stop halving an oversized chunk and skip it. */
const MIN_EMBED_CHARS = 256;
/** Purpose label routing Confluence chunk embeds through the correct metering bucket. */
const EMBED_PURPOSE = "confluence_chunk";

// ─── Narrow injected ports (the exact slice each method needs) ───────────────────────────────────

/** The Confluence list/get slice {@link ConfluenceClient} satisfies structurally. */
export type ConfluenceChunkClient = {
  listPages(args: {
    spaceKey: string;
    cursor?: string | null;
  }): Promise<{
    items: ReadonlyArray<{ page_id: string; version: number }>;
    next_cursor: string | null;
  }>;
  getPage(args: { pageId: string; spaceKey?: string | null }): Promise<unknown>;
};

/** The idempotency-lookup slice {@link PostgresConfluenceChunksRepo} satisfies (audit P0-4). */
export type ChunkEmbeddingLookup = {
  findExistingChunkEmbedding(args: {
    chunkId: string;
    contentSha256: string;
  }): Promise<ReadonlyArray<number> | null>;
};

/** The write slice {@link PostgresConfluenceChunksRepo} satisfies (upsert + reconcile soft-delete). */
export type ConfluenceChunksWriter = {
  upsertChunks(
    rows: ReadonlyArray<UpsertChunkRow>,
    opts?: { activeGeneration?: number | null; activeModelName?: string | null },
  ): Promise<number>;
  reconcileDeletions(args: {
    spaceKey: string;
    livePageIds: ReadonlyArray<string>;
  }): Promise<number>;
};

/** The approval-read slice {@link PostgresConfluencePageApprovalsRepo} satisfies. */
export type PageApprovalsReader = {
  getActiveApproval(args: {
    spaceKey: string;
    pageId: string;
  }): Promise<DefaultApprovalV1 | null>;
};

/**
 * Reader that fetches the candidate rows the PURE hard-limit predicates inspect: the active
 * default-tagged chunks (per-space count + platform-wide token sum), split into a fetch + the pure
 * filter ({@link countDefaultChunksInSpace} / {@link sumDefaultCorpusTokens}).
 */
export type ExistingChunkRowsReader = {
  /**
   * Return the active (deleted_at IS NULL), default-tagged chunk rows the limit predicates need. The
   * impl narrows to the `default`-labeled active rows in SQL (the only rows the predicates count); the
   * pure helpers re-apply the same predicate defensively.
   */
  listChunkRowsForLimits(): Promise<ReadonlyArray<ConfluenceChunkRow>>;
};

/**
 * The dual-write slice the {@link PostgresEmbedderCache} façade satisfies: resolve the active embedding
 * generation + model so the upsert can dual-write to `core.chunk_embeddings`. `refresh()` drives one
 * lazy-TTL refresh so a config_version bump (operator activating a new generation) propagates before the
 * sync reads. OPTIONAL — when undefined, the upsert writes ONLY the legacy embedding column (SAFE-DEFAULT).
 */
export type EmbedderCacheForDualWrite = {
  getActiveGeneration(): number;
  getActiveModelName(): string;
  refresh(): Promise<void>;
};

export type ConfluenceSyncActivitiesOptions = {
  client: ConfluenceChunkClient;
  embeddings: EmbeddingsPort;
  modelName: string;
  chunkEmbeddingLookup: ChunkEmbeddingLookup;
  chunksWriter: ConfluenceChunksWriter;
  approvalsReader: PageApprovalsReader;
  existingChunkRowsReader: ExistingChunkRowsReader;
  /** SCOPE-A dual-write: when wired, upsert dual-writes to `core.chunk_embeddings` (else legacy-only). */
  embedderCache?: EmbedderCacheForDualWrite;
};

/** One embed candidate: the chunk index, the wrapped body, and its content hash. */
type NeedsEmbed = { chunkIndex: number; wrappedBody: string; sha: string };

/** Bound-method holder for the 6 Confluence sync activities. */
export class ConfluenceSyncActivities {
  private readonly client: ConfluenceChunkClient;
  private readonly embeddings: EmbeddingsPort;
  private readonly modelName: string;
  private readonly lookup: ChunkEmbeddingLookup;
  private readonly writer: ConfluenceChunksWriter;
  private readonly approvals: PageApprovalsReader;
  private readonly existingRows: ExistingChunkRowsReader;
  private readonly embedderCache: EmbedderCacheForDualWrite | undefined;

  public constructor(opts: ConfluenceSyncActivitiesOptions) {
    this.client = opts.client;
    this.embeddings = opts.embeddings;
    this.modelName = opts.modelName;
    this.lookup = opts.chunkEmbeddingLookup;
    this.writer = opts.chunksWriter;
    this.approvals = opts.approvalsReader;
    this.existingRows = opts.existingChunkRowsReader;
    this.embedderCache = opts.embedderCache;
  }

  // ── Activity 1: list all pages in a space (cursor pagination) ──────────────────────────────────

  /** `fetch_space_pages_activity` — cursor-paginate the space → all PageRefs. */
  public async fetchSpacePages(input: FetchSpacePagesInputV1): Promise<FetchSpacePagesOutputV1> {
    const parsed = FetchSpacePagesInputV1.parse(input);
    const refs: Array<PageRef> = [];
    let cursor: string | null = null;
    for (;;) {
      const pageList = await this.client.listPages({ spaceKey: parsed.space_key, cursor });
      for (const summary of pageList.items) {
        refs.push({
          schema_version: 1,
          page_id: summary.page_id,
          space_key: parsed.space_key,
          version: summary.version,
        });
      }
      if (pageList.next_cursor === null || pageList.next_cursor === "") {
        break;
      }
      cursor = pageList.next_cursor;
    }
    return { schema_version: 1, pages: refs };
  }

  // ── Activity 2: fetch one page's body + metadata ───────────────────────────────────────────────

  /** `fetch_page_body_activity` — fetch one page body + metadata from Confluence. */
  public async fetchPageBody(input: FetchPageBodyInputV1): Promise<FetchPageBodyOutputV1> {
    const parsed = FetchPageBodyInputV1.parse(input);
    const pageRaw = await this.client.getPage({
      pageId: parsed.page_id,
      spaceKey: parsed.space_key,
    });
    // The client returns the parsed ConfluencePageV1 shape; re-validate at the activity boundary.
    return { schema_version: 1, page: pageRaw as ConfluencePageV1 };
  }

  // ── Activity 3: sanitize HTML + detect injection patterns (PURE) ───────────────────────────────

  /**
   * `sanitize_page_activity` — sanitize HTML + macros + detect injection patterns. Pure (no network,
   * no DB). The sanitizer returns the body WITHOUT the trust wrapper per ADR-0057 — the redactor adds
   * it downstream in `chunk_and_embed`.
   */
  public async sanitizePage(input: SanitizePageInputV1): Promise<SanitizePageOutputV1> {
    const parsed = SanitizePageInputV1.parse(input);
    const sanitized = sanitizePage(parsed.page, {
      lastModifiedAt: new Date(parsed.last_modified_at),
    });
    return { schema_version: 1, sanitized };
  }

  // ── Activity 4: chunk sanitized body + redact + embed (audit P0-4 idempotency) ─────────────────

  /**
   * `chunk_and_embed_activity` — chunk the sanitized body, redact each chunk, embed via the embeddings
   * port.
   *
   * Audit P0-4: check existing (chunk_id, content_sha256) BEFORE calling the embedder. On a Temporal
   * retry, identical chunks reuse the stored embedding — zero double-billing, no embedding drift across
   * attempts. `chunk_id` is deterministic (uuid5 of space_key + page_id + version + chunk_index — F-36)
   * so retries map to the same DB row.
   *
   * Chain: sanitize_page → redact_chunk per ADR-0057. The redactor wraps each chunk body in
   * `<doc trust="untrusted">…</doc>` BEFORE the content hash, so the persisted body + hash both carry
   * the wrapper.
   */
  public async chunkAndEmbed(input: ChunkAndEmbedInputV1): Promise<ChunkAndEmbedOutputV1> {
    const parsed = ChunkAndEmbedInputV1.parse(input);
    const sanitized = parsed.sanitized;

    // Step 1: produce ChunkV1 atoms from the sanitized body.
    const chunks = chunkSanitizedBody({
      body: sanitized.body,
      pageTitle: sanitized.title,
      headingPath: [sanitized.title],
    });

    if (chunks.length === 0) {
      return { schema_version: 1, chunks: [] };
    }

    const out: Array<ChunkAndEmbedOutputV1["chunks"][number]> = [];
    const needsEmbed: Array<NeedsEmbed> = [];

    // Step 2: redact each chunk + idempotency lookup.
    for (const chunk of chunks) {
      // Redactor adds the <doc trust="untrusted"> wrapper.
      const wrappedBody = redactChunk(chunk.body).text;
      const sha = contentSha256(wrappedBody);
      // F-36: version is part of the chunk_id seed.
      const chunkId = makeChunkId({
        spaceKey: sanitized.space_key,
        pageId: sanitized.page_id,
        version: sanitized.version,
        chunkIndex: chunk.chunk_index,
      });
      const existing = await this.lookup.findExistingChunkEmbedding({
        chunkId,
        contentSha256: sha,
      });
      if (existing !== null) {
        // Audit P0-4 cache hit — reuse the stored embedding.
        out.push({
          schema_version: 1,
          chunk_id: chunkId,
          chunk_index: chunk.chunk_index,
          body: wrappedBody,
          content_sha256: sha,
          heading_path: [...chunk.heading_path],
          token_count: chunk.token_count,
          embedding: [...existing],
          bedrock_reused_from_cache: true,
        });
      } else {
        needsEmbed.push({ chunkIndex: chunk.chunk_index, wrappedBody, sha });
      }
    }

    // Step 3: batch-embed the cache misses (max 128 per request).
    if (needsEmbed.length > 0) {
      const chunkByIndex = new Map(chunks.map((c) => [c.chunk_index, c]));
      for (let start = 0; start < needsEmbed.length; start += EMBED_BATCH_SIZE) {
        const batch = needsEmbed.slice(start, start + EMBED_BATCH_SIZE);
        const embedded = await this.embedBatchResilient(batch, sanitized.page_id);
        for (const { item, vector } of embedded) {
          const chunkId = makeChunkId({
            spaceKey: sanitized.space_key,
            pageId: sanitized.page_id,
            version: sanitized.version,
            chunkIndex: item.chunkIndex,
          });
          const source = chunkByIndex.get(item.chunkIndex)!;
          out.push({
            schema_version: 1,
            chunk_id: chunkId,
            chunk_index: item.chunkIndex,
            body: item.wrappedBody,
            content_sha256: item.sha,
            heading_path: [...source.heading_path],
            token_count: source.token_count,
            embedding: vector,
            bedrock_reused_from_cache: false,
          });
        }
      }
    }

    // Return in stable chunk_index order.
    out.sort((a, b) => a.chunk_index - b.chunk_index);
    return { schema_version: 1, chunks: out };
  }

  /**
   * Embed a batch of needs-embed items. Falls back to per-text truncating embed on
   * {@link EmbeddingsValidationError} so a single chunk that exceeds the embedder's context window is
   * SKIPPED rather than aborting the whole corpus sync. Returns `(item, vector)` for the texts that
   * embedded; skipped texts are omitted. RM9 observability: every skip increments
   * `codemaster_confluence_chunk_embed_skipped_total` and WARN-logs `page_id` + `chunk_index`.
   *
   * DECISION (RM9, explicit): a page that loses chunks still upserts the SURVIVORS — availability
   * over completeness for corpus ingest. A retry cannot fix an embedder context-window rejection
   * (the input is what it is), so failing/flagging the whole page would only convert a partial
   * index into NO index; the counter + log make the gap alertable instead of silent.
   */
  private async embedBatchResilient(
    batch: ReadonlyArray<NeedsEmbed>,
    pageId: string,
  ): Promise<Array<{ item: NeedsEmbed; vector: Array<number> }>> {
    const texts = batch.map((item) => item.wrappedBody);
    try {
      const req: EmbedRequest = { texts, model_name: this.modelName, purpose: EMBED_PURPOSE };
      const result = await this.embeddings.embed(req);
      // The embedder MUST return exactly one
      // vector per text. No contract validates `vectors.length === texts.length`, so this is the SOLE guard
      // against a drifting embedder silently mis-mapping vectors to chunks (over-count) or producing a vague
      // `[...undefined]` TypeError (under-count).
      if (result.vectors.length !== batch.length) {
        throw new Error(`embed returned ${result.vectors.length} vectors for ${batch.length} texts`);
      }
      // `i` is a bounded numeric map index into the now-length-checked `vectors`
      // (vectors.length === texts.length === batch.length) — not an attacker-controlled object key.
      // eslint-disable-next-line security/detect-object-injection -- bounded numeric index into a same-length array
      return batch.map((item, i) => ({ item, vector: [...result.vectors[i]!] }));
    } catch (e) {
      if (!(e instanceof EmbeddingsValidationError)) {
        throw e;
      }
      // Per-text truncating fallback.
    }
    const out: Array<{ item: NeedsEmbed; vector: Array<number> }> = [];
    for (const item of batch) {
      const vector = await this.embedOneTruncating(item.wrappedBody);
      if (vector === null) {
        // Skipped — embedder still rejects below the 256-char floor. COUNT + LOG (RM9): the chunk
        // is omitted from the upsert, and that omission must be observable, not silent.
        recordChunkEmbedSkipped(1);
        console.warn(
          JSON.stringify({
            event: "confluence.chunk_embed_skipped",
            page_id: pageId,
            chunk_index: item.chunkIndex,
          }),
        );
        continue;
      }
      out.push({ item, vector });
    }
    return out;
  }

  /**
   * Embed a single text, halving it on {@link EmbeddingsValidationError} until it fits the embedder's
   * context window (or giving up below 256 chars → null). The retrieval embedding of a truncated prefix
   * still represents the chunk's topic; the FULL body is stored + shown to the LLM, so grounding is
   * unaffected.
   */
  private async embedOneTruncating(text: string): Promise<Array<number> | null> {
    let candidate = text;
    for (;;) {
      try {
        const req: EmbedRequest = {
          texts: [candidate],
          model_name: this.modelName,
          purpose: EMBED_PURPOSE,
        };
        const r = await this.embeddings.embed(req);
        return [...r.vectors[0]!];
      } catch (e) {
        if (!(e instanceof EmbeddingsValidationError)) {
          throw e;
        }
        if (candidate.length <= MIN_EMBED_CHARS) {
          return null;
        }
        candidate = candidate.slice(0, Math.floor(candidate.length / 2));
      }
    }
  }

  // ── Activity 5: upsert chunks with governance ──────────────────────────────────────────────────

  /**
   * `upsert_chunks_activity` — upsert chunks with hard-limit governance + page-approvals JOIN +
   * quarantine recompute.
   *
   *   P0-1/P0-2: resolve the active page approval; reject default-tagged chunks without one.
   *   Hard limits: atomic refusal of default-tagged additions when the per-space chunk cap or the
   *     platform-wide token cap would be exceeded.
   *   Quarantine: recomputed every sync pass from the fresh injection_flags (quarantined ↔ reasons>0).
   *   F-48: intersect raw_labels with PLATFORM_EXPOSED_LABELS BEFORE the default-corpus decision, so an
   *     arbitrary Confluence editor cannot drive corpus inclusion with a bare "default" string.
   */
  public async upsertChunks(input: UpsertChunksInputV1): Promise<UpsertChunksOutputV1> {
    const parsed = UpsertChunksInputV1.parse(input);

    // F-48: only platform-curated label values can drive the default-corpus inclusion decision.
    const effectiveLabels = new Set(parsed.raw_labels.filter((l) => PLATFORM_EXPOSED_LABELS.has(l)));
    const hasDefaultLabel = effectiveLabels.has("default");
    const quarantined = parsed.injection_flags.length > 0;
    const quarantineReasons = [...parsed.injection_flags].sort();

    let defaultApproval: DefaultApprovalV1 | null = null;

    if (hasDefaultLabel) {
      const limits = getDefaultCorpusLimits();
      const rows = await this.existingRows.listChunkRowsForLimits();

      // Hard-limit check 1: per-space chunk count.
      const existingInSpace = countDefaultChunksInSpace(rows, parsed.space_key);
      if (existingInSpace + parsed.chunks.length > limits.max_chunks_per_space) {
        return {
          schema_version: 1,
          upserted: 0,
          rejected_default_cap: parsed.chunks.length,
          rejected_no_approval: 0,
          quarantined,
        };
      }

      // Hard-limit check 2: platform-wide token cap.
      const currentTokens = sumDefaultCorpusTokens(rows);
      const newTokens = parsed.chunks.reduce((acc, c) => acc + c.token_count, 0);
      if (currentTokens + newTokens > limits.max_corpus_tokens) {
        return {
          schema_version: 1,
          upserted: 0,
          rejected_default_cap: parsed.chunks.length,
          rejected_no_approval: 0,
          quarantined,
        };
      }

      // Page-approvals JOIN: a default-tagged page requires an active approval row.
      const approval = await this.approvals.getActiveApproval({
        spaceKey: parsed.space_key,
        pageId: parsed.page_id,
      });
      if (approval === null) {
        return {
          schema_version: 1,
          upserted: 0,
          rejected_default_cap: 0,
          rejected_no_approval: parsed.chunks.length,
          quarantined,
        };
      }
      // PROJECT to the 5-field DefaultApprovalV1 the column stores — NOT the full ConfluencePageApprovalV1
      // the repo returns. The narrow PageApprovalsReader port is typed DefaultApprovalV1, but TS structural
      // subtyping lets the wired repo's 12-field row satisfy it at runtime — so we re-project explicitly to
      // keep core.confluence_chunks.default_approval JSONB at exactly the 6 keys (.strict()/extra=forbid)
      // and never leak approval_id/space_key/page_id/revoked_at/revoked_by/created_at/updated_at to disk.
      defaultApproval = DefaultApprovalV1.parse({
        schema_version: 1,
        approver_email: approval.approver_email,
        approved_at_utc: approval.approved_at_utc,
        approval_artifact_url: approval.approval_artifact_url,
        scope_justification: approval.scope_justification,
        default_scope: approval.default_scope,
      });
    }

    // Build repo rows and upsert. When the EmbedderCache is wired (SCOPE-A) we resolve the active
    // generation + model and dual-write to core.chunk_embeddings IN ADDITION to the legacy embedding
    // column; when it's absent the repo writes ONLY the legacy column (SAFE-DEFAULT).
    const rows: Array<UpsertChunkRow> = parsed.chunks.map((chunk) => ({
      chunkId: chunk.chunk_id,
      spaceKey: parsed.space_key,
      pageId: parsed.page_id,
      pageTitle: parsed.page_title,
      version: parsed.page_version,
      chunkIndex: chunk.chunk_index,
      body: chunk.body,
      contentSha256: chunk.content_sha256,
      embedding: chunk.embedding,
      rawLabels: parsed.raw_labels,
      quarantined,
      quarantineReasons,
      pageStatus: parsed.page_status,
      lastModifiedAt: new Date(parsed.last_modified_at),
      tokenCount: chunk.token_count,
      defaultApproval,
      redactionApplied: true, // the redactor ran in chunk_and_embed_activity
    }));

    // SCOPE-A dual-write: resolve the active generation + model from the EmbedderCache (awaiting one
    // lazy-TTL refresh so a config_version bump propagates). When the cache is absent, leave both
    // undefined → the repo writes ONLY the legacy embedding column (SAFE-DEFAULT, byte-identical to before).
    let dualWriteOpts: { activeGeneration?: number; activeModelName?: string } = {};
    if (this.embedderCache !== undefined) {
      await this.embedderCache.refresh();
      dualWriteOpts = {
        activeGeneration: this.embedderCache.getActiveGeneration(),
        activeModelName: this.embedderCache.getActiveModelName(),
      };
    }

    const upserted = await this.writer.upsertChunks(rows, dualWriteOpts);

    return {
      schema_version: 1,
      upserted,
      rejected_default_cap: 0,
      rejected_no_approval: 0,
      quarantined,
    };
  }

  // ── Activity 6: soft-delete chunks for pages no longer in the space ────────────────────────────

  /**
   * `reconcile_deletions_activity` — soft-delete chunks for pages that disappeared from the live space.
   * Pages observed during this sync pass are safe; any page NOT in `live_page_ids` gets its chunks
   * marked `deleted_at = now()`. Delegates to the repo (which owns the raw SQL + clock).
   */
  public async reconcileDeletions(
    input: ReconcileDeletionsInputV1,
  ): Promise<ReconcileDeletionsOutputV1> {
    const parsed = ReconcileDeletionsInputV1.parse(input);
    const softDeleted = await this.writer.reconcileDeletions({
      spaceKey: parsed.space_key,
      livePageIds: parsed.live_page_ids,
    });
    return { schema_version: 1, soft_deleted: softDeleted };
  }
}

// ─── Production existing-rows reader (the hard-limit candidate-row fetcher) ───────────────────────

/**
 * Pool-backed {@link ExistingChunkRowsReader}: fetches the active, default-tagged chunk rows the PURE
 * hard-limit predicates inspect (`'default' = ANY(labels) AND deleted_at IS NULL`), projecting only the
 * columns the predicates need (space_key, labels, deleted_at, token_count). The pure helpers re-apply
 * the predicate defensively, so narrowing here is purely an efficiency bound. `deleted_at` is always
 * NULL in the projected rows (the WHERE filters it), so it is bound to `null` in the row shape.
 *
 * Resolves the shared ADR-0062 pool from the injected `dsn` (default `CODEMASTER_PG_CORE_DSN`). Stage 8
 * wires one instance into the {@link ConfluenceSyncActivities} constructor.
 */
export class PoolExistingChunkRowsReader implements ExistingChunkRowsReader {
  private readonly explicitDsn: string | undefined;

  public constructor(opts: { dsn?: string } = {}) {
    this.explicitDsn = opts.dsn;
  }

  private resolveDsn(): string {
    if (this.explicitDsn !== undefined && this.explicitDsn !== "") {
      return this.explicitDsn;
    }
    const dsn = process.env.CODEMASTER_PG_CORE_DSN;
    if (dsn === undefined || dsn === "") {
      throw new Error("CODEMASTER_PG_CORE_DSN is not set; cannot read confluence chunk rows");
    }
    return dsn;
  }

  public async listChunkRowsForLimits(): Promise<ReadonlyArray<ConfluenceChunkRow>> {
    const pool = getPool(this.resolveDsn());
    // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
    const result = await pool.query<{ space_key: string; labels: Array<string>; token_count: number }>(
      `SELECT space_key, labels, token_count
       FROM   core.confluence_chunks
       WHERE  'default' = ANY(labels)
         AND  deleted_at IS NULL`,
    );
    return result.rows.map((r) => ({
      space_key: r.space_key,
      labels: r.labels,
      deleted_at: null,
      token_count: r.token_count,
    }));
  }
}
