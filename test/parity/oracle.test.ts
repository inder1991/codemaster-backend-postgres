import { afterAll, describe, expect, it } from "vitest";

import { pyRef, shutdownRef } from "./oracle.js";

afterAll(() => shutdownRef());

// Proves the whole harness composes: spawn the frozen submodule's venv python, import codemaster,
// run a real PURE function (chunk_markdown), and return its canonical-JSON output over the JSONL
// protocol. This is the end-to-end smoke for the parity oracle itself.
describe("parity oracle ↔ frozen Python ref", () => {
  it("round-trips a real pure function (chunk_markdown) through the ref process", async () => {
    const r = await pyRef({
      pyModule: "codemaster.chunking.markdown_chunker",
      pyCallable: "chunk_markdown",
      kwargs: { relative_path: "a.md", body: "# Title\n\nsome body text here" },
    });
    expect(r.ok, r.err).toBe(true);
    const chunks = JSON.parse(r.out!) as Array<Record<string, unknown>>;
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
    // MarkdownChunkV1 fields (verified against the frozen model_dump):
    expect(chunks[0]).toHaveProperty("relative_path", "a.md");
    expect(chunks[0]).toHaveProperty("start_line");
    expect(chunks[0]).toHaveProperty("body");
  }, 30_000);

  it("reports ok:false (does not crash the process) for a bad callable", async () => {
    const r = await pyRef({
      pyModule: "codemaster.chunking.markdown_chunker",
      pyCallable: "no_such_function",
      kwargs: {},
    });
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/AttributeError|no_such_function/);
  }, 30_000);
});
