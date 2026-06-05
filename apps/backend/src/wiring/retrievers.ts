// Retriever wiring — port of the frozen Python
// vendor/codemaster-py/codemaster/wiring/retrievers.py (Sprint 26 / B-2 stage 6; R-31 single-call DI
// factory). This is the LEGACY (BM25 + ANN + RRF) wiring only.
//
// ── DEFERRED (faithful to the Python default; marker-gated OFF) ──────────────────────────────────
// The frozen Python `build_retrieve_knowledge_activity` ALSO wires a `HybridRetriever` (BM25 + ANN +
// PostgresConfluenceRetrieval + an IdentityRerankPort no-op rerank) so the activity's hybrid branch can
// fire when `include_confluence=True`. That whole hybrid/Confluence path + the real LLM rerank are
// DEFERRED here — `RetrieveKnowledgeActivity` is constructed with NO hybrid retriever, so it always
// runs the legacy fusion (1:1 with the Python default behaviour when `hybrid_retriever=None`):
//   - FOLLOW-UP-retrieve-knowledge-hybrid-confluence  (HybridRetriever + PostgresConfluenceRetrieval)
//   - FOLLOW-UP-retrieve-knowledge-llm-rerank         (BedrockRerank port)
//
// ── DSN gate (DIVERGES from the Python; documented for the verifier) ─────────────────────────────
// The Python `build_bm25_port` / `build_ann_port` fall back to EMPTY InMemory*Port test doubles when
// `CODEMASTER_PG_CORE_DSN` is unset, emitting a WARN log + a `record_retrieval_degraded` counter. That
// observability module is NOT ported to TS yet, and the rest of this TS codebase resolves the shared
// ADR-0062 pool fail-loud (e.g. allocate_workspace.activity.ts::resolveDb). So this wiring is FAIL-LOUD
// on an unset DSN rather than silently building empty in-memory ports — the InMemory*Port doubles are
// test-only and are NEVER wired on the shipped path. A caller that wants the in-memory ports for a unit
// loop constructs them directly in the test file.
//
// ── Shared pool (ADR-0062) ──────────────────────────────────────────────────────────────────────
// Both ports share ONE Kysely over the process-wide pool via `tenantKysely(dsn)` (the central seam),
// matching the Python R-43 "share one core session_factory across both ports".

import { RetrieveKnowledgeActivity } from "#backend/activities/retrieve_knowledge.activity.js";
import { type EmbeddingsPort } from "#backend/adapters/embeddings_port.js";
import { AnnRetriever } from "#backend/retrieval/ann_retriever.js";
import { type AnnPort, PostgresAnnPort } from "#backend/retrieval/ann_port.js";
import { type Bm25Port, PostgresBm25Port } from "#backend/retrieval/bm25_port.js";
import { Bm25Retriever } from "#backend/retrieval/bm25_retriever.js";

import { tenantKysely } from "#platform/db/database.js";

/** Resolve the shared ADR-0062 Kysely from `CODEMASTER_PG_CORE_DSN` (fail-loud on unset; see header). */
function resolveCoreDb(): ReturnType<typeof tenantKysely<unknown>> {
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set; cannot wire the production BM25 / ANN retriever ports. " +
        "Set it to the core Postgres DSN. (The in-memory ports are test-only and are never wired here.)",
    );
  }
  return tenantKysely<unknown>(dsn);
}

/**
 * Return the production {@link Bm25Port} ({@link PostgresBm25Port} over the shared core pool).
 * Fail-loud when `CODEMASTER_PG_CORE_DSN` is unset (see the header divergence note).
 */
export function buildBm25Port(): Bm25Port {
  return new PostgresBm25Port({ db: resolveCoreDb() });
}

/**
 * Return the production {@link AnnPort} ({@link PostgresAnnPort} over the shared core pool).
 * Fail-loud when `CODEMASTER_PG_CORE_DSN` is unset (see the header divergence note).
 *
 * The Python threads an optional `embedder_cache` into PostgresAnnPort for the Phase-A/Phase-C SELECT
 * dispatch; that EmbedderCache is `None` in the current composition AND the TS PostgresAnnPort ports
 * only the `_sql_no_cache` branch, so there is no `embedderCache` parameter here (DEFERRED with the
 * cache itself).
 */
export function buildAnnPort(): AnnPort {
  return new PostgresAnnPort({ db: resolveCoreDb() });
}

export type BuildRetrieveKnowledgeActivityOptions = {
  /** The production {@link EmbeddingsPort} (resolved by `resolveEmbeddingsConsumer`). */
  embedder: EmbeddingsPort;
  /** Embed model name passed to AnnRetriever (1:1 with the Python `model_name` default). */
  modelName?: string;
  /** Per-chunk retrieval result cap (1:1 with the Python `top_k=5`). */
  topK?: number;
};

/**
 * Single-call DI factory for the LEGACY {@link RetrieveKnowledgeActivity} (1:1 with the Python
 * `build_retrieve_knowledge_activity`, minus the DEFERRED hybrid/Confluence wiring — see the header).
 *
 * Composes {@link Bm25Retriever} (over {@link buildBm25Port}) + {@link AnnRetriever} (over
 * {@link buildAnnPort} + the injected embedder) and binds them into the activity holder. The worker
 * registers `holder.retrieveKnowledge` as the `retrieve_knowledge_activity` Temporal activity.
 */
export function buildRetrieveKnowledgeActivity({
  embedder,
  modelName = "qwen3-embed-0.6b",
  topK = 5,
}: BuildRetrieveKnowledgeActivityOptions): RetrieveKnowledgeActivity {
  const bm25Retriever = new Bm25Retriever({ port: buildBm25Port() });
  const annRetriever = new AnnRetriever({
    port: buildAnnPort(),
    embeddings: embedder,
    modelName,
  });
  return new RetrieveKnowledgeActivity({ bm25Retriever, annRetriever, topK });
}
