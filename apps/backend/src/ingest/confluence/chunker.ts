// Confluence HTML -> chunks — tiktoken cl100k_base chunker.
//
// Pure-function chunker. Takes a Confluence page's plain-text body, walks it into token-counted
// chunks with overlap so embedding-time context doesn't lose continuity at chunk boundaries.
//
// Locked behaviour:
//   * `<script>`, `<style>`, `<svg>` elements are dropped entirely before chunking.
//   * Whitespace runs collapsed; HTML entity refs decoded once (CPython `html.unescape` analogue).
//   * Code blocks (``` fenced) are atomic — never split inside.
//   * Token counting uses tiktoken cl100k_base via js-tiktoken (byte-identical to the Python encoder;
//     verified by the golden token_count + content_sha256 vectors in the unit test).
//   * Each chunk is prefixed with `# <page_title>\n\n` so embedding similarity captures page-level
//     topic even for mid-page chunks.
//   * Hard upper bound: CHUNK_HARD_UPPER_BOUND_TOKENS (2000) is documented for oversized code blocks;
//     an oversized code block is emitted as a single atomic chunk (the Python does NOT hard-split it,
//     so neither do we — code-block atomicity wins over the soft bound).
//
// PURE: no I/O, no clock, no random. The js-tiktoken encoder is initialised once at module load
// (the analogue of the Python module-level `_ENCODER`); it runs in the Node runtime (these primitives
// are called from activities, never from a workflow body — per the task constraints).
//
// Python `re` -> JS RegExp translation notes:
//   - re.IGNORECASE -> "i"; re.DOTALL -> "s"; replace-all (re.sub) -> "g".
//   - the dropped-tag block regex uses a named backreference `(?P<tag>...)(?P=tag)` -> `(?<tag>...)\k<tag>`.
//   - `re.split` with a capturing group yields alternating [prose, code, prose, ...] -> JS
//     `String.prototype.split(regex_with_capture)` produces the same alternation.

import { getEncoding } from "js-tiktoken";
import { createHash } from "node:crypto";

import { htmlUnescape } from "#backend/security/html_unescape.js";

// ─── Token constants ──────────────────────────────────────────────

export const CHUNK_HARD_UPPER_BOUND_TOKENS = 2000 as const;
export const CHUNK_OVERLAP_TOKENS = 50 as const;
export const CHUNK_TARGET_TOKENS = 600 as const;
export const CHUNK_TARGET_TOKENS_MAX = 800 as const;
export const CHUNK_TARGET_TOKENS_MIN = 400 as const;

// Module-level encoder — initialised once (js-tiktoken bundles the cl100k_base BPE ranks).
const ENCODER = getEncoding("cl100k_base");

// ─── Regexes (verbatim ports) ─────────────────────────────────────

// Tags whose contents are dropped wholesale before text extraction.
const DROPPED_TAGS = ["script", "style", "svg"] as const;
// The pattern is built from a hardcoded literal tag list (no user input); the RegExp constructor is
// only needed for the named-backreference (`(?<tag>...)\k<tag>`).
// eslint-disable-next-line security/detect-non-literal-regexp -- hardcoded literal tag list, no user input
const DROPPED_TAG_BLOCK_RE = new RegExp(
  `<(?<tag>${DROPPED_TAGS.join("|")})\\b[^>]*>.*?</\\k<tag>>`,
  "gis",
);

// Replace block-level structure markers with newlines so paragraph splitting works after
// tag-stripping. Keeping <br> too.
const BLOCK_MARKERS_RE =
  /<\/?(?:p|div|h[1-6]|li|ol|ul|tr|td|th|blockquote|pre|br)\b[^>]*>/gi;

const TAG_RE = /<[^>]+>/g;
const WS_RE = /[ \t]+/g;
const PARA_BOUNDARY_RE = /\n\n+/g;

// Code-block fence splitter — alternating prose / fenced-code segments.
const CODE_BLOCK_RE = /(```[\s\S]*?```)/;

// Sentence-boundary splitter (Python: re.split(r"(?<=[.!?])\s+", text)).
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+/;

// ─── Public types ────────────────────────────────────────────────

/** One token-counted chunk of a Confluence page body. */
export type ChunkV1 = {
  readonly chunk_index: number;
  readonly body: string;
  readonly heading_path: ReadonlyArray<string>;
  readonly token_count: number;
};

// ─── Public functions ─────────────────────────────────────────────

/**
 * Strip Confluence storage-format HTML to plain text. Conservative: keep paragraph + heading
 * structure as double newlines so the chunker can split there; drop everything else.
 */
export function htmlToText(bodyHtml: string): string {
  if (!bodyHtml) {
    return "";
  }
  let s = bodyHtml.replace(DROPPED_TAG_BLOCK_RE, " ");
  s = s.replace(BLOCK_MARKERS_RE, "\n\n");
  s = s.replace(TAG_RE, "");
  s = htmlUnescape(s);
  s = s.replace(WS_RE, " ");
  // Collapse runs of >2 newlines.
  s = s.replace(PARA_BOUNDARY_RE, "\n\n");
  return s.trim();
}

/** Token count via tiktoken cl100k_base. */
export function countTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return ENCODER.encode(text).length;
}

/**
 * Hex SHA-256 of the UTF-8 bytes of `text` — the per-chunk content hash the upsert path uses to
 * short-circuit re-embedding. Provided here as the pure primitive (the DB/embed wiring is out of
 * scope for this module). PURE: node:crypto `createHash` is a hash, not a random source, so it is not
 * banned by the clock/random gate.
 */
export function contentSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Token-counted chunking with code-block atomicity, 400-800 token target, 50-token overlap.
 *
 * Each chunk's body is prefixed with `# <pageTitle>\n\n` so embedding similarity captures page-level
 * topic even for mid-page chunks. Code blocks (``` fenced) are atomic — never split inside.
 *
 */
export function chunkSanitizedBody({
  body,
  pageTitle,
  headingPath,
}: {
  body: string;
  pageTitle: string;
  headingPath: ReadonlyArray<string>;
}): ReadonlyArray<ChunkV1> {
  const titlePrefix = `# ${pageTitle}\n\n`;
  const titleTokens = countTokens(titlePrefix);
  const proseSoftLimit = CHUNK_TARGET_TOKENS_MAX - titleTokens;

  const atoms = buildAtoms(body, proseSoftLimit);
  if (atoms.length === 0) {
    return [];
  }

  return packAtomsIntoChunks({ atoms, titlePrefix, titleTokens, headingPath });
}

// ─── Internal helpers ─────────────────────────────────────────────

type Atom = readonly [text: string, isCode: boolean];

/**
 * Split `body` into (text, isCode) atomic units. Prose is paragraph-split, then sentence-split when a
 * paragraph exceeds `proseSoftLimit` tokens. Code blocks are kept atomic.
 */
function buildAtoms(body: string, proseSoftLimit: number): Array<Atom> {
  const atoms: Array<Atom> = [];
  // String.split with a capturing group gives alternating [prose, code, prose, ...] (like Python
  // re.split with a capturing group).
  const rawSegments = body.split(CODE_BLOCK_RE);
  for (const [i, seg] of rawSegments.entries()) {
    const isCode = i % 2 === 1;
    if (isCode) {
      if (seg.trim()) {
        atoms.push([seg, true]);
      }
    } else {
      for (const rawPara of seg.split(PARA_BOUNDARY_RE)) {
        const para = rawPara.trim();
        if (para) {
          addProseAtoms(para, proseSoftLimit, atoms);
        }
      }
    }
  }
  return atoms;
}

/** Append `text` as one or more prose atoms, sentence-splitting if oversized. */
function addProseAtoms(text: string, proseSoftLimit: number, atoms: Array<Atom>): void {
  if (countTokens(text) <= proseSoftLimit) {
    atoms.push([text, false]);
    return;
  }
  // Oversized paragraph — split at sentence boundaries.
  const sentences = text.split(SENTENCE_SPLIT_RE);
  let buf = "";
  for (const sentence of sentences) {
    if (countTokens(sentence) > proseSoftLimit) {
      if (buf) {
        atoms.push([buf.trim(), false]);
        buf = "";
      }
      wordSplitAtom(sentence, proseSoftLimit, atoms);
    } else {
      const candidate = buf ? `${buf} ${sentence}` : sentence;
      if (countTokens(candidate) > proseSoftLimit) {
        if (buf) {
          atoms.push([buf.trim(), false]);
        }
        buf = sentence;
      } else {
        buf = candidate;
      }
    }
  }
  if (buf) {
    atoms.push([buf.trim(), false]);
  }
}

/** Word-boundary sub-split for sentences that exceed `proseSoftLimit`. */
function wordSplitAtom(sentence: string, proseSoftLimit: number, atoms: Array<Atom>): void {
  // Python `str.split()` (no args) splits on runs of whitespace and drops empties.
  const words = sentence.split(/\s+/).filter((w) => w.length > 0);
  let subBuf = "";
  for (const word of words) {
    const candidate = subBuf ? `${subBuf} ${word}` : word;
    if (countTokens(candidate) > proseSoftLimit) {
      if (subBuf) {
        atoms.push([subBuf, false]);
      }
      subBuf = word;
    } else {
      subBuf = candidate;
    }
  }
  if (subBuf) {
    atoms.push([subBuf, false]);
  }
}

/** Mutable accumulator for one chunk window during atom packing. */
class Window {
  private readonly titlePrefix: string;
  private readonly titleTokens: number;
  private readonly headingPath: ReadonlyArray<string>;
  // The Python `_Window` keeps two parallel arrays (`parts`, `parts_is_code`) it later `zip`s; we
  // store them as one array of pairs so the lockstep iteration needs no bracket-index access.
  private parts: Array<{ text: string; isCode: boolean }> = [];
  private tokens: number;
  public lastProseIds: Array<number> = [];

  public constructor(
    titlePrefix: string,
    titleTokens: number,
    headingPath: ReadonlyArray<string>,
  ) {
    this.titlePrefix = titlePrefix;
    this.titleTokens = titleTokens;
    this.headingPath = headingPath;
    this.tokens = titleTokens;
  }

  /** Emit window as a ChunkV1, then reset the window state. */
  public flush(chunks: Array<ChunkV1>, overlapText = ""): void {
    if (this.parts.length === 0) {
      return;
    }
    const content = this.parts.map((p) => p.text).join("\n\n");
    const bodyText =
      this.titlePrefix + (overlapText ? `${overlapText}\n\n${content}` : content);
    chunks.push({
      chunk_index: chunks.length,
      body: bodyText,
      heading_path: this.headingPath,
      token_count: countTokens(bodyText),
    });
    this.updateProseIds();
    this.parts = [];
    this.tokens = this.titleTokens;
  }

  private updateProseIds(): void {
    const prose = this.parts.filter((p) => !p.isCode).map((p) => p.text);
    if (prose.length > 0) {
      const ids = ENCODER.encode(prose.join("\n\n"));
      this.lastProseIds =
        ids.length >= CHUNK_OVERLAP_TOKENS ? ids.slice(-CHUNK_OVERLAP_TOKENS) : [...ids];
    } else {
      this.lastProseIds = [];
    }
  }

  public overlapText(): string {
    return this.lastProseIds.length > 0 ? ENCODER.decode(this.lastProseIds) : "";
  }

  public add(atomText: string, isCode: boolean, atomTokens: number): void {
    const sep = this.parts.length > 0 ? 2 : 0;
    this.parts.push({ text: atomText, isCode });
    this.tokens += atomTokens + sep;
  }

  public wouldOverflow(atomTokens: number): boolean {
    const sep = this.parts.length > 0 ? 2 : 0;
    return this.tokens + atomTokens + sep > CHUNK_TARGET_TOKENS_MAX;
  }
}

/** Greedily pack atoms into ChunkV1 windows with token-counted overlap. */
function packAtomsIntoChunks({
  atoms,
  titlePrefix,
  titleTokens,
  headingPath,
}: {
  atoms: ReadonlyArray<Atom>;
  titlePrefix: string;
  titleTokens: number;
  headingPath: ReadonlyArray<string>;
}): ReadonlyArray<ChunkV1> {
  const chunks: Array<ChunkV1> = [];
  const win = new Window(titlePrefix, titleTokens, headingPath);

  for (const [atomText, isCode] of atoms) {
    const atomTokens = countTokens(atomText);

    // Oversized atom — flush current window, emit atom solo.
    if (titleTokens + atomTokens > CHUNK_TARGET_TOKENS_MAX) {
      win.flush(chunks, win.overlapText());
      const bodyText = titlePrefix + atomText;
      chunks.push({
        chunk_index: chunks.length,
        body: bodyText,
        heading_path: headingPath,
        token_count: countTokens(bodyText),
      });
      win.lastProseIds = isCode ? [] : proseTailIds(atomText);
      continue;
    }

    // Window would overflow — flush then start fresh with overlap.
    if (win.wouldOverflow(atomTokens)) {
      const overlap = win.overlapText();
      win.flush(chunks, overlap);
      if (overlap) {
        win.add(overlap, false, countTokens(overlap));
      }
    }

    win.add(atomText, isCode, atomTokens);
  }

  win.flush(chunks, win.overlapText());
  return chunks;
}

/** Return the last CHUNK_OVERLAP_TOKENS tiktoken IDs of `text`. */
function proseTailIds(text: string): Array<number> {
  const ids = ENCODER.encode(text);
  return ids.length >= CHUNK_OVERLAP_TOKENS ? ids.slice(-CHUNK_OVERLAP_TOKENS) : [...ids];
}
