// Unit tests for buildRetrievalQueryText — the W1.3 (RC4) code-bearing retrieval query builder.
//
// RC4 (docs/audits/2026-06-11-audit-recovered-lenses.md): the ANN/BM25 query used to be just
// `chunk.path + PR title` — the actual changed code never drove the vector search, so the dense
// embedding encoded a path string + human title instead of the semantics of the code under review.
// The builder concatenates (PR title + PR description + chunk path + chunk body), short fields FIRST
// so the 8000-char contract cap only ever truncates the body tail, never the title/description.

import { describe, expect, it } from "vitest";

import {
  buildRetrievalQueryText,
  RETRIEVAL_QUERY_MAX,
} from "#backend/review/pipeline/retrieval_query.js";

const BASE = {
  prTitle: "Add user lookup",
  prDescription: "Adds a lookup endpoint for users by name.",
  chunkPath: "src/db/users.py",
  chunkBody: `cursor.execute(f"SELECT * FROM users WHERE name = '{name}'")`,
};

describe("buildRetrievalQueryText — code-bearing query (RC4)", () => {
  it("contains title + description + path + the CHANGED CODE, in that order", () => {
    const q = buildRetrievalQueryText(BASE);
    const idxTitle = q.indexOf(BASE.prTitle);
    const idxDesc = q.indexOf(BASE.prDescription);
    const idxPath = q.indexOf(BASE.chunkPath);
    const idxBody = q.indexOf(BASE.chunkBody);
    expect(idxTitle).toBeGreaterThanOrEqual(0);
    expect(idxDesc).toBeGreaterThan(idxTitle);
    expect(idxPath).toBeGreaterThan(idxDesc);
    expect(idxBody).toBeGreaterThan(idxPath);
  });

  it("caps at the 8000-char contract bound, truncating ONLY the body tail (short fields survive)", () => {
    const q = buildRetrievalQueryText({ ...BASE, chunkBody: "x".repeat(10_000) });
    expect(q.length).toBe(RETRIEVAL_QUERY_MAX);
    expect(q).toContain(BASE.prTitle);
    expect(q).toContain(BASE.prDescription);
    expect(q).toContain(BASE.chunkPath);
  });

  it("caps a runaway PR description so it cannot crowd out the code", () => {
    const q = buildRetrievalQueryText({ ...BASE, prDescription: "d".repeat(9000) });
    expect(q).toContain(BASE.chunkBody);
  });

  it("skips empty/whitespace-only parts instead of emitting blank lines", () => {
    const q = buildRetrievalQueryText({ ...BASE, prTitle: "  ", prDescription: "" });
    expect(q).toBe(`${BASE.chunkPath}\n${BASE.chunkBody}`);
  });

  it("never returns an empty string (contract min 1): falls back to the chunk path", () => {
    const q = buildRetrievalQueryText({
      prTitle: "",
      prDescription: "",
      chunkPath: "src/a.ts",
      chunkBody: "   ",
    });
    expect(q).toBe("src/a.ts");
  });
});
