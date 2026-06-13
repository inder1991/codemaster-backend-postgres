// Chunker selector — routes a path to the right chunker by FILE EXTENSION (narrow + explicit; no
// content sniffing):
//   * .py                                         → TreeSitterPythonChunker
//   * .ts .tsx .js .jsx .mjs .cjs                 → TreeSitterTsJsChunker
//   * everything else                             → HunkFallbackChunker
//
// Default-deny on extension typos (.py3 / .coffee → HunkFallback). The 3 chunkers are stateless
// (the loader owns the process-wide parser cache); the registry holds pre-constructed singletons so
// every chunk call reuses the warm parsers.

import { HunkFallbackChunker } from "./hunk_fallback.js";
import { type HunkRange } from "./treesitter_python.js";
import { TreeSitterPythonChunker } from "./treesitter_python.js";
import { TreeSitterTsJsChunker } from "./treesitter_tsjs.js";

import type { DiffChunkV1 } from "#contracts/diff_chunking.v1.js";

/** The one async `chunk` method the three chunker classes (and the selector's return) share. */
export type ChunkerPort = {
  chunk(args: {
    path: string;
    body: Uint8Array;
    hunkRanges: ReadonlyArray<HunkRange>;
  }): Promise<Array<DiffChunkV1>>;
};

/** Python source file extensions. */
const PY_EXTENSIONS: ReadonlySet<string> = new Set([".py"]);
/** TypeScript / JavaScript file extensions. */
const TSJS_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/**
 * Lowercase extension INCLUDING the leading dot, or "" for extensionless files / dotfiles. Handles
 * embedded dots (`a.b.py` → `.py`; returns the LAST extension only). `last_dot <= 0` covers BOTH
 * no-dot AND dotfiles (".gitignore" → "").
 */
export function extractExtension(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0) {
    return "";
  }
  return name.slice(lastDot).toLowerCase();
}

/**
 * Pre-constructed chunker singletons + the routing function. One instance per worker pod; construct
 * via {@link ChunkerRegistry.build} at boot.
 */
export class ChunkerRegistry {
  readonly python: TreeSitterPythonChunker;
  readonly tsjs: TreeSitterTsJsChunker;
  readonly fallback: HunkFallbackChunker;

  constructor(args: {
    python: TreeSitterPythonChunker;
    tsjs: TreeSitterTsJsChunker;
    fallback: HunkFallbackChunker;
  }) {
    this.python = args.python;
    this.tsjs = args.tsjs;
    this.fallback = args.fallback;
  }

  /** Construct the standard 3-chunker registry. Public for tests + production bootstrap. */
  static build(): ChunkerRegistry {
    return new ChunkerRegistry({
      python: new TreeSitterPythonChunker(),
      tsjs: new TreeSitterTsJsChunker(),
      fallback: new HunkFallbackChunker(),
    });
  }

  /** Route by file extension. See the module header for the full mapping. */
  selectFor(path: string): ChunkerPort {
    const ext = extractExtension(path);
    if (PY_EXTENSIONS.has(ext)) {
      return this.python;
    }
    if (TSJS_EXTENSIONS.has(ext)) {
      return this.tsjs;
    }
    return this.fallback;
  }
}
