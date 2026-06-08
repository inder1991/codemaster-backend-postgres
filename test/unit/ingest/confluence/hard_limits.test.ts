// Unit tests for the Confluence hard-limit governance primitives — port of the frozen Python
// vendor/codemaster-py/codemaster/ingest/confluence/hard_limits.py (Sub-spec A T11) adapted per
// ADR-0075: the TS port inlines the spec-pinned fallbacks (platform_config_cache is NOT ported), and
// the count/sum helpers are PURE (they take chunk rows as args — the SQL versions live in the repo
// track, not here).
//
// Spec-pinned defaults MUST match platform_config_cache.DEFAULTS + hard_limits.py fallbacks:
//   max_default_chunks_per_space = 25, max_default_corpus_tokens = 50_000.

import { describe, expect, it } from "vitest";

import {
  type DefaultCorpusLimits,
  countDefaultChunksInSpace,
  getDefaultCorpusLimits,
  sumDefaultCorpusTokens,
  type ConfluenceChunkRow,
} from "#backend/ingest/confluence/hard_limits.js";

describe("getDefaultCorpusLimits", () => {
  it("returns the spec-pinned fallback limits (ADR-0075)", () => {
    const limits: DefaultCorpusLimits = getDefaultCorpusLimits();
    expect(limits.max_chunks_per_space).toBe(25);
    expect(limits.max_corpus_tokens).toBe(50_000);
  });
});

function row(overrides: Partial<ConfluenceChunkRow> = {}): ConfluenceChunkRow {
  return {
    space_key: "PYSEC",
    labels: ["default"],
    deleted_at: null,
    token_count: 100,
    ...overrides,
  };
}

describe("countDefaultChunksInSpace", () => {
  it("counts active default-tagged chunks for the given space only", () => {
    const rows: ReadonlyArray<ConfluenceChunkRow> = [
      row({ space_key: "PYSEC", labels: ["default"], deleted_at: null }),
      row({ space_key: "PYSEC", labels: ["default", "python"], deleted_at: null }),
      // wrong space
      row({ space_key: "OTHER", labels: ["default"], deleted_at: null }),
      // not default-tagged
      row({ space_key: "PYSEC", labels: ["python"], deleted_at: null }),
      // soft-deleted
      row({ space_key: "PYSEC", labels: ["default"], deleted_at: "2026-05-20T00:00:00.000Z" }),
    ];
    expect(countDefaultChunksInSpace(rows, "PYSEC")).toBe(2);
  });

  it("returns 0 when no rows match", () => {
    expect(countDefaultChunksInSpace([], "PYSEC")).toBe(0);
    expect(
      countDefaultChunksInSpace([row({ space_key: "OTHER" })], "PYSEC"),
    ).toBe(0);
  });
});

describe("sumDefaultCorpusTokens", () => {
  it("sums token_count across ALL active default-tagged chunks platform-wide (any space)", () => {
    const rows: ReadonlyArray<ConfluenceChunkRow> = [
      row({ space_key: "PYSEC", labels: ["default"], deleted_at: null, token_count: 100 }),
      row({ space_key: "OTHER", labels: ["default"], deleted_at: null, token_count: 250 }),
      // not default-tagged — excluded
      row({ space_key: "PYSEC", labels: ["python"], deleted_at: null, token_count: 999 }),
      // soft-deleted — excluded
      row({ space_key: "OTHER", labels: ["default"], deleted_at: "2026-05-20T00:00:00.000Z", token_count: 999 }),
    ];
    expect(sumDefaultCorpusTokens(rows)).toBe(350);
  });

  it("returns 0 for empty input", () => {
    expect(sumDefaultCorpusTokens([])).toBe(0);
  });
});
