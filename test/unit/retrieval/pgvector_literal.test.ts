// Unit tests for the shared parser-safe pgvector literal formatter (W1.3 / RL3).
//
// RL3 (docs/audits/2026-06-11-audit-recovered-lenses.md): the query vector used to be serialized via
// `String(x)`, which yields EXPONENTIAL notation for very small/large magnitudes (e.g. `1e-7`) and a
// denormalized/exponential literal can be rejected by pgvector's parser, throwing the whole ANN query.
// The fix is ONE shared formatter that always emits plain decimal (no exponent), value-preserving on
// round-trip (Number(formatted) === original) for every finite float64, and fail-loud on non-finite
// components (NaN/Infinity cannot anchor a cosine search).

import { describe, expect, it } from "vitest";

import { formatPgvectorLiteral } from "#backend/retrieval/pgvector_literal.js";

describe("formatPgvectorLiteral — parser-safe plain-decimal serialization (RL3)", () => {
  it("emits the bracketed comma-joined literal for a plain vector", () => {
    expect(formatPgvectorLiteral([1, -0.5, 0.25])).toBe("[1,-0.5,0.25]");
  });

  it("never emits exponential notation for any component", () => {
    const vec = [1e-7, -1e-8, 5e-324, 1.5e-10, 1e21, -2.5e22];
    const literal = formatPgvectorLiteral(vec);
    expect(literal).not.toMatch(/[eE]/);
    expect(literal.startsWith("[")).toBe(true);
    expect(literal.endsWith("]")).toBe(true);
  });

  it("round-trips every component value-exactly (Number(formatted) === original)", () => {
    const vec = [
      0,
      -0,
      1,
      -1,
      0.123456789,
      -0.987654321,
      1e-7, // String() => "1e-7" — the RL3 exponential case
      -1e-8,
      5e-324, // smallest denormal float64
      Number.MIN_VALUE,
      2.2250738585072014e-308, // smallest NORMAL float64
      1e21, // String() => "1e+21"
      -2.5e22,
      Number.MAX_SAFE_INTEGER,
      0.1 + 0.2, // 0.30000000000000004 — shortest-repr precision must survive
    ];
    const literal = formatPgvectorLiteral(vec);
    const inner = literal.slice(1, -1).split(",");
    expect(inner.length).toBe(vec.length);
    for (const [i, s] of inner.entries()) {
      expect(Number(s)).toBe(vec.at(i));
    }
  });

  it("fails loud on non-finite components (NaN / Infinity poison a cosine search)", () => {
    expect(() => formatPgvectorLiteral([0.1, Number.NaN])).toThrow(/non-finite/);
    expect(() => formatPgvectorLiteral([Number.POSITIVE_INFINITY])).toThrow(/non-finite/);
    expect(() => formatPgvectorLiteral([Number.NEGATIVE_INFINITY])).toThrow(/non-finite/);
  });
});
