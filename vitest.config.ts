import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // mirror pytest-randomly: randomize order to surface ordering deps
    sequence: { shuffle: true },
    // all tests live under a single mirrored test/ tree (src folders stay pure)
    include: ["test/**/*.test.ts"],
    // W0.11 (XC2): NO passWithNoTests — a lane whose glob matches nothing must FAIL, not pretend
    // green. A filter typo (or a moved directory) silently disabling a whole tier is exactly the
    // unexercised-security-tier class this wave closes.
  },
});
