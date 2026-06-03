import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // mirror pytest-randomly: randomize order to surface ordering deps
    sequence: { shuffle: true },
    // all tests live under a single mirrored test/ tree (src folders stay pure)
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
  },
});
