/**
 * Semantic-merge seam — Stage 2 of the aggregation chain.
 *
 * ## What this is
 *
 * Given a real {@link EmbeddingsPort} it embeds every finding body in ONE batch call, then GREEDILY
 * merges same-file findings whose body-embedding cosine-similarity ≥ {@link SEMANTIC_MERGE_THRESHOLD}
 * (0.92): the higher-confidence finding absorbs the lower-confidence one's body (joined by `\n---\n`);
 * title / suggestion / category / file / lines follow the ABSORBER; severity + confidence take the max
 * of the pair.
 *
 * Cross-file findings are NEVER considered — a similarity match across files almost always means two
 * real bugs in related code, not a duplicate.
 *
 * ## Fail-open contract
 *
 *   - fewer than 2 findings              → `[findings, false]`  (nothing to merge, the embedder is
 *                                          never consulted).
 *   - embedder throws OR vector-count    → `[findings, true]`   (fail-open: input passed through
 *     mismatch                              unchanged, `semantic_skipped=True`). Catches the typed
 *                                          {@link EmbeddingsError} family AND any unexpected throw.
 *   - real merge over ≥2 findings        → `[merged, false]`.
 *
 * ## No-embedder fallback (the original skip-path seam, retained)
 *
 * When `embedder === undefined` the function takes the same fail-open shape WITHOUT calling an embedder:
 * `len < 2 → false`, else `true`.
 *
 * The function is async because the embedder call is async; nothing else in the body does I/O.
 */

import {
  EmbeddingsError,
  type EmbedRequest,
  type EmbeddingsPort,
} from "#backend/adapters/embeddings_port.js";

import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

/** Cosine-similarity merge threshold (Python `SEMANTIC_MERGE_THRESHOLD = 0.92`). */
export const SEMANTIC_MERGE_THRESHOLD = 0.92;

/** Default platform model id for the body-embed batch (Python `embedder_model="qwen3-embed-0.6b"`). */
export const DEFAULT_EMBEDDER_MODEL = "qwen3-embed-0.6b";

/** Body-union separator (matches aggregation.ts's exact-merge separator). */
const BODY_SEPARATOR = "\n---\n";

/** Severity rank. Unknown severities rank below `nit` via the `-1` default. */
const SEVERITY_RANK: Readonly<Record<string, number>> = {
  blocker: 3,
  issue: 2,
  suggestion: 1,
  nit: 0,
};

function severityRank(s: string): number {
  // Python `.get(s, -1)` — unknown severities rank below `nit`.
  // eslint-disable-next-line security/detect-object-injection -- read-only lookup in a frozen const map keyed by the Severity contract enum (4 fixed values), not user input; missing keys handled by the `=== undefined` guard
  const rank = SEVERITY_RANK[s];
  return rank === undefined ? -1 : rank;
}

/** Returns `a` on a tie (`>=`). */
function maxSeverity(a: string, b: string): string {
  return severityRank(a) >= severityRank(b) ? a : b;
}

/**
 * Cosine similarity of two equal-length vectors. Returns 0.0 on a length mismatch, an empty vector, or
 * a zero-norm vector. Dimension-agnostic — we never assert a fixed width here.
 */
function cosine(u: ReadonlyArray<number>, v: ReadonlyArray<number>): number {
  if (u.length !== v.length || u.length === 0) {
    return 0.0;
  }
  let dot = 0.0;
  let nu = 0.0;
  let nv = 0.0;
  for (let i = 0; i < u.length; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded numeric loop index into a local array, not user input
    const a = u[i]!;
    // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded numeric loop index into a local array, not user input
    const b = v[i]!;
    dot += a * b;
    nu += a * a;
    nv += b * b;
  }
  if (nu === 0.0 || nv === 0.0) {
    return 0.0;
  }
  return dot / (Math.sqrt(nu) * Math.sqrt(nv));
}

/**
 * Merge `absorbed` into `absorber`. The body union is the absorber's body + separator + the absorbed body
 * (UNLESS the absorbed body is already one of the absorber's separator-split segments — the dedup guard).
 * Severity + confidence take the max of the pair; title / suggestion / category / file / lines all follow
 * the ABSORBER. The additive fields (sources / scope / evidence_refs) reset to their contract defaults
 * (identical to aggregation.ts's aggregateExact merge).
 */
function merge(absorber: ReviewFindingV1, absorbed: ReviewFindingV1): ReviewFindingV1 {
  const mergedBody = absorber.body.split(BODY_SEPARATOR).includes(absorbed.body)
    ? absorber.body
    : absorber.body + BODY_SEPARATOR + absorbed.body;
  return {
    schema_version: absorber.schema_version,
    file: absorber.file,
    start_line: absorber.start_line,
    end_line: absorber.end_line,
    severity: maxSeverity(absorber.severity, absorbed.severity) as ReviewFindingV1["severity"],
    category: absorber.category,
    title: absorber.title,
    body: mergedBody,
    suggestion: absorber.suggestion,
    confidence: Math.max(absorber.confidence, absorbed.confidence),
    sources: [],
    scope: "chunk_observed",
    evidence_refs: [],
  };
}

/**
 * Greedy semantic merge.
 *
 * Returns `[out, semanticSkipped]`. `semanticSkipped` is `true` iff the embedder failed (or returned the
 * wrong vector count) and we degraded to a no-op pass-through.
 *
 * `embedder` is optional: with a real {@link EmbeddingsPort} the merge branch runs; with `undefined` the
 * no-embedder fallback runs (same fail-open shape, no embed call).
 */
export async function aggregateSemantic(
  findings: ReadonlyArray<ReviewFindingV1>,
  embedder?: EmbeddingsPort,
  opts: { readonly threshold?: number; readonly embedderModel?: string } = {},
): Promise<[Array<ReviewFindingV1>, boolean]> {
  const threshold = opts.threshold ?? SEMANTIC_MERGE_THRESHOLD;
  const embedderModel = opts.embedderModel ?? DEFAULT_EMBEDDER_MODEL;

  // Python `if len(findings) < 2: return findings, False`.
  if (findings.length < 2) {
    return [[...findings], false];
  }

  // No real embedder → fail-open pass-through, skip recorded (≥2 findings reach the stage, the embedder
  // is "absent", so we degrade to no-op).
  if (embedder === undefined) {
    return [[...findings], true];
  }

  const bodies = findings.map((f) => f.body);
  let vectors: ReadonlyArray<ReadonlyArray<number>>;
  try {
    const req: EmbedRequest = {
      texts: bodies,
      model_name: embedderModel,
      purpose: "review_query",
    };
    const result = await embedder.embed(req);
    vectors = result.vectors;
  } catch (e) {
    // Python catches `EmbeddingsError` AND a generic `Exception` — both fail-open. The `instanceof`
    // check documents the typed taxonomy; the fall-through covers any other throw (defensive).
    void (e instanceof EmbeddingsError);
    return [[...findings], true];
  }

  // Python: `if len(vectors) != len(findings): return findings, True` (defensive shape guard).
  if (vectors.length !== findings.length) {
    return [[...findings], true];
  }

  // Greedy: walk in input order; for each finding still surviving, absorb any subsequent same-file
  // finding whose cosine ≥ threshold. Each slot is a MUTABLE record bundling the running absorber, its
  // current vector, and a consumed flag. Bundling into one record lets us iterate + mutate by reference
  // (no parallel-array bracket-indexing), keeping the `slot.vec = ...` replacement explicit when a
  // higher-confidence finding takes over the slot.
  type Slot = { absorber: ReviewFindingV1; vec: ReadonlyArray<number>; consumed: boolean };
  const slots: Array<Slot> = findings.map((finding, idx) => ({
    absorber: finding,
    // eslint-disable-next-line security/detect-object-injection -- `idx` is the `.map` numeric index into the just-validated equal-length `vectors`, not user input
    vec: vectors[idx]!,
    consumed: false,
  }));
  const out: Array<ReviewFindingV1> = [];

  for (let i = 0; i < slots.length; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded numeric loop index into a local array, not user input
    const slotI = slots[i]!;
    if (slotI.consumed) {
      continue;
    }
    for (let j = i + 1; j < slots.length; j += 1) {
      // eslint-disable-next-line security/detect-object-injection -- `j` is a bounded numeric loop index into a local array, not user input
      const slotJ = slots[j]!;
      if (slotJ.consumed) {
        continue;
      }
      if (slotJ.absorber.file !== slotI.absorber.file) {
        continue;
      }
      const sim = cosine(slotI.vec, slotJ.vec);
      if (sim < threshold) {
        continue;
      }
      // Higher-confidence absorbs the other (Python: strictly-greater → `f_j` wins; ties keep absorber).
      if (slotJ.absorber.confidence > slotI.absorber.confidence) {
        slotI.absorber = merge(slotJ.absorber, slotI.absorber);
        // The absorbing slot's vector becomes f_j's (so further j' compare against the new absorber).
        slotI.vec = slotJ.vec;
      } else {
        slotI.absorber = merge(slotI.absorber, slotJ.absorber);
      }
      slotJ.consumed = true;
    }
    out.push(slotI.absorber);
  }

  return [out, false];
}
