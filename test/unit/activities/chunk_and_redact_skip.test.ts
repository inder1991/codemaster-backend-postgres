// F9 / P1-E + P1-F — doChunkAndRedact must SKIP oversize files (would block the runner event loop in
// read + the synchronous tree-sitter parse) and binary files (would decode to U+FFFD soup + be sent to the
// paid LLM), chunking only the normal text files.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { doChunkAndRedact } from "#backend/activities/chunk_and_redact.activity.js";
import { ChunkerRegistry } from "#backend/chunking/selector.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "cmb-f9-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("doChunkAndRedact — oversize + binary skip (F9 / P1-E, P1-F)", () => {
  it("chunks a normal file but skips an oversize file and a binary file", async () => {
    // Normal small TS file → should produce chunks.
    writeFileSync(join(ws, "normal.ts"), "export const greet = (n: string): string => `hi ${n}`;\n");
    // Oversize file (> 2 MiB) with FEW lines — the 50k-line cap would miss it; the byte cap catches it.
    writeFileSync(join(ws, "big.ts"), `const x = "${"a".repeat(2 * 1024 * 1024 + 16)}";\n`);
    // Binary file with a NUL byte in the head → must be skipped before chunk/LLM.
    writeFileSync(join(ws, "blob.ts"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]));

    const chunks = await doChunkAndRedact({
      workspacePath: ws,
      files: ["normal.ts", "big.ts", "blob.ts"],
      changedLineRanges: {},
      registry: ChunkerRegistry.build(),
    });

    const paths = new Set(chunks.map((c) => c.path));
    expect(paths.has("normal.ts")).toBe(true); // the normal file IS chunked
    expect(paths.has("big.ts")).toBe(false); // oversize → skipped (no event-loop block)
    expect(paths.has("blob.ts")).toBe(false); // binary → skipped (no LLM soup)
  });
});
