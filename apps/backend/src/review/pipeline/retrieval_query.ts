// retrieval_query — the W1.3 (RC4) code-bearing retrieval query builder.
//
// RC4 (docs/audits/2026-06-11-audit-recovered-lenses.md): the ANN/BM25 query used to be just
// `${chunk.path} ${pr_title}` — the actual changed code (the diff-hunk body) never drove the vector
// search, so the dense embedding encoded a path string + human title instead of the semantics of the
// code under review, and the entire knowledge-retrieval subsystem contributed near-noise. The fix
// (per the RC4 finding + W1.3 in docs/audits/2026-06-11-MASTER-hardening-plan.md): build the query
// from code-bearing content — PR title + PR description + chunk path + the CHUNK BODY itself.
// (Changed symbol names are part of the RC4 recipe too, but the symbol-graph producer is unwired
// until W1.6 — `removed_or_changed_symbols` is hardcoded empty — so they join the query then.)
//
// Field order is deliberate: SHORT fields first (title ≤500 by contract, description capped here,
// then the path) so the trailing 8000-char contract cap (`RetrieveKnowledgeInputV1.query` /
// `EmbedQueryInputV1.query` are both max(8000)) only ever truncates the BODY tail — the title /
// description / path always survive. The chunk path is retained for the lexical (BM25) leg: path
// tokens are the one useful signal the legacy query carried.
//
// PURE string assembly — no clock / RNG / IO / env (gate-clean inside the deterministic pipeline
// spine; the orchestrator imports this module).

/** The query-text cap — equals the 8000-char `query` bound on BOTH retrieval contracts. */
export const RETRIEVAL_QUERY_MAX = 8000;

/** Cap on the PR-description part so a runaway description cannot crowd the code out of the query. */
const DESCRIPTION_CAP = 2000;

/**
 * Build the per-chunk retrieval query text (embedded by `embed_query` AND sent to
 * `retrieve_knowledge` for the BM25 leg). Never empty (the contracts demand min 1): when every part
 * is blank the chunk path is returned as-is.
 */
export function buildRetrievalQueryText(args: {
  prTitle: string;
  prDescription: string;
  chunkPath: string;
  chunkBody: string;
}): string {
  const parts = [
    args.prTitle.trim(),
    args.prDescription.trim().slice(0, DESCRIPTION_CAP),
    args.chunkPath.trim(),
    args.chunkBody.trim(),
  ].filter((part) => part !== "");
  const joined = parts.join("\n").slice(0, RETRIEVAL_QUERY_MAX);
  // DiffChunkV1.path is min(1), so the fallback can never be empty.
  return joined === "" ? args.chunkPath : joined;
}
