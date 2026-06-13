// path_match — gitignore-style glob matcher (Sprint 10 / S10.0.1).
//
// ONE matcher backs BOTH consumers:
//   1. ADR-0001 per-glob `path_instructions` — `matchPathInstructions(rules, path)` returns every
//      `PathInstructionV1` whose `path` glob matches the chunk path, in declaration order, used to
//      populate `ReviewContextV1.matched_path_instructions`.
//   2. `.codemaster.yaml::path_filters` — `filterReviewPaths(paths, pathFilters)` selects which
//      files are reviewed via gitignore last-match-wins (bare INCLUDES, '!'-prefixed EXCLUDES).
//
// Glob semantics (locked):
//   * `**` — matches zero or more path segments (crosses `/`).
//   * `*`  — matches zero or more characters EXCEPT `/`.
//   * `?`  — matches exactly one character (not `/`).
//   * Trailing `/` not significant (stripped; treated as a directory match — see edge note below).
//   * Leading `/` is anchor-to-root; without it the match is unanchored (matches anywhere).
//   * Case-sensitive (gitignore default on linux).
//
// Glob→regex translation notes:
//   * The translation walks the pattern char-by-char, emitting `.*` for `**`, `[^/]*` for `*`,
//     `[^/]` for `?`, and `escapeRegexChar` for everything else. `**/` consumes a
//     trailing `/` so the pattern matches "any descendant" cleanly.
//   * `escapeRegexChar` escapes special chars (whitespace 9-13/32 plus
//     `# $ & ( ) * + - . ? [ \ ] ^ { | } ~`). Every other code point passes through verbatim.
//   * The compiled `RegExp` uses NO `u` (unicode) flag — identity escapes (`\#`, `\~`, `\ `) are
//     non-standard; a non-`u` JS RegExp accepts them while a `u`-flag RegExp would THROW. The body
//     is `^...$`-anchored so `RegExp.test` is the fullmatch equivalent for newline-free path inputs.
//   * Module-level memoization: a pure compile cache keyed by the raw pattern string (unbounded Map
//     is fine; patterns per review are few).

import type { PathInstructionV1 } from "#contracts/codemaster_config.v1.js";

// Compile cache, keyed by the raw pattern string — a pure, side-effect-free compile cache.
const REGEX_CACHE = new Map<string, RegExp>();

// Escaped special-char set. Each of these code points gets a leading backslash;
// every other char passes through verbatim. Single-char only.
const RE_ESCAPE_CHARS: ReadonlySet<string> = new Set([
  "\t", // 9
  "\n", // 10
  "\v", // 11 (0x0b)
  "\f", // 12 (0x0c)
  "\r", // 13
  " ", // 32
  "#", // 35
  "$", // 36
  "&", // 38
  "(", // 40
  ")", // 41
  "*", // 42
  "+", // 43
  "-", // 45
  ".", // 46
  "?", // 63
  "[", // 91
  "\\", // 92
  "]", // 93
  "^", // 94
  "{", // 123
  "|", // 124
  "}", // 125
  "~", // 126
]);

/** Single-char regex escape: backslash-prefix the special set; pass everything else verbatim. */
function escapeRegexChar(ch: string): string {
  return RE_ESCAPE_CHARS.has(ch) ? `\\${ch}` : ch;
}

/**
 * Translate a gitignore-style glob to a compiled `RegExp`, memoized by raw pattern.
 *
 * The body is built `^...$`-anchored (root-anchored when the pattern begins with `/`, otherwise
 * prefixed with the unanchored `(?:.* slash)?` prefix for gitignore's "match anywhere" behaviour).
 * Compiled WITHOUT the `u` flag — see the module translation notes above.
 */
function globToRegex(pattern: string): RegExp {
  const cached = REGEX_CACHE.get(pattern);
  if (cached !== undefined) return cached;

  // Strip trailing slash (directory match) for normalisation.
  let pat = pattern.replace(/\/+$/u, "");

  const anchorRoot = pat.startsWith("/");
  if (anchorRoot) {
    pat = pat.slice(1);
  }

  // Tokenise to handle `**` correctly. Translate one char (or one `**` token) at a time; mid-segment
  // `**` is treated like `.*` (matches any chars including `/`).
  const out: Array<string> = [];
  let i = 0;
  while (i < pat.length) {
    // eslint-disable-next-line security/detect-object-injection -- `i` is a bounds-checked numeric loop index into a local string, not user-controlled key access
    const ch = pat[i]!;
    if (ch === "*") {
      if (i + 1 < pat.length && pat[i + 1] === "*") {
        // `**` — multi-segment.
        out.push(".*");
        i += 2;
        // Consume an optional trailing `/` that follows `**/` so the pattern matches "any descendant"
        // cleanly without forcing an extra separator.
        // eslint-disable-next-line security/detect-object-injection -- `i` is bounds-checked; numeric index into a local string
        if (i < pat.length && pat[i] === "/") {
          i += 1;
        }
      } else {
        // `*` — anything except `/`.
        out.push("[^/]*");
        i += 1;
      }
    } else if (ch === "?") {
      out.push("[^/]");
      i += 1;
    } else {
      // All other chars go through `escapeRegexChar`.
      out.push(escapeRegexChar(ch));
      i += 1;
    }
  }

  const body = out.join("");
  // Unanchored patterns may match anywhere in the path (gitignore behaviour); anchored bind to root.
  // The dynamic regex is the WHOLE POINT — `body` is the glob→regex translation of a trusted repo
  // config pattern (max 200 chars, contract-validated).
  // eslint-disable-next-line security/detect-non-literal-regexp -- glob translation of a contract-validated config pattern; 1:1 with the frozen Python re.compile
  const regex = anchorRoot ? new RegExp(`^${body}$`) : new RegExp(`^(?:.*/)?${body}$`);
  REGEX_CACHE.set(pattern, regex);
  return regex;
}

/** True iff `path` matches the gitignore-style `pattern`. */
export function matchesGlob(args: { path: string; pattern: string }): boolean {
  return globToRegex(args.pattern).test(args.path);
}

/**
 * White-box diagnostic: the compiled `RegExp.source` for `pattern`. Exported so the parity test can
 * pin the EXACT regex translation (not just match outcomes); not part of the matcher's runtime surface.
 */
export function globToRegexSource(pattern: string): string {
  return globToRegex(pattern).source;
}

/**
 * Return every rule whose `path` glob matches `chunkPath`, in declaration order.
 *
 * Build `ReviewContextV1.matched_path_instructions` from `repo_config.path_instructions` for a chunk
 * path. The argument order is `(rules, chunkPath)` per the task contract; semantics are the same as
 * the keyword-only `match_path_instructions(path=..., rules=...)` in TS-idiomatic positional shape.
 */
export function matchPathInstructions(
  rules: ReadonlyArray<PathInstructionV1>,
  chunkPath: string,
): Array<PathInstructionV1> {
  if (rules.length === 0) {
    return [];
  }
  return rules.filter((r) => matchesGlob({ path: chunkPath, pattern: r.path }));
}

/**
 * Match `path` against `pattern` using ROOT-ANCHORED semantics.
 *
 * All patterns are treated as root-anchored by prepending `/`
 * when not already present. `**` still crosses directory boundaries; `*` and `?` do not. This differs
 * from `matchesGlob`'s default unanchored behaviour and is the correct semantic for `path_filters`.
 */
function filterMatchesGlob(path: string, pattern: string): boolean {
  const anchored = pattern.startsWith("/") ? pattern : `/${pattern}`;
  return matchesGlob({ path, pattern: anchored });
}

/**
 * Select which paths are reviewed, gitignore last-match-wins.
 *
 * Bare pattern INCLUDES; '!'-prefixed EXCLUDES. The LAST matching pattern decides. Default state:
 * any include exists → allow-list (default excluded); only excludes → deny-list (default included).
 * Empty `pathFilters` keeps everything (back-compat). Output is always an order-preserving subsequence
 * of `paths`.
 */
export function filterReviewPaths(
  paths: ReadonlyArray<string>,
  pathFilters: ReadonlyArray<string>,
): Array<string> {
  if (pathFilters.length === 0) {
    return [...paths];
  }

  const hasIncludes = pathFilters.some((f) => !f.startsWith("!"));

  const kept: Array<string> = [];
  for (const path of paths) {
    let included = !hasIncludes;
    for (const f of pathFilters) {
      if (f.startsWith("!")) {
        if (filterMatchesGlob(path, f.slice(1))) {
          included = false;
        }
      } else if (filterMatchesGlob(path, f)) {
        included = true;
      }
    }
    if (included) {
      kept.push(path);
    }
  }
  return kept;
}
