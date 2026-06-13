/**
 * `RefreshSemanticDocsActivity` — registered Temporal activity name `refresh_semantic_docs_activity`
 * (Sprint 26 / B-3, with the R-7/R-17/R-36/R-38/R-49 multi-lens audit fixes 2026-05-22).
 *
 * Bound-method holder composing `discoverKnowledgeDocs`, `chunkMarkdown`, `embedDocChunks` under one
 * activity boundary so the workflow body stays thin (one activity call + retry policy).
 *
 * ## Path Y (clone-first) — workspace-path input
 *
 * The workflow body invokes `clone_repository_activity` FIRST, then passes the workspace path here.
 * This activity reads the repo's knowledge docs from the LOCAL FILESYSTEM (via `discoverKnowledgeDocs`
 * + `node:fs`), matching the established `compute_policy_rules` activity.
 *
 * ## R-5 ORPHAN-SWEEP EMPTY-CHUNKS GUARD
 *
 * The load-bearing safety check lives in {@link embedDocChunks} Pass 3 (an empty `chunks` set skips the
 * orphan-sweep so a zero-doc fetch NEVER wipes the repo's existing index). A zero-doc discovery here
 * (empty `docs/`, bad custom pattern, clone race) flows into `embedDocChunks` with `chunks=[]` and the
 * prior index is preserved. The integration test proves it.
 *
 * ## Failure modes (per the program plan §B-3)
 *   - Embed service unreachable / rate-limited → returns `retrieval_degraded=True` with the matching
 *     `degradation_reason`; the prior index is unchanged.
 *   - Workspace read failure on a doc → skip + continue.
 *
 * ## Typed-input envelope (CLAUDE.md invariant 11 / ADR-0047)
 *
 * The single positional input is {@link RefreshSemanticDocsInputV1}. Additional fields
 * (`workspacePath`, `customKnowledgePaths`) are carried in the typed args object so the holder method
 * stays a single-arg surface for the worker registration the INTEGRATOR wires.
 *
 * ## Runtime context
 *
 * Runs in the NORMAL Node runtime (NOT the workflow V8-isolate sandbox), so real `node:fs` reads + DB +
 * embed-service I/O are fine.
 *
 * ## Metrics divergence
 *
 * The `semantic_docs_metrics` OTel histogram is NOT yet ported, so the metric EMIT is omitted; the
 * `duration_ms` CONTRACT field is still computed via the injected {@link Clock} (`monotonic()` deltas).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { embedDocChunks } from "#backend/activities/embed_doc_chunks.js";
import {
  EmbeddingsConnectivityError,
  type EmbeddingsPort,
  EmbeddingsRateLimitedError,
} from "#backend/adapters/embeddings_port.js";
import { chunkMarkdown } from "#backend/chunking/markdown_chunker.js";
import type { KnowledgeChunkRepoPort } from "#backend/domain/repos/knowledge_chunks_repo.js";
import { chunkKeyToStr } from "#backend/domain/repos/knowledge_chunks_repo.js";
import { discoverKnowledgeDocs } from "#backend/policy/discover_knowledge_docs.js";

import type { MarkdownChunkV1 } from "#contracts/markdown_chunk.v1.js";
import {
  type RefreshSemanticDocsInputV1,
  RefreshSemanticDocsResultV1,
} from "#contracts/refresh_semantic_docs.v1.js";

import { type Clock, WallClock } from "#platform/clock.js";

/** Typed single-arg envelope for the activity. */
export type RefreshSemanticDocsArgs = {
  readonly input: RefreshSemanticDocsInputV1;
  readonly workspacePath: string;
  /**
   * Additive patterns from `.codemaster.yaml::knowledge.custom_knowledge_paths` (A-7). Empty by default
   * for v1 (the workflow body passes `[]`; B-5's ramp wires customer override).
   */
  readonly customKnowledgePaths?: ReadonlyArray<string>;
};

/** Options for the {@link RefreshSemanticDocsActivity} constructor. */
export type RefreshSemanticDocsActivityOptions = {
  embeddings: EmbeddingsPort;
  chunkRepo: KnowledgeChunkRepoPort;
  modelName: string;
  clock?: Clock;
};

/** Bound-method holder for `refresh_semantic_docs_activity`. */
export class RefreshSemanticDocsActivity {
  readonly #embeddings: EmbeddingsPort;
  readonly #chunkRepo: KnowledgeChunkRepoPort;
  readonly #modelName: string;
  readonly #clock: Clock;

  public constructor(opts: RefreshSemanticDocsActivityOptions) {
    this.#embeddings = opts.embeddings;
    this.#chunkRepo = opts.chunkRepo;
    this.#modelName = opts.modelName;
    // R-7 Clock injection (replaces the former inline monotonic-clock calls).
    this.#clock = opts.clock ?? new WallClock();
  }

  /**
   * Build the embed-service-degraded result (DRY helper). The two embed-failure branches differ only in
   * `degradationReason`.
   */
  #degradedResult(args: {
    start: number;
    docsDiscovered: number;
    degradationReason: string;
  }): RefreshSemanticDocsResultV1 {
    const durationMs = Math.trunc((this.#clock.monotonic() - args.start) * 1000);
    return RefreshSemanticDocsResultV1.parse({
      schema_version: 1,
      docs_discovered: args.docsDiscovered,
      chunks_persisted: 0,
      chunks_skipped_oversize: 0,
      retrieval_degraded: true,
      degradation_reason: args.degradationReason,
      duration_ms: durationMs,
    });
  }

  /**
   * Discover knowledge docs in `workspacePath`, chunk + embed them into `core.knowledge_chunks`.
   */
  public async refreshSemanticDocs(
    args: RefreshSemanticDocsArgs,
  ): Promise<RefreshSemanticDocsResultV1> {
    const { input, workspacePath } = args;
    const customKnowledgePaths = args.customKnowledgePaths ?? [];
    const start = this.#clock.monotonic();

    // Step 1: discover_knowledge_docs (guideline-aware).
    const discovered = discoverKnowledgeDocs({ workspace: workspacePath, customKnowledgePaths });
    const docsDiscovered = discovered.docs.length;

    // Step 2: chunk every discovered doc. R-17 — each file read is async (`node:fs/promises.readFile`)
    // so the event loop yields between files and peer activities make progress.
    const allChunks: Array<MarkdownChunkV1> = [];
    const chunkHashes = new Map<string, string>();
    for (const doc of discovered.docs) {
      const filePath = join(workspacePath, doc.relative_path);
      let body: string;
      try {
        body = await readFile(filePath, { encoding: "utf-8" });
      } catch {
        // Doc unreadable — skip + continue.
        continue;
      }
      const chunks = chunkMarkdown({ relative_path: doc.relative_path, body });
      for (const c of chunks) {
        allChunks.push(c);
        chunkHashes.set(chunkKeyToStr(c.relative_path, c.chunk_index), hashText(c.body));
      }
    }

    // Step 3: embed + upsert. Returns degradation signal on embed-service failure (R-38). The R-5
    // empty-chunks orphan-sweep guard lives INSIDE embedDocChunks.
    let embedResult;
    try {
      embedResult = await embedDocChunks({
        installationId: input.installation_id,
        repoId: input.repository_id,
        chunks: allChunks,
        chunkHashes,
        embeddings: this.#embeddings,
        chunkRepo: this.#chunkRepo,
        modelName: this.#modelName,
      });
    } catch (e) {
      if (e instanceof EmbeddingsConnectivityError) {
        return this.#degradedResult({
          start,
          docsDiscovered,
          degradationReason: "embed_service_unreachable",
        });
      }
      if (e instanceof EmbeddingsRateLimitedError) {
        return this.#degradedResult({
          start,
          docsDiscovered,
          degradationReason: "embed_service_rate_limited",
        });
      }
      throw e;
    }

    const durationMs = Math.trunc((this.#clock.monotonic() - start) * 1000);
    return RefreshSemanticDocsResultV1.parse({
      schema_version: 1,
      docs_discovered: docsDiscovered,
      chunks_persisted: embedResult.embedded,
      chunks_skipped_oversize: 0,
      retrieval_degraded: false,
      degradation_reason: null,
      duration_ms: durationMs,
    });
  }

  /** Exposed for the clock dependency (kept reachable). */
  public clock(): Clock {
    return this.#clock;
  }
}

/**
 * sha256 hex digest of `text`. Deterministic hashing via `node:crypto` — NOT a randomness seam; the
 * clock/random gate permits `node:crypto` hashing in an activity.
 */
function hashText(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex");
}
