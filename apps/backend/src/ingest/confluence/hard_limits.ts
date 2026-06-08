// Hard-limit governance for default-tagged Confluence chunks — port of the frozen Python
// vendor/codemaster-py/codemaster/ingest/confluence/hard_limits.py (Sub-spec A T11), adapted per
// ADR-0075.
//
// FAITHFUL DIVERGENCE (ADR-0075 "Deferrals"): platform_config_cache is NOT ported. The Python
// `get_default_corpus_limits()` reads tunables from platform_config and falls back to spec-pinned
// defaults; the TS port inlines those fallbacks directly (the same pattern review_run_reaper +
// retrieve_knowledge already use). Tracked under FOLLOW-UP-platform-config-cache.
//
// FAITHFUL DIVERGENCE: the Python count/sum helpers run SQL against an AsyncSession. These are the
// PURE primitives — they take chunk rows as arguments and apply the same active-default-tagged
// predicate the SQL did. The SQL-bearing repo versions live in the repo track, not in this pure
// module.
//
// The active + default-tagged predicate mirrors the Python SQL WHERE clauses exactly:
//   * count_default_chunks_in_space: space_key = :sk AND 'default' = ANY(labels) AND deleted_at IS NULL
//   * sum_default_corpus_tokens:                      'default' = ANY(labels) AND deleted_at IS NULL
//
// PURE: no I/O, no clock, no random.

// Spec-pinned fallbacks — MUST match platform_config_cache.DEFAULTS + the Python hard_limits.py
// `_FALLBACK_*` values (migration 0095 seed): 25 chunks/space, 50 000 corpus tokens.
const FALLBACK_MAX_PER_SPACE = 25;
const FALLBACK_MAX_TOKENS = 50_000;

/** Tunables governing default-tagged Confluence corpus growth. */
export type DefaultCorpusLimits = {
  readonly max_chunks_per_space: number;
  readonly max_corpus_tokens: number;
};

/**
 * The subset of a `core.confluence_chunks` row the pure hard-limit predicates inspect. Callers in the
 * repo track project these columns out of the DB row; the pure helpers never touch the DB.
 */
export type ConfluenceChunkRow = {
  readonly space_key: string;
  readonly labels: ReadonlyArray<string>;
  /** Soft-delete marker; `null` means active. */
  readonly deleted_at: string | null;
  readonly token_count: number;
};

/**
 * Return the current default-corpus limits.
 *
 * Per ADR-0075 the TS port inlines the spec-pinned fallbacks (platform_config_cache is not ported), so
 * this is a pure constant accessor rather than the Python async config read.
 */
export function getDefaultCorpusLimits(): DefaultCorpusLimits {
  return {
    max_chunks_per_space: FALLBACK_MAX_PER_SPACE,
    max_corpus_tokens: FALLBACK_MAX_TOKENS,
  };
}

/** True iff the chunk row is active (not soft-deleted) and carries the `default` label. */
function isActiveDefault(r: ConfluenceChunkRow): boolean {
  return r.deleted_at === null && r.labels.includes("default");
}

/**
 * Count active (not deleted) default-tagged chunks already indexed for `spaceKey`.
 *
 * Pure analogue of the Python `count_default_chunks_in_space` SQL.
 */
export function countDefaultChunksInSpace(
  rows: ReadonlyArray<ConfluenceChunkRow>,
  spaceKey: string,
): number {
  return rows.filter((r) => r.space_key === spaceKey && isActiveDefault(r)).length;
}

/**
 * Sum token_count across ALL active default-tagged chunks platform-wide (every space).
 *
 * Pure analogue of the Python `sum_default_corpus_tokens` SQL.
 */
export function sumDefaultCorpusTokens(rows: ReadonlyArray<ConfluenceChunkRow>): number {
  return rows.reduce((acc, r) => (isActiveDefault(r) ? acc + r.token_count : acc), 0);
}
