// Retrieval-pipeline shared constants — port of the frozen Python
// vendor/codemaster-py/codemaster/retrieval/constants.py (R-50 multi-lens audit 2026-05-22).
//
// Single-sources the per-retriever pre-fusion / pre-rerank fan-out width so a future operator tuning
// it changes the value in exactly one place. The Python module promoted this from duplicated `20`
// literals in `hybrid_retriever.py` + `retrieve_knowledge.py`.

/**
 * Per-retriever pre-fusion / pre-rerank top_k. Over-fetch each side (BM25, ANN) so RRF has enough
 * candidates to fuse + the rerank pass (when wired) has enough material to score. 1:1 with the Python
 * `PRE_FUSION_TOP_K: Final[int] = 20`.
 */
export const PRE_FUSION_TOP_K = 20;

/**
 * W1.3 (RH10) — the platform-default minimum cosine-similarity floor for dense (pgvector) retrieval.
 *
 * Without a floor the ANN adapters ALWAYS return top_k rows, even when every match is irrelevant
 * (cosine ~0.1 — RH10's util-repo README scenario), manufacturing the appearance of relevant
 * knowledge for the review LLM. With the floor, a query with no genuinely-similar chunks returns
 * fewer/zero results instead of padding to top_k.
 *
 * 0.3 is the BOTTOM of RH10's suggested 0.3–0.5 band — the maximally fail-open choice: it only
 * discards matches of the clearly-irrelevant class the audit describes, never a borderline-useful
 * one. Tunable via `CODEMASTER_RETRIEVAL_MIN_SIMILARITY` (wiring/retrievers.ts); revisit upward once
 * W1.7's retrieval-quality counters provide evidence. Explicit opt-out: pass `minSimilarity: 0`
 * (still drops anti-correlated matches, which are never useful) or `-1` (exact legacy padding).
 */
export const MIN_COSINE_SIMILARITY_FLOOR = 0.3;
