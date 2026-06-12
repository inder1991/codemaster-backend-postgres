// EmbedQueryActivity — port of the frozen Python
// vendor/codemaster-py/codemaster/activities/embed_query.py (Sprint 26 / R-11 multi-lens audit follow-up).
//
// Bound-method holder for the Temporal-registered `embed_query_activity`. Computes ONE 1024-dim
// embedding for a caller-supplied query string. The workflow body memoizes results per unique chunk
// path so a 100-chunk PR spread across 5 files issues 5 embed RPCs instead of 100.
//
// Idempotent on input: same query → same vector (modulo embed-service non-determinism, which the
// embed service itself controls). Temporal retries are safe; double-emit just produces duplicate OTel
// histogram records, no state change.
//
// ── 1024-dim guard (FAITHFUL to the Python) ──
// The platform-model contract is EMBEDDING_DIM = 1024 (the pgvector `core.knowledge_chunks.vector`
// column width). This activity defensively rejects a wrong-shape vector — a contract violation from the
// embed service — rather than returning it and poisoning the downstream ANN cosine search.
//
// ── Purpose alignment (W1.3 — RL-appendix embed-mode) ──
// HARDENING DIVERGENCE from the frozen Python: the Python used `_QUERY_PURPOSE = "in_repo_doc"` here
// while AnnRetriever's per-chunk fallback used "review_query" — so a chunk whose memoized embed failed
// got a DIFFERENT query vector than its siblings (depressed cosine for the truly relevant chunk). Both
// paths now share the ONE {@link QUERY_EMBED_PURPOSE} ("review_query") + the flag-gated Qwen
// query-instruction seam ({@link buildQueryEmbedText}) from retrieval/query_embed.ts.

import {
  type EmbeddingsPort,
  EMBEDDING_DIM,
} from "#backend/adapters/embeddings_port.js";
import { buildQueryEmbedText, QUERY_EMBED_PURPOSE } from "#backend/retrieval/query_embed.js";

import { CURRENT_SCHEMA_VERSION } from "#contracts/embed_query.v1.js";
import type { EmbedQueryInputV1, EmbedQueryResultV1 } from "#contracts/embed_query.v1.js";

export type EmbedQueryActivityOptions = {
  embeddings: EmbeddingsPort;
  modelName: string;
};

/** Bound-method holder for `embed_query_activity` (1:1 with the Python `EmbedQueryActivity`). */
export class EmbedQueryActivity {
  private readonly embeddings: EmbeddingsPort;
  private readonly modelName: string;

  public constructor({ embeddings, modelName }: EmbedQueryActivityOptions) {
    this.embeddings = embeddings;
    this.modelName = modelName;
  }

  /**
   * Embed `input.query`; return the 1024-dim vector wrapped in an {@link EmbedQueryResultV1}.
   *
   * Propagates whatever the embed port raises (connectivity / rate-limit / validation). The workflow
   * body wraps this call in `stage_outcome` so failures fail-open to legacy per-chunk embedding inside
   * AnnRetriever.
   *
   * Throws on a vector-dim mismatch (embed-service contract violation) — surfaced rather than returning
   * a wrong-shape vector that would poison the ANN cosine search downstream.
   */
  public async embedQuery(input: EmbedQueryInputV1): Promise<EmbedQueryResultV1> {
    const result = await this.embeddings.embed({
      // W1.3: every QUERY embed routes through the shared seam (instruction prefix when flagged on).
      texts: [buildQueryEmbedText(input.query)],
      model_name: this.modelName,
      purpose: QUERY_EMBED_PURPOSE,
    });
    const first = result.vectors[0];
    // The port invariant is `vectors.length === texts.length` (one input → one vector); guard the
    // index access for noUncheckedIndexedAccess rather than assuming it.
    const vector = first === undefined ? [] : [...first];
    if (vector.length !== EMBEDDING_DIM) {
      // Defensive: embed-service contract violation. Surface rather than returning a wrong-shape vector
      // that would poison the ANN cosine search downstream.
      throw new Error(
        `embed_query: vector dim mismatch (got=${vector.length} expected=${EMBEDDING_DIM})`,
      );
    }
    // The result carries the RESULT contract's CURRENT_SCHEMA_VERSION, NOT the echoed input version —
    // input + result are distinct, independently versioned contracts (1:1 with the Python
    // `EmbedQueryResultV1(vector=vector)`, which leaves schema_version at its field default).
    return { schema_version: CURRENT_SCHEMA_VERSION, vector };
  }
}
