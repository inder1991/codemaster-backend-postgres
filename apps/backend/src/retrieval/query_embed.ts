// query_embed — the W1.3 query-embed seam (RL-appendix embed-mode item, folded into RC4).
//
// Two defects closed here (docs/audits/2026-06-11-audit-recovered-lenses.md, RL appendix):
//
//   1. INCONSISTENT QUERY PURPOSE — `embed_query.activity.ts` used `purpose="in_repo_doc"` while
//      `ann_retriever.ts`'s per-chunk fallback used `purpose="review_query"` (an inconsistency carried
//      an inconsistency in the original code). A chunk whose memoized embed failed therefore got a DIFFERENT query
//      vector than its siblings, depressing cosine similarity for the truly relevant chunk. Both
//      paths now share {@link QUERY_EMBED_PURPOSE} — "review_query", the query-mode bucket (queries
//      are queries, not documents; if the embed service keys query-instruction handling on `purpose`,
//      this is the value that should trigger it).
//
//   2. NO QUERY-vs-PASSAGE ASYMMETRY — Qwen3-style embedders score best when the QUERY carries an
//      instruction prefix ("Instruct: …\nQuery: …") while passages are embedded bare. Whether the
//      platform Qwen service already applies that server-side is NOT empirically verified (the audit
//      mandates verifying before prepending client-side — double-prefixing would HURT relevance), so
//      the client-side prefix ships BEHIND `CODEMASTER_EMBED_QUERY_INSTRUCTION_ENABLED` (default
//      OFF). One seam ({@link buildQueryEmbedText}) feeds BOTH embed paths, so query vectors stay
//      mutually consistent whichever way the flag is set.
//
// Node-side module (read by the embed activity + the ANN retriever); NOT imported by the
// deterministic pipeline spine.

/** The ONE query purpose — shared by EmbedQueryActivity AND AnnRetriever's fallback embed. */
export const QUERY_EMBED_PURPOSE = "review_query";

/**
 * The Qwen3 query-instruction prefix (the documented "Instruct: {task}\nQuery: {query}" shape).
 * Applied to QUERIES only — corpus passages stay bare, which is exactly the intended asymmetry (no
 * re-embed of the corpus is needed to adopt it).
 */
export const QWEN_QUERY_INSTRUCTION =
  "Instruct: Given a code review query, retrieve relevant engineering documentation and guidance\nQuery: ";

type EnvShape = Readonly<Record<string, string | undefined>>;

/** Flag read for the client-side instruction prefix (default OFF — see the module header). */
export function queryInstructionEnabled(env: EnvShape = process.env): boolean {
  return (env.CODEMASTER_EMBED_QUERY_INSTRUCTION_ENABLED ?? "false").toLowerCase() === "true";
}

/**
 * The text actually sent to the embed service for a QUERY: the raw query, or the instruction-prefixed
 * form when `CODEMASTER_EMBED_QUERY_INSTRUCTION_ENABLED=true`. Callers must route EVERY query embed
 * through this seam (never a passage embed) so the two query paths cannot diverge again.
 */
export function buildQueryEmbedText(query: string, env: EnvShape = process.env): string {
  return queryInstructionEnabled(env) ? `${QWEN_QUERY_INSTRUCTION}${query}` : query;
}
