// Section-anchored markdown chunker — pure function: turns one markdown file into a tuple of
// section-anchored MarkdownChunkV1. Anchoring on ATX headings keeps each chunk a coherent thought;
// the heading_path metadata makes the citation legible without re-parsing the source at render time.
// Parity-proven byte-for-byte in test/parity/chunking.parity.test.ts.
//
// Algorithm (one linear pass):
//   1. Walk lines, tracking fence state, the active H1/H2/H3 heading_path, and a pending line buffer.
//   2. On an H1/H2/H3 heading at column 0: flush pending; (re)compute heading_path; the heading line
//      itself becomes the first line of the next chunk. H4+ is body content, not structural.
//   3. After all lines, flush the final pending content.
//   4. Final pass: split any chunk whose body exceeds target_chars at blank-line paragraph boundaries.
//   5. Rewrite chunk_index sequentially.
// Empty pending blocks (back-to-back headings, leading blank lines) never emit a chunk.
//
// NOTE: this module deliberately does NOT mint chunk_id — MarkdownChunkV1 carries no chunk_id field
// (it keys on (relative_path, chunk_index)). The deterministic chunk_id derivation for the v8/v10
// evidence pipeline lives in computeChunkId (#contracts/diff_chunking.v1).

import { MarkdownChunkV1 } from "#contracts/markdown_chunk.v1.js";

// Soft target chunk size; hard upper bound on a chunk body. Mirror contracts/markdown_chunks/v1.py.
export const DEFAULT_TARGET_CHARS = 1500;
export const MAX_CHUNK_CHARS = 6000;

// ── Whitespace stripping with a fixed code-point set ───────────────────────────────────────────────
// The whitespace set used here differs from JS String.prototype.trim(): it ALSO strips
// U+001C–U+001F and U+0085 but NOT U+FEFF, whereas JS trim() does the opposite. The exact set below
// is the load-bearing invariant — whitespace-only chunk suppression and body trimming depend on it.
const PY_WHITESPACE_CODEPOINTS: ReadonlyArray<number> = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000,
];
const PY_WHITESPACE: ReadonlySet<string> = new Set(
  PY_WHITESPACE_CODEPOINTS.map((cp) => String.fromCodePoint(cp)),
);

/** Strip the fixed whitespace set (see above) from both ends, argless-strip style. */
function pyStrip(text: string): string {
  const chars = [...text]; // iterate by code point, not UTF-16 code unit
  let lo = 0;
  let hi = chars.length;
  while (lo < hi && PY_WHITESPACE.has(chars.at(lo)!)) {
    lo += 1;
  }
  while (hi > lo && PY_WHITESPACE.has(chars[hi - 1]!)) {
    hi -= 1;
  }
  return chars.slice(lo, hi).join("");
}

/** Strip ONLY newline chars from both ends. */
function stripNewlines(text: string): string {
  let lo = 0;
  let hi = text.length;
  while (lo < hi && text.charAt(lo) === "\n") {
    lo += 1;
  }
  while (hi > lo && text[hi - 1] === "\n") {
    hi -= 1;
  }
  return text.slice(lo, hi);
}

/** Slice the first `n` characters by CODE POINT (not UTF-16 code unit). */
function codePointSlice(text: string, n: number): string {
  const chars = [...text];
  if (chars.length <= n) {
    return text;
  }
  return chars.slice(0, n).join("");
}

// `^(#{1,6})\s+(.*?)\s*#*\s*$` — ATX heading; `^(?:```|~~~)` — fence at column 0. Realistic inputs
// are ASCII whitespace; JS `\s` is unicode-aware, and the capture/trim below reconciles either way.
const ATX_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^(?:```|~~~)/;

type HeadingLevelTitle = { readonly level: number; readonly title: string };

/** Parse an ATX heading line → (level, stripped title) or null. */
function headingLevelAndTitle(line: string): HeadingLevelTitle | null {
  const m = ATX_HEADING.exec(line);
  if (!m) {
    return null;
  }
  return { level: m[1]!.length, title: pyStrip(m[2]!) };
}

/**
 * Update heading_path when entering a heading at `level`.
 * H1 resets to a single entry; H2/H3 extend or replace the deepest slot; H4+ leave path unchanged.
 */
function pushPath(path: ReadonlyArray<string>, level: number, title: string): Array<string> {
  if (level === 1) {
    return [title];
  }
  if (level === 2) {
    return path.length > 0 ? [path[0]!, title] : [title];
  }
  if (level === 3) {
    if (path.length >= 2) {
      return [path[0]!, path[1]!, title];
    }
    if (path.length === 1) {
      return [path[0]!, "", title];
    }
    return ["", "", title];
  }
  return [...path]; // H4+ unchanged
}

/** Internal mutable chunk shape used during the linear pass (before chunk_index rewrite). */
type DraftChunk = {
  relative_path: string;
  chunk_index: number;
  heading_path: ReadonlyArray<string>;
  body: string;
  start_line: number;
  end_line: number;
};

/**
 * Break one oversize chunk along blank-line paragraph boundaries. Each shard inherits heading_path;
 * chunk_index is rewritten by the caller after all shards land.
 */
function splitLongChunk(chunk: DraftChunk, targetChars: number): Array<DraftChunk> {
  if (chunk.body.length <= targetChars) {
    return [chunk];
  }

  const lines = chunk.body.split("\n");
  const shards: Array<DraftChunk> = [];
  let current: Array<string> = [];
  let currentStartOffset = 0; // lines from chunk.start_line

  const emit = (): void => {
    if (current.length === 0) {
      return;
    }
    const body = stripNewlines(current.join("\n"));
    if (pyStrip(body) === "") {
      return;
    }
    shards.push({
      relative_path: chunk.relative_path,
      chunk_index: 0, // rewritten later
      heading_path: chunk.heading_path,
      body: codePointSlice(body, MAX_CHUNK_CHARS),
      start_line: chunk.start_line + currentStartOffset,
      end_line: chunk.start_line + currentStartOffset + current.length - 1,
    });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines.at(i)!;
    current.push(line);
    // Joined length, counting CODE POINTS (not UTF-16 units): sum of each line's length plus 1 for "\n".
    let joinedLen = 0;
    for (const lineInner of current) {
      joinedLen += [...lineInner].length + 1;
    }
    if (joinedLen >= targetChars && pyStrip(line) === "") {
      emit();
      current = [];
      currentStartOffset = i + 1;
    }
  }
  emit();

  if (shards.length === 0) {
    // Couldn't find a blank-line break — return the original capped at MAX_CHUNK_CHARS.
    return [
      {
        relative_path: chunk.relative_path,
        chunk_index: chunk.chunk_index,
        heading_path: chunk.heading_path,
        body: codePointSlice(chunk.body, MAX_CHUNK_CHARS),
        start_line: chunk.start_line,
        end_line: chunk.end_line,
      },
    ];
  }
  return shards;
}

/** Arguments to {@link chunkMarkdown} — keyword-only. */
export type ChunkMarkdownArgs = {
  readonly relative_path: string;
  readonly body: string;
  readonly target_chars?: number;
};

/**
 * Carve `body` into section-anchored chunks.
 *
 * @param relative_path workspace-relative path, copied verbatim onto every chunk for citation.
 * @param body full file contents.
 * @param target_chars soft target chunk length (default {@link DEFAULT_TARGET_CHARS}); sections
 *   shorter than this are emitted whole, longer ones split at the next paragraph boundary.
 */
export function chunkMarkdown(args: ChunkMarkdownArgs): Array<MarkdownChunkV1> {
  const { relative_path, body } = args;
  const targetChars = args.target_chars ?? DEFAULT_TARGET_CHARS;

  if (!body) {
    return [];
  }

  let lines = body.split("\n");
  // str.split("\n") yields a trailing "" for bodies ending in a newline; strip it so 1-based line
  // numbers reflect "human" line counts (the last newline isn't its own line).
  if (lines.length > 0 && lines[lines.length - 1] === "" && body.endsWith("\n")) {
    lines = lines.slice(0, -1);
  }

  const chunks: Array<DraftChunk> = [];

  let insideFence = false;
  let headingPath: ReadonlyArray<string> = [];
  let pending: Array<string> = [];
  let pendingStart: number | null = null;
  let pendingPath: ReadonlyArray<string> = [];

  const flush = (endLine: number): void => {
    if (pending.length === 0) {
      return;
    }
    const text = stripNewlines(pending.join("\n"));
    if (pyStrip(text) === "") {
      pending = [];
      pendingStart = null;
      return;
    }
    chunks.push({
      relative_path,
      chunk_index: 0, // rewritten after split pass
      heading_path: pendingPath,
      body: codePointSlice(text, MAX_CHUNK_CHARS),
      start_line: pendingStart ?? 1,
      end_line: endLine,
    });
    pending = [];
    pendingStart = null;
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines.at(idx)!;
    const lineNo = idx + 1;

    // Toggle fenced state on lines starting with ``` or ~~~ at column 0.
    if (FENCE.test(line)) {
      insideFence = !insideFence;
      if (pendingStart === null) {
        pendingStart = lineNo;
      }
      pending.push(line);
      continue;
    }

    if (insideFence) {
      if (pendingStart === null) {
        pendingStart = lineNo;
      }
      pending.push(line);
      continue;
    }

    const heading = headingLevelAndTitle(line);
    if (heading && heading.level <= 3) {
      // Flush whatever was accumulating up to (but not including) the heading line.
      flush(lineNo - 1);
      headingPath = pushPath(headingPath, heading.level, heading.title);
      pendingPath = headingPath;
      pendingStart = lineNo;
      pending.push(line);
      continue;
    }

    // Plain content line.
    if (pendingStart === null) {
      pendingStart = lineNo;
      pendingPath = headingPath;
    }
    pending.push(line);
  }

  flush(lines.length);

  // Split chunks exceeding target_chars at paragraph boundaries.
  const expanded: Array<DraftChunk> = [];
  for (const c of chunks) {
    expanded.push(...splitLongChunk(c, targetChars));
  }

  // Rewrite chunk_index sequentially and validate through the contract (parity with Pydantic).
  return expanded.map((c, i) =>
    MarkdownChunkV1.parse({
      relative_path: c.relative_path,
      chunk_index: i,
      heading_path: [...c.heading_path],
      body: c.body,
      start_line: c.start_line,
      end_line: c.end_line,
    }),
  );
}
