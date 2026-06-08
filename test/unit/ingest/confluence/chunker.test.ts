// Unit tests for the Confluence chunker — 1:1 port of the frozen Python
// vendor/codemaster-py/tests/unit/ingest/confluence/test_chunker_token_invariants.py + golden vectors
// (full bodies, token counts, content_sha256) captured from the LIVE frozen Python chunker.
//
// The token windows / overlap / code-block atomicity are defined in cl100k_base token space; the JS
// js-tiktoken encoder is byte-identical to the Python tiktoken encoder (verified separately, and the
// golden token_count + content_sha256 vectors below prove it transitively — a divergent tokenizer
// would shift every chunk boundary and break the sha equality).

import { describe, expect, it } from "vitest";

import {
  CHUNK_HARD_UPPER_BOUND_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_TARGET_TOKENS_MAX,
  CHUNK_TARGET_TOKENS_MIN,
  chunkSanitizedBody,
  contentSha256,
  countTokens,
  htmlToText,
} from "#backend/ingest/confluence/chunker.js";

describe("chunker constants", () => {
  it("token window matches the frozen Python", () => {
    expect(CHUNK_TARGET_TOKENS_MIN).toBe(400);
    expect(CHUNK_TARGET_TOKENS_MAX).toBe(800);
    expect(CHUNK_OVERLAP_TOKENS).toBe(50);
    expect(CHUNK_HARD_UPPER_BOUND_TOKENS).toBe(2000);
  });
});

describe("htmlToText — golden vectors (frozen Python)", () => {
  const golden: ReadonlyArray<readonly [string, string]> = [
    ["<p>Hello   world</p><p>Second &amp; para</p>", "Hello world\n\nSecond & para"],
    ["<div>a<script>bad()</script>b</div>", "a b"],
    ["<h1>T</h1><br>line<br>two", "T\n\nline\n\ntwo"],
    ["", ""],
    ["<style>.x{}</style><p>only this</p>", "only this"],
  ];

  it.each(golden)("htmlToText(%j)", (html, expected) => {
    expect(htmlToText(html)).toBe(expected);
  });
});

describe("countTokens — golden vectors (frozen Python tiktoken cl100k)", () => {
  it("empty string is 0", () => {
    expect(countTokens("")).toBe(0);
  });

  it("'hello world' is 2 tokens", () => {
    expect(countTokens("hello world")).toBe(2);
  });

  it("'# My Page\\n\\nShort.' is 6 tokens", () => {
    expect(countTokens("# My Page\n\nShort.")).toBe(6);
  });

  it("longer text has more tokens", () => {
    expect(countTokens("hello world and more words here")).toBeGreaterThan(countTokens("hello"));
  });
});

describe("contentSha256 — golden vector (frozen Python _content_sha256)", () => {
  it("hex sha256 of utf-8 bytes", () => {
    const body =
      "# My Page\n\nShort page body. Short page body. Short page body. Short page body. Short page body.";
    expect(contentSha256(body)).toBe(
      "683aa4ddb4ea9669bbad1e10fbf77ebcf61b35ba407664ad40765d42044340e8",
    );
  });
});

describe("chunkSanitizedBody", () => {
  it("short body -> single chunk; exact golden body + token_count + sha", () => {
    const body = "Short page body. ".repeat(5);
    const chunks = chunkSanitizedBody({
      body,
      pageTitle: "My Page",
      headingPath: ["My Page"],
    });
    expect(chunks.length).toBe(1);
    const c = chunks[0]!;
    expect(c.body).toBe(
      "# My Page\n\nShort page body. Short page body. Short page body. Short page body. Short page body.",
    );
    expect(c.token_count).toBe(24);
    expect(c.chunk_index).toBe(0);
    expect(c.heading_path).toEqual(["My Page"]);
    expect(contentSha256(c.body)).toBe(
      "683aa4ddb4ea9669bbad1e10fbf77ebcf61b35ba407664ad40765d42044340e8",
    );
  });

  it("long body -> 4 chunks with golden token counts, all within hard bound", () => {
    const body = Array.from({ length: 400 }, (_, i) => `sentence number ${i} with content`).join(
      ". ",
    );
    const chunks = chunkSanitizedBody({ body, pageTitle: "Big Page", headingPath: ["Big Page"] });
    expect(chunks.map((c) => c.token_count)).toEqual([795, 845, 895, 530]);
    for (const c of chunks) {
      expect(c.token_count).toBeLessThanOrEqual(CHUNK_HARD_UPPER_BOUND_TOKENS);
      expect(c.body.startsWith("# Big Page\n")).toBe(true);
      // token_count field must equal counting the actual body.
      expect(c.token_count).toBe(countTokens(c.body));
    }
    expect(chunks.map((c) => c.chunk_index)).toEqual([0, 1, 2, 3]);
  });

  it("each chunk has the page-title prefix", () => {
    const body = Array.from({ length: 400 }, (_, i) => `sentence ${i}`).join(". ");
    const chunks = chunkSanitizedBody({ body, pageTitle: "The Page", headingPath: ["The Page"] });
    for (const c of chunks) {
      expect(c.body.startsWith("# The Page\n")).toBe(true);
    }
  });

  it("heading ancestry preserved", () => {
    const chunks = chunkSanitizedBody({
      body: "content body",
      pageTitle: "Top",
      headingPath: ["Top", "H1", "H2"],
    });
    expect(chunks[0]!.heading_path).toEqual(["Top", "H1", "H2"]);
  });

  it("code-block atomicity: big code block stays intact in exactly one chunk (3 chunks)", () => {
    const bigCode = "```python\n" + "x = 1\n".repeat(500) + "```";
    const body = `intro paragraph\n\n${bigCode}\n\nconclusion paragraph`;
    const chunks = chunkSanitizedBody({ body, pageTitle: "P", headingPath: ["P"] });
    expect(chunks.length).toBe(3);
    // golden token counts: [5, 2507, 6] — the oversized code block is emitted solo, atomic.
    expect(chunks.map((c) => c.token_count)).toEqual([5, 2507, 6]);
    const fullText = chunks.map((c) => c.body).join("\n---\n");
    expect(fullText.includes(bigCode)).toBe(true);
    // No chunk contains a partial code block (even fence count).
    for (const c of chunks) {
      expect((c.body.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  it("small code block stays inline with surrounding prose (single chunk, exact golden body)", () => {
    const smallCode = "```python\nprint('hello')\n```";
    const body = `Before the code.\n\n${smallCode}\n\nAfter the code.`;
    const chunks = chunkSanitizedBody({ body, pageTitle: "P", headingPath: ["P"] });
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.body).toBe(
      "# P\n\nBefore the code.\n\n```python\nprint('hello')\n```\n\nAfter the code.",
    );
    for (const c of chunks) {
      expect((c.body.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  it("overlap present between adjacent chunks", () => {
    const body = Array.from({ length: 400 }, (_, i) => `unique_sentence_${i}`).join(". ");
    const chunks = chunkSanitizedBody({ body, pageTitle: "P", headingPath: ["P"] });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const c0Tail = new Set(chunks[0]!.body.split(/\s+/).slice(-30));
    const c1Head = new Set(chunks[1]!.body.split(/\s+/).slice(0, 80));
    const overlap = [...c0Tail].filter((w) => c1Head.has(w));
    expect(overlap.length).toBeGreaterThanOrEqual(3);
  });

  it("chunk_index is monotonic 0..n-1", () => {
    const body = Array.from({ length: 400 }, (_, i) => `x${i}`).join(". ");
    const chunks = chunkSanitizedBody({ body, pageTitle: "P", headingPath: ["P"] });
    expect(chunks.map((c) => c.chunk_index)).toEqual(
      Array.from({ length: chunks.length }, (_, i) => i),
    );
  });

  it("token_count field is populated and matches the body", () => {
    const chunks = chunkSanitizedBody({ body: "Some content.", pageTitle: "P", headingPath: ["P"] });
    for (const c of chunks) {
      expect(c.token_count).toBeGreaterThan(0);
      expect(c.token_count).toBe(countTokens(c.body));
    }
  });

  it("empty body -> empty list", () => {
    expect(chunkSanitizedBody({ body: "", pageTitle: "P", headingPath: ["P"] })).toEqual([]);
  });

  it("whitespace-only body -> empty list", () => {
    expect(
      chunkSanitizedBody({ body: "   \n\n   \t  ", pageTitle: "P", headingPath: ["P"] }),
    ).toEqual([]);
  });

  it("at least one chunk for non-empty content", () => {
    const chunks = chunkSanitizedBody({
      body: "Some page content here.",
      pageTitle: "P",
      headingPath: ["P"],
    });
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});
