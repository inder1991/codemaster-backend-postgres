// rrfCombine — Reciprocal Rank Fusion: score-free combination of N ranked result lists. Each chunk's RRF score is
// the sum, over the retrievers it appeared in, of `1 / (k + rank)` where rank is 1-based. The fused
// score depends ONLY on rank position — raw retriever scores aren't comparable across BM25 and ANN, so
// RRF deliberately ignores them.
//
// The recipe-default `k = 60` (Cormack-Clarke-Buettcher 2009) softens the rank-1 vs rank-2 gap; a
// smaller k weights the very top results more aggressively.
//
// Output: a single {@link RetrievedKnowledgeV1} with stage="rrf", sorted by RRF score descending,
// deduped by chunk_id (the first-seen chunk object wins via the setdefault semantics). `degraded`
// propagates `true` if ANY input retriever was degraded — the orchestrator decides whether to surface
// a "retrieval may be partial" note.

import type {
  KnowledgeChunkV1,
  RetrievedKnowledgeV1,
  ScoredKnowledgeChunkV1,
} from "#contracts/knowledge_chunks.v1.js";

/** RRF smoothing constant; default 60 per the original Cormack-Clarke-Buettcher paper. */
export const RRF_K_DEFAULT = 60;

/** Max length of the joined degradation_reason (Python `"; ".join(reasons)[:200]`; contract caps 200). */
const DEGRADATION_REASON_MAX = 200;

export type RrfCombineOptions = {
  /** Max items in the fused output. */
  topK: number;
  /** RRF smoothing constant; default {@link RRF_K_DEFAULT}. */
  k?: number;
};

/**
 * Fuse retriever results via Reciprocal Rank Fusion.
 *
 * @param results - zero or more retriever outputs (BM25, ANN, ...). Empty → an empty envelope.
 * @param opts.topK - max items in the fused output.
 * @param opts.k - RRF smoothing constant; default {@link RRF_K_DEFAULT}.
 * @returns a {@link RetrievedKnowledgeV1} with items carrying stage="rrf", sorted by RRF score
 *   descending. Degradation propagates if any input was degraded.
 */
export function rrfCombine(
  results: ReadonlyArray<RetrievedKnowledgeV1>,
  opts: RrfCombineOptions,
): RetrievedKnowledgeV1 {
  const k = opts.k ?? RRF_K_DEFAULT;
  if (results.length === 0) {
    // Python returns a bare RetrievedKnowledgeV1() — all-defaults envelope.
    return {
      schema_version: 1,
      items: [],
      degraded: false,
      degradation_reason: "",
      starvation_tiers: [],
      source_counts: {},
    };
  }

  const scoreById = new Map<string, number>();
  const chunkById = new Map<string, KnowledgeChunkV1>();
  let degraded = false;
  const reasons: Array<string> = [];

  for (const r of results) {
    if (r.degraded) {
      degraded = true;
      if (r.degradation_reason) {
        reasons.push(r.degradation_reason);
      }
    }
    // enumerate(..., start=1): rank is 1-based.
    r.items.forEach((item, idx) => {
      const rank = idx + 1;
      const cid = item.chunk.chunk_id;
      scoreById.set(cid, (scoreById.get(cid) ?? 0) + 1 / (k + rank));
      // setdefault: the FIRST-seen chunk object for a given id wins.
      if (!chunkById.has(cid)) {
        chunkById.set(cid, item.chunk);
      }
    });
  }

  // Sort by RRF score descending, take top_k.
  const fused = [...scoreById.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.topK);
  const items: Array<ScoredKnowledgeChunkV1> = fused.map(([cid, score]) => {
    const chunk = chunkById.get(cid);
    if (chunk === undefined) {
      // Unreachable: every id in scoreById was setdefault'd into chunkById in the same loop. Guard
      // for noUncheckedIndexedAccess soundness rather than a non-null assertion.
      throw new Error(`rrfCombine: missing chunk for fused id ${cid}`);
    }
    return { schema_version: 1, chunk, score, stage: "rrf" };
  });

  return {
    schema_version: 1,
    items,
    degraded,
    degradation_reason: reasons.join("; ").slice(0, DEGRADATION_REASON_MAX),
    starvation_tiers: [],
    source_counts: {},
  };
}
