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
