import { describe, it, expect } from "vitest";

// Bootstrap smoke test (Task 0.1): proves the TS toolchain compiles and Vitest runs.
// Also gives `tsc` at least one input so `npm run build` doesn't error TS18003 on the
// otherwise-empty repo. Remove once real Phase-0 tests exist.
describe("toolchain bootstrap", () => {
  it("compiles and runs", () => {
    expect(1 + 1).toBe(2);
  });
});
