import { describe, it, expect } from "vitest";

import { canonicalize } from "./canonical.js";

describe("canonicalize", () => {
  it("sorts object keys recursively and stringifies stably", () => {
    const a = canonicalize({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalize({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves Decimal-as-string (Pydantic emits Decimal as a string, not a number)", () => {
    expect(canonicalize({ cost: "1.50" })).toBe('{"cost":"1.50"}');
  });

  it("normalizes an RFC3339 timestamp to microsecond-precision UTC (matches Python isoformat)", () => {
    expect(canonicalize({ t: "2026-06-03T10:00:00.000000+00:00" })).toBe(
      '{"t":"2026-06-03T10:00:00.000000+00:00"}',
    );
    // a "Z"/millisecond form normalizes to the same canonical microsecond+offset form
    expect(canonicalize({ t: "2026-06-03T10:00:00.000Z" })).toBe(
      '{"t":"2026-06-03T10:00:00.000000+00:00"}',
    );
  });

  it("throws on a bare float (contracts must emit Decimal-as-string or int)", () => {
    expect(() => canonicalize({ x: 1.5 })).toThrow(/bare float/);
  });

  it("allows integers", () => {
    expect(canonicalize({ n: 42 })).toBe('{"n":42}');
  });
});
