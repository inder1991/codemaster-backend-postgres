/**
 * Semantic-merge seam — port of vendor/codemaster-py/codemaster/review/aggregation_semantic.py.
 *
 * ## What this is at the port boundary (the DELIBERATE deferral)
 *
 * Stage 2 of the aggregation chain. In the frozen Python, `aggregate_semantic` calls the platform-team
 * Qwen embedder, embeds every finding body, and greedily merges same-file findings whose body-embedding
 * cosine-similarity ≥ 0.92. A failure (connectivity / rate limit / shape) is FAIL-OPEN: the input is
 * returned unchanged with `semantic_skipped=True`.
 *
 * The REAL Qwen merge is DEFERRED in this port — it needs the Qwen `EmbeddingsPort` adapter, which is a
 * separate sub-project (tracked: FOLLOW-UP-aggregate-semantic-qwen). Until that lands, this seam ships
 * the FAIL-OPEN skip path ONLY: with NO embedder it never embeds, never merges, and reports the skip
 * flag exactly as the frozen Python does when its embedder fails.
 *
 * ## Byte-exact skip-path parity with the frozen Python
 *
 * Crucially, the Python's `semantic_skipped` flag is NOT unconditionally True on the skip path. The
 * Python `aggregate_semantic` SHORT-CIRCUITS at the top: `if len(findings) < 2: return findings, False`.
 * It only sets `semantic_skipped=True` after that guard, when the embedder actually fails on ≥2 findings.
 * So the parity-true skip-path semantics are:
 *
 *     fewer than 2 findings  →  (findings, semantic_skipped=False)   [Python early return]
 *     2+ findings, no merge  →  (findings, semantic_skipped=True)    [Python embedder-failure fail-open]
 *
 * The Tier-1 parity oracle drives the frozen Python with a FAILING embedder (forcing the fail-open
 * branch), which makes the Python output for every input byte-identical to this no-embedder seam.
 */

import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

/**
 * Port of `aggregate_semantic` restricted to the FAIL-OPEN skip path (no embedder).
 *
 * Returns `[out, semanticSkipped]`. `out` is the input passed through unchanged (no merge happens
 * without the deferred Qwen embedder). `semanticSkipped` mirrors the frozen Python EXACTLY:
 *   - `false` when fewer than 2 findings reach this stage (Python's `len(findings) < 2` early return —
 *     there is nothing to merge, so the embedder is never consulted and no skip is recorded);
 *   - `true`  when 2+ findings reach this stage (the deferred embedder is "absent", which is the same
 *     observable outcome as the Python embedder failing on ≥2 findings: fail-open pass-through).
 *
 * `embedder` is accepted as `undefined` only for now — the parameter is the seam where the deferred
 * Qwen `EmbeddingsPort` adapter plugs in (FOLLOW-UP-aggregate-semantic-qwen). When that lands, this seam
 * grows the real cosine-merge branch behind a `if (embedder !== undefined)` guard; the skip-path
 * semantics below remain the fallback.
 */
export function aggregateSemantic(
  findings: ReadonlyArray<ReviewFindingV1>,
  embedder?: undefined,
): [Array<ReviewFindingV1>, boolean] {
  // The deferred branch: with a real embedder this is where the Qwen embed + greedy cosine merge runs.
  // Until FOLLOW-UP-aggregate-semantic-qwen lands, `embedder` is always undefined and we take the
  // skip path. The explicit reference keeps the seam parameter live (no-unused-vars) and documents
  // where the merge re-enters.
  void embedder;

  // Python `if len(findings) < 2: return findings, False`.
  if (findings.length < 2) {
    return [[...findings], false];
  }
  // 2+ findings, no embedder → fail-open pass-through, skip recorded (mirrors the Python embedder-failure
  // branch byte-for-byte).
  return [[...findings], true];
}
