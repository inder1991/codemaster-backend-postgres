// Port of `codemaster/retrieval/match_specificity.py` — Stage 1.5 of the retrieval pipeline
// (between SQL candidate gathering and Stage-2 sorting): score how PRECISELY a chunk's labels match
// the PR's effective labels, plus the bucket rendered in the confluence prompt frame (Sub-spec B
// T16). Pure; weights verbatim from spec §3.5 lines 768-776, thresholds from spec §3.6 line 988.
//
// W1.3 (RH8): the frozen code (Python AND the original TS port) shipped only the BUCKET half — every
// producer hardcoded `match_specificity_score = 0`, so the floors sort collapsed to age-only and the
// prompt attribute was a constant "baseline". `computeMatchSpecificity` is now ported 1:1 and WIRED:
// `PostgresConfluenceRetrieval.search` computes it per row from the caller's effective_labels.

/**
 * Per-namespace weights (1:1 with the Python `NAMESPACE_WEIGHTS`, spec §3.5 line 768-776). A chunk
 * tagged only `default` matches every PR equally; framework/topic-precise tags rank above it. The
 * bare `default` label has no namespace prefix and is handled separately.
 */
export const NAMESPACE_WEIGHTS: Readonly<Record<string, number>> = {
  framework: 5,
  topic: 4,
  version: 4,
  org: 4,
  lang: 3,
  infra: 3,
  default: 1,
};

/**
 * Sum of {@link NAMESPACE_WEIGHTS} over `chunkLabels ∩ effectiveLabels` (1:1 with the Python
 * `compute_match_specificity`). The bare `default` label contributes the baseline weight; unknown
 * namespaces contribute 0 — they don't poison the score but they don't help either.
 */
export function computeMatchSpecificity(
  chunkLabels: ReadonlySet<string>,
  effectiveLabels: ReadonlySet<string>,
): number {
  let score = 0;
  for (const label of chunkLabels) {
    if (!effectiveLabels.has(label)) {
      continue;
    }
    if (label === "default") {
      score += NAMESPACE_WEIGHTS["default"] ?? 0;
      continue;
    }
    const ns = label.includes(":") ? (label.split(":", 1)[0] ?? "") : "";
    // eslint-disable-next-line security/detect-object-injection -- read-only lookup in a frozen const weight map; unknown keys yield undefined → 0
    score += NAMESPACE_WEIGHTS[ns] ?? 0;
  }
  return score;
}

/** high | medium | baseline — the bucket label rendered as `match_specificity="…"`. */
export type SpecificityBucket = "high" | "medium" | "baseline";

const HIGH_THRESHOLD = 8;
const MEDIUM_THRESHOLD = 4;

/** Bucket the integer match-specificity score into high/medium/baseline (1:1 with `specificity_bucket`). */
export function specificityBucket(score: number): SpecificityBucket {
  if (score >= HIGH_THRESHOLD) {
    return "high";
  }
  if (score >= MEDIUM_THRESHOLD) {
    return "medium";
  }
  return "baseline";
}
