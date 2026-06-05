// Bm25Retriever — port of the frozen Python
// vendor/codemaster-py/codemaster/retrieval/bm25_retriever.py::Bm25Retriever (Sprint 10 / S10.3.2).
//
// Lexical retriever over the in-repo doc index. Delegates to a {@link Bm25Port} (Postgres `ts_rank_cd`
// in production), wraps the hits in a {@link RetrievedKnowledgeV1} envelope with stage="bm25". The
// repo-id tenancy filtering happens INSIDE the port; the retriever simply forwards the query fields and
// trusts the port to scope.
//
// ── Clock seam (check_clock_random) ──
// The around-search duration is measured via an injected {@link Clock} `monotonic()` (the
// gate-sanctioned seam), NOT a raw `performance.now()`. WallClock() default keeps zero-arg compat (1:1
// with the Python R-7 fix). The frozen Python emits an OTel histogram here; that observability module
// is not ported yet, so this port keeps the timing seam intact but omits the (absent) metric emission
// — exactly as the sibling AnnRetriever port does.

import { type Clock, WallClock } from "#platform/clock.js";

import type { Bm25Port } from "./bm25_port.js";
import type {
  KnowledgeQueryV1,
  RetrievedKnowledgeV1,
  ScoredKnowledgeChunkV1,
} from "#contracts/knowledge_chunks.v1.js";

export type Bm25RetrieverOptions = {
  port: Bm25Port;
  clock?: Clock;
};

/** Wrapper around a {@link Bm25Port} that emits {@link RetrievedKnowledgeV1} (stage="bm25"). */
export class Bm25Retriever {
  private readonly port: Bm25Port;
  private readonly clock: Clock;

  public constructor({ port, clock }: Bm25RetrieverOptions) {
    this.port = port;
    // Clock injection replaces the inline monotonic call that would violate the no-wall-clock gate;
    // WallClock() default keeps zero-arg compat (1:1 with the Python R-7 fix).
    this.clock = clock ?? new WallClock();
  }

  public async retrieve(query: KnowledgeQueryV1): Promise<RetrievedKnowledgeV1> {
    // Time the search via the injected Clock (the gate-sanctioned monotonic seam). include_stale is
    // NOT forwarded — the legacy retriever always runs the default active-only path (1:1 with Python).
    this.clock.monotonic();
    const hits = await this.port.search({
      installationId: query.installation_id,
      repoId: query.repo_id,
      query: query.query,
      topK: query.top_k,
    });
    this.clock.monotonic();

    const items: Array<ScoredKnowledgeChunkV1> = hits.map(([chunk, score]) => ({
      schema_version: 1,
      chunk,
      score,
      stage: "bm25",
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
