// AnnRetriever — port of the frozen Python
// vendor/codemaster-py/codemaster/retrieval/ann_retriever.py::AnnRetriever (Sprint 10 / S10.3.3).
//
// Dense retriever: embed the query (or use a caller-supplied override), delegate to an {@link AnnPort}
// (pgvector cosine in production), and wrap the hits in a {@link RetrievedKnowledgeV1} envelope.
//
// ── Override path (R-11 multi-lens audit) ──
// When the caller pre-computed the embedding (the workflow body memoizes by chunk path), the retriever
// SKIPS its own embed RPC and searches with the override vector directly. Cuts embed RPCs from ~100 per
// PR to ~N_unique_paths.
//
// ── Degradation (fail-open to BM25-only) ──
// When the embed service is unreachable / rate-limited, the retriever returns
// `RetrievedKnowledgeV1(items=[], degraded=true, degradation_reason=...)` so the hybrid orchestrator can
// fall back to BM25-only. Only EmbeddingsConnectivityError / EmbeddingsRateLimitedError are caught (the
// two transient-embed signals); any other error propagates.
//
// ── Clock seam (check_clock_random) ──
// The around-search duration is measured via an injected {@link Clock} `monotonic()` (the
// gate-sanctioned seam), NOT a raw `performance.now()`. WallClock() default keeps zero-arg compat. The
// frozen Python emits an OTel histogram here; that observability module is not ported yet, so this port
// keeps the timing seam intact but omits the (absent) metric emission.
//
// ── Purpose (W1.3 — RL-appendix embed-mode) ──
// HARDENING DIVERGENCE from the frozen Python: the Python used "review_query" here but "in_repo_doc"
// in embed_query.py — two different purposes for the SAME query, so a chunk whose memoized embed
// failed got a different query vector than its siblings. Both paths now share the ONE
// QUERY_EMBED_PURPOSE + the flag-gated Qwen query-instruction seam (retrieval/query_embed.ts).

import {
  type EmbeddingsPort,
  EmbeddingsConnectivityError,
  EmbeddingsRateLimitedError,
} from "#backend/adapters/embeddings_port.js";

import { type Clock, WallClock } from "#platform/clock.js";

import { MIN_COSINE_SIMILARITY_FLOOR } from "./constants.js";
import { buildQueryEmbedText, QUERY_EMBED_PURPOSE } from "./query_embed.js";

import type { AnnPort } from "./ann_port.js";
import type {
  KnowledgeQueryV1,
  RetrievedKnowledgeV1,
  ScoredKnowledgeChunkV1,
} from "#contracts/knowledge_chunks.v1.js";

export type AnnRetrieverOptions = {
  port: AnnPort;
  embeddings: EmbeddingsPort;
  modelName: string;
  clock?: Clock;
  /**
   * W1.3 (RH10) — minimum cosine-similarity floor threaded into every port search. Default
   * {@link MIN_COSINE_SIMILARITY_FLOOR}; the wiring resolves the `CODEMASTER_RETRIEVAL_MIN_SIMILARITY`
   * env knob into this option.
   */
  minSimilarity?: number;
};

/** Embed query, delegate to {@link AnnPort}, wrap in {@link RetrievedKnowledgeV1}. */
export class AnnRetriever {
  private readonly port: AnnPort;
  private readonly embeddings: EmbeddingsPort;
  private readonly modelName: string;
  private readonly clock: Clock;
  private readonly minSimilarity: number;

  public constructor({ port, embeddings, modelName, clock, minSimilarity }: AnnRetrieverOptions) {
    this.port = port;
    this.embeddings = embeddings;
    this.modelName = modelName;
    // Clock injection replaces the inline monotonic call that would violate the no-wall-clock gate;
    // WallClock() default keeps zero-arg compat (1:1 with the Python R-7 fix).
    this.clock = clock ?? new WallClock();
    this.minSimilarity = minSimilarity ?? MIN_COSINE_SIMILARITY_FLOOR;
  }

  public async retrieve(query: KnowledgeQueryV1): Promise<RetrievedKnowledgeV1> {
    let queryVector: ReadonlyArray<number>;
    // R-11: when the caller pre-computed the embedding, skip our own embed RPC.
    if (query.query_vector_override !== null) {
      queryVector = query.query_vector_override;
    } else {
      try {
        const result = await this.embeddings.embed({
          // W1.3: every QUERY embed routes through the shared seam (instruction prefix when flagged on).
          texts: [buildQueryEmbedText(query.query)],
          model_name: this.modelName,
          purpose: QUERY_EMBED_PURPOSE,
        });
        const first = result.vectors[0];
        queryVector = first === undefined ? [] : first;
      } catch (e) {
        if (e instanceof EmbeddingsConnectivityError) {
          return degraded("embed service unreachable");
        }
        if (e instanceof EmbeddingsRateLimitedError) {
          return degraded("embed service rate-limited");
        }
        throw e;
      }
    }

    // Time the search via the injected Clock (the gate-sanctioned monotonic seam).
    this.clock.monotonic();
    const hits = await this.port.search({
      installationId: query.installation_id,
      repoId: query.repo_id,
      queryVector,
      topK: query.top_k,
      // W1.3 (RH10): thread the configured minimum-similarity floor into the port.
      minSimilarity: this.minSimilarity,
    });
    this.clock.monotonic();

    const items: Array<ScoredKnowledgeChunkV1> = hits.map(([chunk, score]) => ({
      schema_version: 1,
      chunk,
      score,
      stage: "ann",
    }));
    return {
      schema_version: 1,
      items,
      degraded: false,
      degradation_reason: "",
      starvation_tiers: [],
      source_counts: {},
    };
  }
}

/** The degraded-empty envelope (1:1 with the Python fail-open path). */
function degraded(reason: string): RetrievedKnowledgeV1 {
  return {
    schema_version: 1,
    items: [],
    degraded: true,
    degradation_reason: reason,
    starvation_tiers: [],
    source_counts: {},
  };
}
