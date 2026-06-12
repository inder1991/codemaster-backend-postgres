// pgvector_literal — the ONE shared parser-safe pgvector text-literal formatter (W1.3 / RL3).
//
// RL3 (docs/audits/2026-06-11-audit-recovered-lenses.md, `ann_port.ts` + `postgres_confluence_retrieval.ts`):
// the query vector used to be serialized component-wise via `String(x)`, which yields EXPONENTIAL
// notation for very small / very large magnitudes (`String(1e-7) === "1e-7"`, `String(1e21) === "1e+21"`).
// A denormalized/exponential component can emit a literal pgvector's parser rejects, throwing the whole
// ANN query (uncaught on the override path) and degrading that chunk's retrieval. Both ANN adapters now
// bind through THIS formatter, which:
//
//   1. always emits PLAIN DECIMAL (no exponent) — expanded from the float's SHORTEST repr, so the
//      expansion is value-exact: `Number(formatted) === original` for every finite float64 (round-trip
//      unit-tested incl. denormals, very small, negative, >=1e21);
//   2. fails LOUD on non-finite components (NaN / ±Infinity) — those cannot anchor a cosine search and
//      must surface as a caller bug, not a malformed SQL literal.
//
// Pure string arithmetic — no clock / RNG / IO (gate-clean anywhere).

// Shortest-repr exponential float shape: sign, integer digits, optional fraction, exponent. The
// fraction group is bounded (no nested quantifier ambiguity) — `String(x)` on a finite number is at
// most ~25 chars, so this is linear-time on tiny inputs (security/detect-unsafe-regex is a false
// positive on the optional non-capturing group; kept simple + anchored).
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, linear on String(number) reprs (<=25 chars), no overlapping quantifiers
const EXPONENTIAL_REPR = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/;

/** Expand an exponential-notation float repr (e.g. "1e-7", "-2.5e+22") into plain decimal, exactly. */
function expandExponential(repr: string): string {
  const match = EXPONENTIAL_REPR.exec(repr);
  if (match === null) {
    // No exponent part — String(x) was already plain decimal.
    return repr;
  }
  const sign = match[1] ?? "";
  const intPart = match[2] ?? "";
  const fracPart = match[3] ?? "";
  const exponent = Number(match[4]);
  const digits = `${intPart}${fracPart}`;
  // Index (within `digits`) where the decimal point lands after applying the exponent.
  const pointIndex = intPart.length + exponent;
  if (pointIndex <= 0) {
    return `${sign}0.${"0".repeat(-pointIndex)}${digits}`;
  }
  if (pointIndex >= digits.length) {
    return `${sign}${digits}${"0".repeat(pointIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
}

/** Format ONE float component as parser-safe plain decimal (value-exact; throws on non-finite). */
export function formatPgvectorFloat(x: number): string {
  if (!Number.isFinite(x)) {
    throw new Error(`pgvector literal: non-finite vector component (${String(x)})`);
  }
  // `String(-0)` drops the sign ("0"); keep it so the literal round-trips value-exactly under
  // Object.is (pgvector parses "-0" fine; cosine arithmetic treats it identically to 0).
  if (Object.is(x, -0)) {
    return "-0";
  }
  return expandExponential(String(x));
}

/**
 * Format the query vector as the pgvector text literal `"[f1,f2,...]"` (the Python `qvec` bind shape).
 * pg cannot encode a raw JS array for the `vector` column, so callers bind this text + `CAST AS vector`.
 * Every component is plain decimal (never exponential) and round-trips value-exactly.
 */
export function formatPgvectorLiteral(vec: ReadonlyArray<number>): string {
  return `[${vec.map((x) => formatPgvectorFloat(x)).join(",")}]`;
}
