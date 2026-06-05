// RetrieveKnowledgeActivity — port of the frozen Python
// vendor/codemaster-py/codemaster/activities/retrieve_knowledge.py::RetrieveKnowledgeActivity
// (Sprint 26 / PR-2 follow-up). This is the LEGACY (BM25 + ANN + RRF) path only.
//
// Composition (legacy path — the Python default when `hybrid_retriever is None`):
//   BM25 + ANN run in parallel under `Promise.all` (the TS analogue of `asyncio.gather`); RRF fuses to
//   `input.top_k`. Both retrievers over-fetch `PRE_FUSION_TOP_K` candidates so RRF has enough material
//   to fuse. Degradation on either side flows into the result envelope's `retrieval_degraded` flag.
//   The legacy path does NOT rerank.
//
// ── DEFERRED (faithful to the Python default; marker-gated OFF) ──────────────────────────────────
// The frozen Python `RetrieveKnowledgeActivity` ALSO carries a Sub-spec-B-T12 hybrid branch
// (`_should_use_hybrid` → `_retrieve_with_confluence`) that composes BM25 + ANN + Confluence via a
// `HybridRetriever`, applies reserve_priority_floors + merge_sources, AND runs an LLM rerank pass. That
// branch only fires when ALL of `include_confluence=True` + `pr_context` + `yaml_config` +
// `platform_exposed_labels` + `query_vector_override` are supplied AND a `hybrid_retriever` is wired —
// none of which is the default. The whole hybrid/Confluence path + the real LLM rerank are DEFERRED
// here (the Python default behaviour is the legacy path):
//   - FOLLOW-UP-retrieve-knowledge-hybrid-confluence  (HybridRetriever + PostgresConfluenceRetrieval)
//   - FOLLOW-UP-retrieve-knowledge-llm-rerank         (BedrockRerank port; the Python wires an
//                                                       IdentityRerankPort no-op until then)
// This port composes ONLY the legacy retriever, matching `hybrid_retriever=undefined` in the wiring.
//
// ── OTel span ──
// The Python wraps the BM25+ANN+RRF composition in the `retrieval.hybrid_retrieve` OTel span. That
// observability module is not ported yet, so this port keeps the composition intact but omits the
// (absent) span — exactly as the sibling AnnRetriever / Bm25Retriever ports omit their histograms.

import { PRE_FUSION_TOP_K } from "#backend/retrieval/constants.js";
import { rrfCombine } from "#backend/retrieval/rrf.js";

import type { AnnRetriever } from "#backend/retrieval/ann_retriever.js";
import type { Bm25Retriever } from "#backend/retrieval/bm25_retriever.js";
import type { KnowledgeChunkV1, KnowledgeQueryV1 } from "#contracts/knowledge_chunks.v1.js";
import type {
  RetrieveKnowledgeInputV1,
  RetrieveKnowledgeResultV1,
} from "#contracts/retrieve_knowledge.v1.js";

export type RetrieveKnowledgeActivityOptions = {
  bm25Retriever: Bm25Retriever;
  annRetriever: AnnRetriever;
  topK?: number;
};

/**
 * Bound-method holder for `retrieve_knowledge_activity` (legacy BM25 + ANN + RRF path).
 *
 * `topK` is the per-chunk retrieval result cap (default 5, 1:1 with the Python `top_k=5`); the input's
 * `top_k` overrides it per call. The hybrid/Confluence branch is DEFERRED (see the file header) — this
 * holder carries no `hybrid_retriever`, so it always runs the legacy fusion.
 */
export class RetrieveKnowledgeActivity {
  private readonly bm25: Bm25Retriever;
  private readonly ann: AnnRetriever;
  private readonly topK: number;

  public constructor({ bm25Retriever, annRetriever, topK = 5 }: RetrieveKnowledgeActivityOptions) {
    this.bm25 = bm25Retriever;
    this.ann = annRetriever;
    this.topK = topK;
  }

  /**
   * Run BM25 + ANN + RRF (legacy path). Both retrievers run in parallel under `Promise.all` so the
   * activity wall-clock is `max(bm25_latency, ann_latency)`, not the sum. Degradation on either side
   * flows into the result envelope's `retrieval_degraded` flag.
   *
   * The caller-supplied `query_vector_override` is threaded through the {@link KnowledgeQueryV1}
   * contract — when set, AnnRetriever skips its own embed RPC (R-11). The BM25 side ignores it (lexical
   * search has no vector input).
   */
  public async retrieveKnowledge(
    input: RetrieveKnowledgeInputV1,
  ): Promise<RetrieveKnowledgeResultV1> {
    // R-11: thread query_vector_override through the wide (pre-fusion) query so AnnRetriever can skip
    // its embed RPC. Both retrievers over-fetch PRE_FUSION_TOP_K candidates; RRF then cuts to top_k.
    const wideQuery: KnowledgeQueryV1 = {
      schema_version: 2,
      query: input.query,
      installation_id: input.installation_id,
      repo_id: input.repo_id,
      top_k: PRE_FUSION_TOP_K,
      query_vector_override: input.query_vector_override,
      include_confluence: false,
      effective_labels: [],
      default_pool_token_reservation_pct: 0.15,
    };

    // asyncio.gather → Promise.all: both sides run concurrently.
    const [bm25Result, annResult] = await Promise.all([
      this.bm25.retrieve(wideQuery),
      this.ann.retrieve(wideQuery),
    ]);

    const fused = rrfCombine([bm25Result, annResult], { topK: input.top_k });

    // Unwrap the fused ScoredKnowledgeChunkV1 items back to bare KnowledgeChunkV1 (the
    // RetrieveKnowledgeResultV1 type shape; the workflow body consumes bare chunks).
    const items: Array<KnowledgeChunkV1> = fused.items.map((item) => item.chunk);
    const degraded = fused.degraded;
    // rrfCombine.degradation_reason is already capped at 200 AND the result contract enforces
    // max_length=200; no double-trim (R-47).
    const reason = degraded ? fused.degradation_reason : "";

    return {
      schema_version: 1,
      items,
      retrieval_degraded: degraded,
      degradation_reason: reason,
    };
  }
}
