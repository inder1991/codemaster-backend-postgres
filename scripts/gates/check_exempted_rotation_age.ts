// EXEMPTED rotation-age gate (ts-morph port of the frozen Python gate
// scripts/check_exempted_rotation_age.py).
//
// Every EXEMPTED entry across the TS gate files (scripts/gates/*.ts, the analogue of the
// Python `_GATE_FILES` registry) must MOVE within the staleness threshold (14 days, ~2 sprints
// at codemaster's typical 3-7 day cadence). `PERMANENT-EXEMPTION-*` follow-up tags are skipped.
//
// Oracle: per-LINE `git blame -L<n>,<n> --porcelain` against the dict-key source line. Per-line
// blame is INDEPENDENT of unrelated edits to the gate file, so refactoring (adding a comment,
// fixing a typo elsewhere) does NOT reset every entry's age — closing the same
// dual-source-of-truth bug class the rest of the discipline exists to prevent.
//
// Mode: ERROR. Stale entries (age > threshold, non-permanent) emit `[ERROR]` and return 1.
//
// Fallback: if `git` isn't on PATH (rare; container without git) the oracle is absent — the gate
// emits `[WARN]` and exits 0 (don't break CI when the oracle can't run; emit visibility instead).
import { execFileSync } from "node:child_process";
import * as path from "node:path";

import { Node, Project, SyntaxKind } from "ts-morph";

export const STALENESS_THRESHOLD_DAYS = 14;
export const PERMANENT_PREFIX = "PERMANENT-EXEMPTION-";

const SECONDS_PER_DAY = 86_400;

/** One EXEMPTED dict-key entry located in a gate file's AST. */
export interface ExemptedEntryLocation {
  /** The EXEMPTED dict key (the exempted symbol / path). */
  key: string;
  /** The entry's `follow_up_story` value (empty string if absent). */
  follow_up_story: string;
  /** 1-based line number of the dict-key property (what `git blame -L<n>,<n>` indexes). */
  line: number;
}

/** A stale-entry finding. */
export interface Violation {
  file: string;
  line: number;
  key: string;
  follow_up_story: string;
  ageDays: number;
}

/**
 * Per-line git-blame oracle: return the age in days of the most-recent commit touching this exact
 * line of `file`, or `null` if git is unavailable / the line is uncommitted / blame failed.
 */
export type BlameOracle = (file: string, line: number) => number | null;

/**
 * Extract every EXEMPTED dict-key entry from a single source file's AST.
 *
 * Mirrors the Python gate's `_collect_exempted_entries`: find `EXEMPTED` variable declarations
 * whose initializer is an object literal, then read each property's key, its `follow_up_story`
 * value, and the property's source line number.
 */
export function collectExemptedEntries(sf: import("ts-morph").SourceFile): ExemptedEntryLocation[] {
  const entries: ExemptedEntryLocation[] = [];
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (decl.getName() !== "EXEMPTED") continue;
    const init = decl.getInitializer();
    if (!init || !Node.isObjectLiteralExpression(init)) continue;
    for (const prop of init.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      const key = readPropertyKey(prop.getNameNode());
      if (key === null) continue;
      const value = prop.getInitializer();
      const followUp =
        value && Node.isObjectLiteralExpression(value) ? readFollowUpStory(value) : "";
      entries.push({ key, follow_up_story: followUp, line: prop.getStartLineNumber() });
    }
  }
  return entries;
}

/** Read a property name as a string: string-literal keys and bare identifiers both supported. */
function readPropertyKey(nameNode: import("ts-morph").Node): string | null {
  if (Node.isStringLiteral(nameNode)) return nameNode.getLiteralValue();
  if (Node.isIdentifier(nameNode)) return nameNode.getText();
  return null;
}

/** Pull the `follow_up_story` string value out of an entry's object literal (empty if absent). */
function readFollowUpStory(obj: import("ts-morph").ObjectLiteralExpression): string {
  for (const prop of obj.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue;
    if (readPropertyKey(prop.getNameNode()) !== "follow_up_story") continue;
    const v = prop.getInitializer();
    if (v && Node.isStringLiteral(v)) return v.getLiteralValue();
  }
  return "";
}

/**
 * Pure violation finder. Walks every gate source file in the project, extracts its EXEMPTED
 * entries, and asks the injected `blame` oracle for each dict-key line's age. Entries that are
 * `PERMANENT-EXEMPTION-*`, fresh (age <= threshold), or whose blame is `null` (uncommitted /
 * oracle-absent) are not flagged. Stale, non-permanent entries are returned as violations.
 *
 * The oracle is injected so this function is deterministic and testable against in-memory
 * snippets (no real git / wall-clock in unit tests) — mirroring how the Python test drove the
 * per-line-blame contract directly.
 */
export function findRotationViolations(project: Project, blame: BlameOracle): Violation[] {
  const out: Violation[] = [];
  for (const sf of gateSourceFiles(project)) {
    const file = sf.getFilePath();
    for (const entry of collectExemptedEntries(sf)) {
      if (entry.follow_up_story.startsWith(PERMANENT_PREFIX)) continue;
      const ageDays = blame(file, entry.line);
      if (ageDays === null || ageDays <= STALENESS_THRESHOLD_DAYS) continue;
      out.push({
        file,
        line: entry.line,
        key: entry.key,
        follow_up_story: entry.follow_up_story,
        ageDays,
      });
    }
  }
  return out;
}

/** Gate source files: scripts/gates/*.ts, excluding *.test.ts and the run-all orchestrator. */
function gateSourceFiles(project: Project): import("ts-morph").SourceFile[] {
  return project.getSourceFiles().filter((sf) => {
    const p = sf.getFilePath();
    if (!p.includes(`${path.sep}scripts${path.sep}gates${path.sep}`)) return false;
    const base = path.basename(p);
    if (base.endsWith(".test.ts")) return false;
    if (base === "run-all.ts") return false;
    return true;
  });
}

/** True iff `git` resolves on PATH (probe `git --version`). */
function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Real per-line blame oracle. `git blame -L<n>,<n> --porcelain -- <file>` and parse the
 * `author-time <unix>` line. Returns whole-day age, or `null` on any failure.
 */
export function gitBlameLineAgeDays(file: string, line: number, repoRoot: string): number | null {
  let stdout: string;
  try {
    stdout = execFileSync("git", ["blame", "-L", `${line},${line}`, "--porcelain", "--", file], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  for (const ln of stdout.split("\n")) {
    if (ln.startsWith("author-time ")) {
      const commitUnix = Number.parseInt(ln.slice("author-time ".length).trim(), 10);
      if (!Number.isFinite(commitUnix)) return null;
      return Math.max(0, Math.floor((Math.floor(Date.now() / 1000) - commitUnix) / SECONDS_PER_DAY));
    }
  }
  return null;
}

/** CLI entry: ERROR-mode. Returns 1 if any stale non-permanent entry exists, else 0. */
export function main(): number {
  if (!gitAvailable()) {
    process.stderr.write(
      "[WARN] file=scripts/gates/exempted-rotation-age.ts:1 rule=exempted-rotation " +
        'message="git not on PATH; skipping staleness check" ' +
        'suggestion="install git in CI image to enable rotation gate"\n',
    );
    return 0;
  }

  const repoRoot = process.cwd();
  const project = new Project({ tsConfigFilePath: "tsconfig.json" });
  const blame: BlameOracle = (file, line) => gitBlameLineAgeDays(file, line, repoRoot);
  const violations = findRotationViolations(project, blame);

  for (const v of violations) {
    const rel = path.relative(repoRoot, v.file);
    process.stderr.write(
      `[ERROR] file=${rel}:${v.line} rule=exempted-rotation ` +
        `message="EXEMPTED entry '${v.key}' (follow_up_story='${v.follow_up_story}') ` +
        `has been in place for ${v.ageDays} days, exceeding threshold ` +
        `of ${STALENESS_THRESHOLD_DAYS}" ` +
        `suggestion="resolve ${v.follow_up_story} OR convert to ` +
        `PERMANENT-EXEMPTION-* OR justify continued exemption via ADR"\n`,
    );
  }

  return violations.length > 0 ? 1 : 0;
}
