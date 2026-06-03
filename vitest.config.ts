import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // mirror pytest-randomly: randomize order to surface ordering deps
    sequence: { shuffle: true },
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
  },
});
