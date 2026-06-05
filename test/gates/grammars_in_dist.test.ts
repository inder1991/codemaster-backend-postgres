// Gate (ADR-0067): the production worker loads the tree-sitter grammar .wasm from `./grammars` relative
// to the COMPILED loader (dist/apps/backend/src/backend/chunking/). tsc emits only .js, so the build
// must copy the vendored .wasm + manifest.json into dist or the worker throws at chunk/startup time.
// This gate proves (a) the build script wires the copy, and (b) the copy lands every pinned .wasm in
// dist with its manifest SHA-256 intact. Fast: runs only the copy step (no full tsc build).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const grammarsSrc = join(repoRoot, "apps", "backend", "src", "backend", "chunking", "grammars");
const grammarsDist = join(repoRoot, "dist", "apps", "backend", "src", "backend", "chunking", "grammars");

type Manifest = { grammars: Record<string, { wasm: string; sha256: string }> };

describe("build emits the tree-sitter grammars into dist (ADR-0067)", () => {
  it("the build script wires the grammar-copy step", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["build"]).toContain("build_copy_grammars");
  });

  it("copies every pinned .wasm into dist with its manifest SHA-256 intact", () => {
    // Idempotent; recursive cp creates the dist directory tree even on a clean checkout.
    execFileSync("node", [join(repoRoot, "scripts", "build_copy_grammars.mjs")], { cwd: repoRoot });

    const manifest = JSON.parse(readFileSync(join(grammarsSrc, "manifest.json"), "utf8")) as Manifest;
    const grammars = Object.values(manifest.grammars);
    expect(grammars.length).toBeGreaterThan(0);

    for (const g of grammars) {
      const distWasm = join(grammarsDist, g.wasm);
      expect(existsSync(distWasm), `${g.wasm} missing from dist after build copy`).toBe(true);
      const sha = createHash("sha256").update(readFileSync(distWasm)).digest("hex");
      expect(sha, `${g.wasm} dist SHA-256 mismatch (corrupt/stale copy)`).toBe(g.sha256);
    }
  });
});
