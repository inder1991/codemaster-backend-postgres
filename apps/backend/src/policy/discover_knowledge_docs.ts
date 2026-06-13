// discover_knowledge_docs (knowledge slice) — Sprint 10 / S10.2.1 + Sprint 26 / B-3. The POLICY-side
// walk (`discover_guideline_files`) lives in `discover_repo_docs.ts`; this module carves out the
// KNOWLEDGE side.
//
//   - `discoverRepoDocs({ workspace })` — walks the cloned workspace and emits one `RepoDocV1` per
//     in-scope markdown file (README.md root-only, CLAUDE.md any-depth, docs/**\/*.md). The downstream
//     refresh uses `content_sha256` to short-circuit re-embedding when bytes are unchanged.
//
//   - `discoverKnowledgeDocs({ workspace, customKnowledgePaths })` — filters that candidate set: drops
//     anything Subsystem A's guideline patterns own (`DEFAULT_GUIDELINE_PATTERNS`); keeps anything whose
//     `deriveDocKind` heuristic is non-`other`, OR whose path matches a `customKnowledgePaths` pattern.
//
// Reuses the exported helpers from `discover_repo_docs.ts` (`isInScope`, `resolvesInside`,
// `matchesGuidelinePattern`, `MalformedPatternError`) so the two walks share one symlink-escape guard +
// one fnmatch engine + one error type.
//
// Runtime context: activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox.
// `node:fs` reads + `node:crypto` hashing are both permitted in an activity (the clock/random gate
// allowlists them; deterministic hashing is not a randomness seam).

import { createHash } from "node:crypto";
import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

import { DEFAULT_GUIDELINE_PATTERNS } from "#contracts/guideline_files.v1.js";
import {
  DiscoveredRepoDocsV1,
  MAX_DOC_BYTES,
  MAX_DOCS_PER_REPO,
  type RepoDocV1,
} from "#contracts/repo_docs.v1.js";

import { deriveDocKind } from "./doc_kind_heuristic.js";
import {
  isInScope,
  MalformedPatternError,
  matchesGuidelinePattern,
  resolvesInside,
} from "./discover_repo_docs.js";

// Top-level directories whose subtrees are ignored — noise + vendor code (shared by both walks).
const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "vendor",
  ".venv",
  "__pycache__",
]);

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

/**
 * Recursive directory walk: yield every (relPath, absPath) under the workspace, pruning
 * `EXCLUDED_DIRS` in-place, NOT descending into symlinked directories. `relPath` is the POSIX path
 * relative to the workspace root. The `.md`-suffix + in-scope filter is applied by the caller.
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
    // os.walk's onerror default swallows + skips an unreadable directory.
    return;
  }

  for (const entry of entries) {
    const absPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // followlinks=False: a real directory is descended; a symlink-to-directory reports as a symlink
      // (entry.isDirectory() is False for it), so it is NOT descended — matching os.walk.
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      walkFiles(workspace, absPath, out);
    } else {
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
 * True iff the leaf path component is itself a symlink. A stat failure (broken-link race) is treated
 * as a symlink so the `resolvesInside` guard then runs and rejects it.
 */
function isSymlink(absPath: string): boolean {
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch {
    return true;
  }
}

/**
 * Walk `workspace` and emit one `RepoDocV1` per in-scope markdown file (README.md root-only,
 * CLAUDE.md any-depth, docs/**\/*.md).
 *
 * Results are sorted by `relative_path` for determinism so re-runs produce byte-identical envelopes when
 * the underlying files haven't changed. Oversize files (> `MAX_DOC_BYTES`) are skipped; the per-repo cap
 * (`MAX_DOCS_PER_REPO`) is applied AFTER the sort (survivor set = lexicographically-first N).
 */
export function discoverRepoDocs(args: { workspace: string }): DiscoveredRepoDocsV1 {
  const workspaceResolved = realpathSync(args.workspace);

  const walked: Array<{ relPath: string; absPath: string }> = [];
  walkFiles(args.workspace, args.workspace, walked);

  const candidates: Array<{ relPath: string; absPath: string }> = [];
  for (const { relPath, absPath } of walked) {
    // Python: `if not fname.endswith(".md"): continue` THEN `if not _is_in_scope(rel_path): continue`.
    if (!relPath.endsWith(".md")) {
      continue;
    }
    if (!isInScope(relPath)) {
      continue;
    }
    candidates.push({ relPath, absPath });
  }

  // Sort by relative_path (Python `candidates.sort(key=lambda x: x[0])`). JS default string sort is
  // UTF-16 code-unit order; for the ASCII path domain this matches Python's str sort.
  candidates.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const docs: Array<RepoDocV1> = [];
  let capHit = false;

  for (const { relPath, absPath } of candidates) {
    if (docs.length >= MAX_DOCS_PER_REPO) {
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

    if (data.length > MAX_DOC_BYTES) {
      continue;
    }

    docs.push({
      relative_path: relPath,
      byte_size: data.length,
      content_sha256: hashBytes(data),
    });
  }

  return DiscoveredRepoDocsV1.parse({
    schema_version: 1,
    docs,
    docs_cap_hit: capHit,
  });
}

/**
 * Walk `workspace` and emit one `RepoDocV1` per in-scope KNOWLEDGE document (ADRs, RFCs, architecture
 * docs, runbooks) — Sprint 26 / B-3.
 *
 * Carves out the knowledge side of `discoverRepoDocs`:
 *   - Reuses `discoverRepoDocs`'s walk + scope rules (README / CLAUDE.md / docs/**\/*.md).
 *   - Filters OUT any file matching Subsystem A's guideline patterns (`DEFAULT_GUIDELINE_PATTERNS`) —
 *     those are owned by `discoverGuidelineFiles`; guideline wins per the program plan's dispatch
 *     precedence. (Exclusion-first / inclusion-second order is load-bearing — a file matching BOTH
 *     guideline + knowledge patterns is owned by Subsystem A, never double-indexed.)
 *   - Filters IN any file whose `deriveDocKind` heuristic is non-`other` (adr / rfc / architecture /
 *     runbook), OR any file whose path matches a `customKnowledgePaths` pattern.
 *
 * No logging here; the metric-emit on `docs_cap_hit` lives in refresh_semantic_docs.activity.ts.
 *
 * @throws {MalformedPatternError} if any `customKnowledgePaths` pattern contains `..` or is absolute
 *   (defensive — A-7 validates upstream).
 */
export function discoverKnowledgeDocs(args: {
  workspace: string;
  customKnowledgePaths?: ReadonlyArray<string>;
}): DiscoveredRepoDocsV1 {
  const customKnowledgePaths = args.customKnowledgePaths ?? [];
  validateCustomPatterns(customKnowledgePaths);

  // Step 1: candidate set = all .md files `discoverRepoDocs` walks.
  const allDocs = discoverRepoDocs({ workspace: args.workspace });

  // Step 2: filter out guideline patterns + filter in knowledge patterns (heuristic OR custom).
  const knowledge: Array<RepoDocV1> = [];
  for (const doc of allDocs.docs) {
    // Exclude if matched by any guideline pattern (Subsystem A owns those).
    if (matchesGuidelinePattern(doc.relative_path, DEFAULT_GUIDELINE_PATTERNS) !== null) {
      continue;
    }
    // Include if doc_kind heuristic classifies as non-`other`.
    const kind = deriveDocKind(doc.relative_path);
    if (kind !== "other") {
      knowledge.push(doc);
      continue;
    }
    // Otherwise: include only if it matches a custom knowledge path.
    if (
      customKnowledgePaths.length > 0 &&
      matchesGuidelinePattern(doc.relative_path, customKnowledgePaths) !== null
    ) {
      knowledge.push(doc);
    }
  }

  return DiscoveredRepoDocsV1.parse({
    schema_version: 1,
    docs: knowledge,
    docs_cap_hit: allDocs.docs_cap_hit,
  });
}
