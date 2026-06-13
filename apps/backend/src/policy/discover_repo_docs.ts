// discover_repo_docs (policy slice) — Sprint 25 / A-1. `discoverGuidelineFiles({ workspace,
// customPatterns })` walks a cloned workspace via `node:fs` and emits one `GuidelineFileV1` per
// in-scope policy file (CLAUDE.md, AGENTS.md, .cursorrules, …). Output feeds the A-2 rule extractor;
// never persisted (Subsystem A runs in-memory at review time). The KNOWLEDGE-side walks live in
// `discover_knowledge_docs.ts`.
//
// Key behaviors:
//   - `fnmatchTranslate`: standard fnmatch grammar (`*` → `.*`, `?` → `.`, `[seq]`/`[!seq]` character
//     classes, literal-escaping of every other char) under DOTALL + end-anchor. `*` matches `/` too,
//     so `docs/policy/*.md` matches `docs/policy/sub/auth.md`. A module-level cache amortizes
//     `RegExp` construction.
//   - `resolvesInside`: symlink-escape guard via `realpathSync`; symlinks resolving outside the
//     workspace are REJECTED.
//   - `MAX_GUIDELINE_FILES_PER_REPO` (= 200): candidates sorted by `relative_path` BEFORE the cap so
//     the survivor set + ordering is deterministic.
//   - `isInScope`: KNOWLEDGE-side basename matcher (README.md root-only / CLAUDE.md any-depth /
//     docs/**/*.md). Exported for the parity oracle; the policy walk uses `matchesGuidelinePattern`.
//   - `validateCustomPatterns`: rejects empty / absolute / `..`-segment patterns
//     (`MalformedPatternError`); defense-in-depth (A-7 validates upstream).
//
// The walk uses `readdirSync(..., { withFileTypes: true })` and does NOT descend into symlinked
// directories (the Dirent reports the link, not its target).

import { createHash } from "node:crypto";
import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";

import {
  DEFAULT_GUIDELINE_PATTERNS,
  DiscoveredGuidelineFilesV1,
  type GuidelineFileV1,
  MAX_GUIDELINE_BYTES,
  MAX_GUIDELINE_FILES_PER_REPO,
} from "#contracts/guideline_files.v1.js";

/**
 * Raised when a custom pattern contains `..` segments or is absolute. A-7's config-side validator
 * should catch these before they reach discovery; `discoverGuidelineFiles` raises defensively.
 */
export class MalformedPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedPatternError";
  }
}

// Top-level directories whose subtrees are ignored — noise + vendor code.
const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "vendor",
  ".venv",
  "__pycache__",
]);

/**
 * True iff `relPath` matches one of the KNOWLEDGE-side locked patterns (README.md root-only,
 * CLAUDE.md any-depth, docs/**\/*.md). Exported for the parity oracle. The POLICY walk uses
 * {@link matchesGuidelinePattern} instead.
 */
export function isInScope(relPath: string): boolean {
  if (relPath === "README.md") {
    return true;
  }
  if (relPath === "CLAUDE.md" || relPath.endsWith("/CLAUDE.md")) {
    return true;
  }
  if (relPath.startsWith("docs/") && relPath.endsWith(".md")) {
    return true;
  }
  return false;
}

/**
 * True iff `candidate`'s realpath is the workspace itself or a descendant. Symlinks pointing outside
 * the workspace are skipped. `workspaceResolved` is the already-realpath'd workspace root. A failed
 * realpath (broken link / race) returns False.
 */
export function resolvesInside(workspaceResolved: string, candidate: string): boolean {
  let target: string;
  try {
    target = realpathSync(candidate);
  } catch {
    return false;
  }
  // Python `target.relative_to(workspace_resolved)` succeeds iff target == workspace OR is a descendant.
  if (target === workspaceResolved) {
    return true;
  }
  const rel = relative(workspaceResolved, target);
  // Inside iff the relative path neither escapes upward (`..`) nor is absolute (different root).
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`) && !pathIsAbsolute(rel);
}

/** True iff `p` is an absolute path (cross-platform; the realpath comparison guards against a different root). */
function pathIsAbsolute(p: string): boolean {
  return resolve(p) === p;
}

/** Lowercase sha256 hex digest over the raw file bytes. */
function hashBytes(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Reject patterns with `..` segments or absolute paths. Defensive; A-7's `.codemaster.yaml` validator
 * should reject these upstream.
 */
function validateCustomPatterns(patterns: ReadonlyArray<string>): void {
  for (const pattern of patterns) {
    if (!pattern) {
      throw new MalformedPatternError("empty pattern not allowed");
    }
    if (pattern.startsWith("/")) {
      throw new MalformedPatternError(`absolute pattern not allowed: ${JSON.stringify(pattern)}`);
    }
    if (pattern.split("/").includes("..")) {
      throw new MalformedPatternError(
        `pattern with '..' segment not allowed: ${JSON.stringify(pattern)}`,
      );
    }
  }
}

// ─── fnmatch.translate port ───────────────────────────────────────────────────────────────────────

// Module-level cache: amortizes `RegExp` construction across the per-repo file fan-out.
const FNMATCH_REGEX_CACHE = new Map<string, RegExp>();

/** Escape a single literal char for inclusion in a regex. */
function reEscapeChar(c: string): string {
  // Conservative JS analog: backslash-escapes regex metacharacters; for the in-domain inputs (paths)
  // this is equivalent to Python's broader escaping in MATCH OUTCOME.
  if (/[a-zA-Z0-9_]/.test(c)) {
    return c;
  }
  return `\\${c}`;
}

/**
 * fnmatch.translate semantics → a `RegExp`. `*` → `.*`, `?` → `.`, `[seq]`/`[!seq]` → a regex
 * character class, every other char literal-escaped; wrapped in DOTALL (`s` flag) + end-anchored.
 *
 * Character-class handling:
 *   - a leading `!` after `[` negates (`[^...]`);
 *   - `]` as the first class char is literal (`[]]` / `[!]`);
 *   - an UNCLOSED `[` (no matching `]`) is treated as the LITERAL char `[`;
 *   - a class whose first emitted char is `^` or `[` is backslash-escaped.
 * Backslashes inside a class are doubled.
 */
function fnmatchTranslate(pattern: string): RegExp {
  const cached = FNMATCH_REGEX_CACHE.get(pattern);
  if (cached !== undefined) {
    return cached;
  }

  const res: Array<string> = [];
  let i = 0;
  const n = pattern.length;

  while (i < n) {
    const c = pattern[i]!;
    i += 1;
    if (c === "*") {
      res.push(".*");
    } else if (c === "?") {
      res.push(".");
    } else if (c === "[") {
      // Find the closing ']' per CPython's scan: skip a leading '!', then a leading ']' is literal.
      let j = i;
      if (j < n && pattern[j] === "!") {
        j += 1;
      }
      if (j < n && pattern[j] === "]") {
        j += 1;
      }
      while (j < n && pattern[j] !== "]") {
        j += 1;
      }
      if (j >= n) {
        // Unclosed '[' — emit a literal '['.
        res.push("\\[");
      } else {
        let stuff = pattern.slice(i, j).replaceAll("\\", "\\\\");
        i = j + 1;
        if (stuff[0] === "!") {
          stuff = "^" + stuff.slice(1);
        } else if (stuff[0] === "^" || stuff[0] === "[") {
          stuff = "\\" + stuff;
        }
        // JS-compat fix: CPython/POSIX allow a literal ']' as the FIRST class member (`[]a]` =
        // {']','a'}), relying on Python `re`'s leading-']'-is-literal rule. JS RegExp lacks that rule —
        // it reads `[]` as an EMPTY class (and `[^]` as "any char"). The fnmatch scan guarantees any
        // ']' inside `stuff` is exactly that leading literal, so escape a ']' right after the optional
        // negation '^' to `\]` — making JS match the same character class Python's re does.
        stuff = stuff.replace(/^(\^?)\]/, "$1\\]");
        res.push(`[${stuff}]`);
      }
    } else {
      res.push(reEscapeChar(c));
    }
  }

  // (?s:...) DOTALL + end-anchor. JS: the `s` flag + a `$` anchor (no `m` flag) is the behavioral
  // equivalent of Python's `(?s:...)\Z` — `*`/`?` match '/' too, and the match must reach end-of-string.
  // eslint-disable-next-line security/detect-non-literal-regexp -- the regex is built from a vetted policy pattern (validateCustomPatterns rejects '..'/absolute) via the faithful fnmatch.translate port, mirroring the frozen Python re.compile(fnmatch.translate(pattern))
  const compiled = new RegExp(`^(?:${res.join("")})$`, "s");
  FNMATCH_REGEX_CACHE.set(pattern, compiled);
  return compiled;
}

/**
 * Return the first matching guideline pattern, or `null`.
 *
 * Match semantics (POSIX, case-sensitive):
 *   - Patterns containing `/` match against the full POSIX relative path via the fnmatch regex.
 *   - Patterns without `/` match against the basename only. Plain basenames (no glob char) use an exact
 *     `===`; basenames carrying `* ? [` fall back to the fnmatch regex.
 *
 * First match wins so the result is deterministic regardless of how many patterns a file overlaps.
 */
export function matchesGuidelinePattern(
  relPath: string,
  patterns: ReadonlyArray<string>,
): string | null {
  const basename = relPath.includes("/") ? relPath.slice(relPath.lastIndexOf("/") + 1) : relPath;
  for (const pattern of patterns) {
    if (pattern.includes("/")) {
      if (fnmatchTranslate(pattern).test(relPath)) {
        return pattern;
      }
    } else {
      if (pattern === basename) {
        return pattern;
      }
      if (hasGlobChar(pattern)) {
        if (fnmatchTranslate(pattern).test(basename)) {
          return pattern;
        }
      }
    }
  }
  return null;
}

/** True iff the basename pattern carries a glob metachar (`*`, `?`, `[`). */
function hasGlobChar(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

/**
 * The parent directory the file's rules apply to. Empty string for repo-root files; POSIX path (no
 * trailing separator) for nested files.
 */
export function deriveScopeDir(relPath: string): string {
  if (!relPath.includes("/")) {
    return "";
  }
  return relPath.slice(0, relPath.lastIndexOf("/"));
}

// ─── the walk ───────────────────────────────────────────────────────────────────────────────────

/**
 * Recursive directory walk: yield every (relPath, absPath) under `dir`, pruning `EXCLUDED_DIRS`
 * in-place, NOT descending into symlinked directories. `relPath` is the POSIX path relative to the
 * workspace root. Pure traversal — no filtering / hashing here.
 */
function walkFiles(
  workspace: string,
  dir: string,
  out: Array<{ relPath: string; absPath: string }>,
): void {
  let entries: Array<Dirent>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A read failure on a directory (permissions / race) prunes that subtree — os.walk's onerror
    // default is to swallow and skip.
    return;
  }

  for (const entry of entries) {
    const absPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // followlinks=False: a real directory is descended; a symlink to a directory reports as a symlink
      // (entry.isDirectory() is False for it), so it is NOT descended — matching os.walk.
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      walkFiles(workspace, absPath, out);
    } else {
      // Files AND symlinks-to-files land here (a symlink Dirent is not a directory). The symlink-escape
      // guard is applied later, per-candidate, after sorting.
      const relPath = toPosixRel(workspace, absPath);
      out.push({ relPath, absPath });
    }
  }
}

/** Workspace-relative POSIX path for `absPath`. */
function toPosixRel(workspace: string, absPath: string): string {
  return relative(workspace, absPath).split(sep).join(posix.sep);
}

/**
 * True iff the leaf path component is itself a symlink. `lstatSync` does NOT follow the final link;
 * an ancestor directory being a symlink does NOT make this True. A stat failure (broken-link race) is
 * treated as a symlink so the `resolvesInside` guard then runs and rejects it.
 */
function isSymlink(absPath: string): boolean {
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch {
    return true;
  }
}

/**
 * Walk `workspace` and emit one `GuidelineFileV1` per in-scope policy file.
 *
 * Pattern set: `DEFAULT_GUIDELINE_PATTERNS` (15 patterns) extended additively by `customPatterns`
 * (per A-7's `.codemaster.yaml::knowledge.file_patterns`). Defaults FIRST so the `source_pattern`
 * recorded is the default when a custom pattern would otherwise duplicate it.
 *
 * Results sorted by `relative_path` for determinism; re-runs on an unchanged workspace produce
 * byte-identical envelopes. The per-repo cap (`MAX_GUIDELINE_FILES_PER_REPO`) is applied AFTER the sort,
 * so the survivor set is the lexicographically-first N candidates.
 *
 * @throws {MalformedPatternError} if `customPatterns` contains a `..`-segment or absolute pattern.
 */
export function discoverGuidelineFiles(args: {
  workspace: string;
  customPatterns?: ReadonlyArray<string>;
}): DiscoveredGuidelineFilesV1 {
  const customPatterns = args.customPatterns ?? [];
  validateCustomPatterns(customPatterns);

  // Defaults FIRST (so a custom pattern duplicating a default records the default as source_pattern).
  const allPatterns: ReadonlyArray<string> = [...DEFAULT_GUIDELINE_PATTERNS, ...customPatterns];

  const workspaceResolved = realpathSync(args.workspace);

  // Walk the workspace, then filter to pattern-matching candidates: (relPath, absPath, pattern).
  const walked: Array<{ relPath: string; absPath: string }> = [];
  walkFiles(args.workspace, args.workspace, walked);

  const candidates: Array<{ relPath: string; absPath: string; pattern: string }> = [];
  for (const { relPath, absPath } of walked) {
    const pattern = matchesGuidelinePattern(relPath, allPatterns);
    if (pattern === null) {
      continue;
    }
    candidates.push({ relPath, absPath, pattern });
  }

  // Sort by relative_path for determinism (Python `candidates.sort(key=lambda x: x[0])`). JS default
  // string sort is UTF-16 code-unit order; for the ASCII path domain this matches Python's str sort.
  candidates.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const files: Array<GuidelineFileV1> = [];
  let capHit = false;
  let oversizeCount = 0;

  for (const { relPath, absPath, pattern } of candidates) {
    if (files.length >= MAX_GUIDELINE_FILES_PER_REPO) {
      capHit = true;
      break;
    }

    // Reject symlinks whose target resolves outside the workspace.
    if (isSymlink(absPath) && !resolvesInside(workspaceResolved, absPath)) {
      continue;
    }

    let data: Buffer;
    try {
      data = readFileSync(absPath);
    } catch {
      // OSError → skip (the Python `except OSError` branch).
      continue;
    }

    if (data.length > MAX_GUIDELINE_BYTES) {
      oversizeCount += 1;
      continue;
    }

    if (data.length === 0) {
      // Empty policy files carry no rules; GuidelineFileV1.body has min_length=1 — skip.
      continue;
    }

    let body: string;
    try {
      body = decodeUtf8Strict(data);
    } catch {
      // Non-UTF-8 file → skip (the Python `except UnicodeDecodeError` branch).
      continue;
    }

    files.push({
      schema_version: 1,
      relative_path: relPath,
      scope_dir: deriveScopeDir(relPath),
      source_pattern: pattern,
      body,
      content_sha256: hashBytes(data),
    });
  }

  return DiscoveredGuidelineFilesV1.parse({
    schema_version: 1,
    files,
    files_cap_hit: capHit,
    oversize_files_count: oversizeCount,
  });
}

/**
 * Decode `data` as UTF-8, THROWING on invalid bytes. `TextDecoder({ fatal: true })` is strict —
 * `Buffer.toString` would silently substitute U+FFFD, causing incorrect skip-on-non-utf8 behavior.
 */
function decodeUtf8Strict(data: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}
