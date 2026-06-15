import { describe, it, expect } from "vitest";

import { assertGreenfieldBaseline, validateDim } from "../../../scripts/set_embedding_dimension.js";

describe("validateDim", () => {
  it("accepts 1..2000 and rejects outside / non-integer", () => {
    expect(validateDim(768)).toBe(768);
    expect(() => validateDim(4096)).toThrow(/2000/);
    expect(() => validateDim(0)).toThrow();
    expect(() => validateDim(1024.5)).toThrow();
  });
});

describe("assertGreenfieldBaseline — resize only on the seed-only baseline", () => {
  const baseline = { activeGeneration: 1, pendingGeneration: null, generationCount: 1 };

  it("accepts the seed-only baseline (active=1, no pending, one generation)", () => {
    expect(() => assertGreenfieldBaseline(baseline)).not.toThrow();
  });

  it("rejects a pending generation already in flight", () => {
    expect(() => assertGreenfieldBaseline({ ...baseline, pendingGeneration: 2 })).toThrow(/baseline/i);
  });

  it("rejects a non-seed active generation", () => {
    expect(() => assertGreenfieldBaseline({ ...baseline, activeGeneration: 2 })).toThrow(/baseline/i);
  });

  it("rejects more than the seed generation", () => {
    expect(() => assertGreenfieldBaseline({ ...baseline, generationCount: 3 })).toThrow(/baseline/i);
  });
});
