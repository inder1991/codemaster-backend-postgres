// TreeSitterTsJsChunker — AST-aware chunker for TypeScript / TSX / JavaScript / JSX. Emits one
// DiffChunkV1 per top-level function declaration, class declaration, or `const fn = () => {...}`
// arrow / function-expression assignment. Methods live inside their class chunk. Files with no AST
// candidates (constants-only) fall back to a single module-level chunk; parse errors fall back to the
// same single chunk + WARN log. The chunker itself NEVER raises on unparseable input.
//
// LINE-BASED / encoding-agnostic (ADR-0067 cond 5): chunk spans derive from tree-sitter
// startPosition.row / endPosition.row plus the endPosition.column===0 backup, and the body is sliced
// BY LINES (splitlines keepends). NO byte offsets, NO UTF-16↔UTF-8 mapping.
//
// ── tsx grammar (JSX) ───────────────────────────────────────────────────────────────────────────────
// `.tsx` routes through tree-sitter-typescript's `language_tsx()` variant, which parses JSX. The tsx
// grammar is vendored as grammars/tree-sitter-tsx.wasm (pinned in manifest.json) and the loader's
// `tsx` entry points at it. Parity verified: byte-identical parse + DiffChunkV1 output on
// jsx_body.tsx (per-decl chunks, not the module fallback).

import {
  computeChunkId,
  DiffChunkV1,
  type ChunkKind as DiffChunkKind,
} from "#contracts/diff_chunking.v1.js";

import { getParser, type GrammarName } from "./treesitter_loader.js";
import { DiffTooLargeError, type HunkRange, MAX_DIFF_LINES } from "./treesitter_python.js";

// Re-export the shared port primitives so callers can import the whole chunker surface from this
// module.
export { DiffTooLargeError, MAX_DIFF_LINES };
export type { HunkRange };

/** File extension → tree-sitter grammar kind. */
const LANG_BY_EXT: Readonly<Record<string, GrammarName>> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

/** AST node types that name a top-level reviewable unit. */
const FUNCTION_NODE_TYPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "function_expression",
]);
/** Class declaration node types. */
const CLASS_NODE_TYPES: ReadonlySet<string> = new Set([
  "class_declaration",
  "abstract_class_declaration",
]);
/** Wrappers we descend through to find the underlying declaration. */
const EXPORT_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "export_statement",
  "export_default_declaration",
]);
/** The two lexical-declaration node types whose `const fn = () => {}` / `= function() {}` initializer
 *  the chunker promotes to a function-kind chunk. */
const LEXICAL_DECL_TYPES: ReadonlySet<string> = new Set([
  "lexical_declaration",
  "variable_declaration",
]);
/** Initializer node types that mark a variable_declarator as a function-kind chunk. */
const FUNCTION_VALUE_TYPES: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
]);

/** Minimal structural shape of the tree-sitter nodes this chunker reads (subset of the
 *  web-tree-sitter Node API; lets the candidate extractor be reasoned about without a live parser). */
type TsNode = {
  readonly type: string;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  readonly children: ReadonlyArray<TsNode | null>;
};

// Newline byte (0x0A). assertDiffSize counts these to reject oversize diffs without decoding.
const NEWLINE_BYTE = 0x0a;

/** Counts newline BYTES (avoids decoding on the reject path); a body not ending in a newline still
 *  counts its final partial line. Kept local so this module owns its own entry guard. */
function assertDiffSize(body: Uint8Array): void {
  if (body.length === 0) {
    return;
  }
  let lineCount = 0;
  for (const b of body) {
    if (b === NEWLINE_BYTE) {
      lineCount += 1;
    }
  }
  if (body[body.length - 1] !== NEWLINE_BYTE) {
    lineCount += 1;
  }
  if (lineCount > MAX_DIFF_LINES) {
    throw new DiffTooLargeError({ line_count: lineCount });
  }
}

/** Returns true when range [startA, endA] overlaps [startB, endB]. */
function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA <= endB && endA >= startB;
}

/** `max(1, len(body) // 4)` — code-point length, floor division. */
function estimateTokens(body: string): number {
  const codePointLen = [...body].length;
  return Math.max(1, Math.trunc(codePointLen / 4));
}

// ── splitlines, keepends ────────────────────────────────────────────────────────────────────────
// Parity-critical: the chunker slices lines[start-1:end] where start/end are tree-sitter rows, so the
// line array MUST split on the full Unicode line-boundary set with \r\n as ONE boundary. The
// production corpus is LF-only, but the full boundary set keeps arbitrary input byte-identical.
const LINE_BOUNDARY_CODEPOINTS: ReadonlySet<number> = new Set([
  0x0a, // \n  line feed
  0x0d, // \r  carriage return
  0x0b, // \v  line tabulation
  0x0c, // \f  form feed
  0x1c, // file separator
  0x1d, // group separator
  0x1e, // record separator
  0x85, // next line (NEL)
  0x2028, // line separator
  0x2029, // paragraph separator
]);

/** Split into lines INCLUDING their terminators, with \r\n treated as a single terminator.
 *  A trailing terminator does NOT yield an empty final element. */
function splitlinesKeepends(text: string): Array<string> {
  const out: Array<string> = [];
  const chars = [...text]; // iterate by code point, not UTF-16 code unit
  let lineStart = 0;
  let i = 0;
  while (i < chars.length) {
    // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded numeric loop index into a local array, not user input
    const cp = chars[i]!.codePointAt(0)!;
    if (LINE_BOUNDARY_CODEPOINTS.has(cp)) {
      let end = i + 1;
      // \r\n is a single boundary.
      // eslint-disable-next-line security/detect-object-injection -- `end` is a bounded numeric loop index into a local array
      if (cp === 0x0d && end < chars.length && chars[end]!.codePointAt(0) === 0x0a) {
        end += 1;
      }
      out.push(chars.slice(lineStart, end).join(""));
      lineStart = end;
      i = end;
      continue;
    }
    i += 1;
  }
  if (lineStart < chars.length) {
    out.push(chars.slice(lineStart).join(""));
  }
  return out;
}

/** Lowercased final extension (including the dot), or "" when there is none. Leading-dot names
 *  ('.bashrc') and names ending in a dot ('foo.') have NO suffix. */
function lowerSuffix(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  // No dot, leading-dot name (dot at index 0), or trailing dot → no suffix (matches pathlib).
  if (dot <= 0 || dot === name.length - 1) {
    return "";
  }
  return name.slice(dot).toLowerCase();
}

/**
 * AST-aware TS/JS/JSX chunker. The loader (`treesitter_loader.ts`) owns the process-wide parser
 * cache, so this chunker is a thin, stateless adapter — construct once at worker boot, reuse across
 * files.
 */
export class TreeSitterTsJsChunker {
  /** Extension → grammar kind, defaulting to typescript. */
  private static kindFor(path: string): GrammarName {
    const ext = lowerSuffix(path);
    // eslint-disable-next-line security/detect-object-injection -- `ext` indexes a frozen const map; absence → default, not undefined-injection
    return LANG_BY_EXT[ext] ?? "typescript";
  }

  /** The persisted `language` label (typescript for .ts/.tsx, else javascript). NOTE: this is the
   *  human label, distinct from the grammar kind (tsx ≠ a label). */
  private static languageLabelFor(path: string): "typescript" | "javascript" {
    const ext = lowerSuffix(path);
    if (ext === ".ts" || ext === ".tsx") {
      return "typescript";
    }
    return "javascript";
  }

  /**
   * Carve `body` into review-sized chunks anchored on changed lines.
   *
   * @param path workspace-relative path; selects the grammar + language label, copied onto each chunk.
   * @param body raw file bytes; decoded UTF-8 with replacement for parsing + line-slicing.
   * @param hunkRanges inclusive 1-based (start, end) pairs of changed lines; empty → whole file.
   */
  async chunk(args: {
    path: string;
    body: Uint8Array;
    hunkRanges: ReadonlyArray<HunkRange>;
  }): Promise<Array<DiffChunkV1>> {
    const { path, body, hunkRanges } = args;
    assertDiffSize(body);
    const kind = TreeSitterTsJsChunker.kindFor(path);
    const language = TreeSitterTsJsChunker.languageLabelFor(path);
    // errors="replace" semantics: exactly one U+FFFD per invalid byte (a load-bearing invariant).
    const decoded = new TextDecoder("utf-8").decode(body);
    if (decoded === "") {
      return [];
    }

    let candidates: Array<DiffChunkV1>;
    // web-tree-sitter Trees hold WASM-heap memory that JS GC does NOT reclaim automatically.
    // Extract the plain DiffChunkV1 candidate data, then delete() the tree in
    // `finally` so a long-lived worker processing many PRs does not leak WASM memory.
    let tree: { rootNode: unknown; delete(): void } | null = null;
    try {
      const parser = await getParser(kind);
      tree = parser.parse(decoded) as { rootNode: unknown; delete(): void } | null;
      if (tree === null) {
        return this.fallbackModule({ path, body: decoded, language, hunkRanges });
      }
      const root = tree.rootNode as unknown as TsNode;
      candidates = this.extractCandidates({ root, body: decoded, path, language });
    } catch {
      // Defensive: tree-sitter parse failed → module fallback (the chunker never raises on input).
      return this.fallbackModule({ path, body: decoded, language, hunkRanges });
    } finally {
      tree?.delete();
    }

    if (candidates.length === 0) {
      return this.fallbackModule({ path, body: decoded, language, hunkRanges });
    }

    if (hunkRanges.length === 0) {
      return candidates;
    }

    const intersecting = candidates.filter((c) =>
      hunkRanges.some(([hs, he]) => overlaps(c.start_line, c.end_line, hs, he)),
    );
    if (intersecting.length === 0) {
      return this.fallbackModule({ path, body: decoded, language, hunkRanges });
    }
    return intersecting;
  }

  // ── candidate extraction ──────────────────────────────────────────────────────────────────────
  /** Walk the top-level declarations (descending through export wrappers); emit one chunk per
   *  function / class / arrow-or-function-expression const assignment. */
  private extractCandidates(args: {
    root: TsNode;
    body: string;
    path: string;
    language: string;
  }): Array<DiffChunkV1> {
    const { root, body, path, language } = args;
    const lines = splitlinesKeepends(body);
    const out: Array<DiffChunkV1> = [];
    for (const node of TreeSitterTsJsChunker.iterTopLevelDecls(root)) {
      const chunkKind = TreeSitterTsJsChunker.chunkKindForNode(node);
      if (chunkKind === null) {
        continue;
      }
      const startLine = node.startPosition.row + 1;
      let endLine = node.endPosition.row + 1;
      // End-point at column 0 of a later row means the node ends at the line break — bring end_line
      // back to the previous line so single-line declarations don't claim an extra trailing line.
      if (node.endPosition.column === 0 && endLine > startLine) {
        endLine -= 1;
      }
      const sliceBody = lines.slice(startLine - 1, endLine).join("");
      out.push(
        DiffChunkV1.parse({
          chunk_id: computeChunkId({
            path,
            start_line: startLine,
            end_line: endLine,
            body: sliceBody,
          }),
          path,
          language,
          start_line: startLine,
          end_line: endLine,
          body: sliceBody,
          chunk_kind: chunkKind,
          token_estimate: estimateTokens(sliceBody),
        }),
      );
    }
    return out;
  }

  /** Yield every top-level declaration node, descending through export-statement wrappers but no
   *  further. */
  private static *iterTopLevelDecls(root: TsNode): Generator<TsNode> {
    for (const child of root.children) {
      if (child === null) {
        continue;
      }
      if (EXPORT_WRAPPER_TYPES.has(child.type)) {
        for (const grand of child.children) {
          if (grand !== null) {
            yield grand;
          }
        }
      } else {
        yield child;
      }
    }
  }

  /** function / class / arrow-or-fn-expr const → kind, else null. */
  private static chunkKindForNode(node: TsNode): DiffChunkKind | null {
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      return "function";
    }
    if (CLASS_NODE_TYPES.has(node.type)) {
      return "class";
    }
    // `const foo = () => {...}` / `const Foo = function() {...}`
    // → lexical_declaration > variable_declarator > arrow_function | function_expression.
    if (LEXICAL_DECL_TYPES.has(node.type)) {
      for (const d of node.children) {
        if (d !== null && d.type === "variable_declarator") {
          for (const value of d.children) {
            if (value !== null && FUNCTION_VALUE_TYPES.has(value.type)) {
              return "function";
            }
          }
        }
      }
    }
    return null;
  }

  // ── fallback ──────────────────────────────────────────────────────────────────────────────────
  /** A single module-level chunk spanning the whole file, or — when hunk ranges are present — the
   *  clamped union window of the changed lines. */
  private fallbackModule(args: {
    path: string;
    body: string;
    language: string;
    hunkRanges: ReadonlyArray<HunkRange>;
  }): Array<DiffChunkV1> {
    const { path, body, language, hunkRanges } = args;
    if (body === "") {
      return [];
    }
    const lines = splitlinesKeepends(body);
    const total = lines.length;
    let start: number;
    let end: number;
    if (hunkRanges.length > 0) {
      start = Math.max(1, Math.min(...hunkRanges.map(([hs]) => hs)));
      end = Math.min(total, Math.max(...hunkRanges.map(([, he]) => he)));
      if (end < start) {
        end = start;
      }
    } else {
      start = 1;
      end = total;
    }
    const sliceBody = lines.slice(start - 1, end).join("");
    return [
      DiffChunkV1.parse({
        chunk_id: computeChunkId({ path, start_line: start, end_line: end, body: sliceBody }),
        path,
        language,
        start_line: start,
        end_line: end,
        body: sliceBody,
        chunk_kind: "module",
        token_estimate: estimateTokens(sliceBody),
      }),
    ];
  }
}
