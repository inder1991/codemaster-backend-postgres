// Unsafe-migration-pattern gate (BF-2 mitigation).
//
// The Python original AST-walks alembic version files (codemaster/migrations/versions/*.py),
// concatenates every SQL string passed to op.execute(...) inside upgrade(), and regex-scans the
// joined, uppercased body for exactly TWO anti-patterns:
//
//   * Pattern A (migration.unsafe.delete_and_set_not_null): `DELETE FROM <table>` AND
//     `SET NOT NULL` anywhere in the same migration. A direct DELETE is irrecoverable data loss;
//     rows must be archived to <table>_archive_<NNNN> first (archive-before-DELETE). The pairing
//     is deliberately coarse — joined-body, not per-table — because the typical unsafe shape is
//     "purge the NULL rows, then SET NOT NULL", and a false pairing is cheap to exempt while a
//     missed purge is unrecoverable.
//   * Pattern B (migration.unsafe.set_not_null_without_not_valid): `SET NOT NULL` without a
//     `NOT VALID` token anywhere in the same migration (the ADD CONSTRAINT ... CHECK ... NOT VALID
//     + VALIDATE CONSTRAINT expand-contract shortcut). Without it, Postgres scans the entire table
//     under ACCESS EXCLUSIVE during the SET NOT NULL — write outage on a hot table. Presence of
//     NOT VALID anywhere suppresses B (the original cannot verify the VALIDATE step or column
//     identity either; faithful coarse heuristic).
//
// Those two classes are the gate's ENTIRE surface. The Python original has NO rule for bare
// DROP TABLE / DROP COLUMN, non-concurrent CREATE INDEX, or CHECK-constraint swaps, so this port
// does not invent them (e.g. 0042's non-concurrent index builds and CHECK swap are out of scope
// here — and made safe regardless by that migration's own DO-block cold-only guard).
//
// Adaptations for this repo (raw SQL migrations under migrations/*.sql, applied up-only by
// node-pg-migrate; the Python repo's alembic chain is frozen under vendor/):
//   * "extract op.execute() strings from upgrade()" becomes "strip SQL comments from the file":
//     the whole .sql file IS the upgrade body. Prose rationale lives in `--` / `/* */` comments
//     (this repo's migrations carry dense rationale headers — 0042 alone discusses expand-contract
//     in prose), so comment-stripping confines the match to executable SQL only.
//     Single-/double-/dollar-quoted payloads stay IN scope (a RAISE EXCEPTION literal mentioning
//     DELETE FROM counts — same coarse semantics).
//   * rule migration.parse is dropped: it fired on a Python SyntaxError in a version file; a raw
//     SQL file has no parse precondition for a regex scan (Postgres itself is the syntax gate).
//   * "no upgrade() body / no op.execute strings → skip" is subsumed: a SQL file with no matching
//     statements simply yields no findings.
//   * Findings carry the real 1-based line of the triggering match — comments are replaced by
//     equal-length whitespace so offsets survive stripping. (The Python gate reported `:1` only
//     because joining op.execute() strings lost source positions.)
//   * `NOT VALID` is matched with \s+ between the words (the Python gate used a plain single-space
//     substring) — raw SQL legally line-breaks there; every other regex is the original verbatim.
//
// Output format per CLAUDE.md H-16/H-23:
//   [SEVERITY] file=<path>:<line> rule=<rule-id> message="..." suggestion="..."
//
// Mode: ERROR. Any non-exempted violation makes main() return 1.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const RULE_DELETE_AND_SET_NOT_NULL = "migration.unsafe.delete_and_set_not_null";
export const RULE_SET_NOT_NULL_WITHOUT_NOT_VALID = "migration.unsafe.set_not_null_without_not_valid";

/** Migrations exempted from the gate, keyed by file stem (e.g. "0042_background_jobs_state_and_indexes").
 *  Empty at landing: no existing migration (0001–0042) contains DELETE FROM or SET NOT NULL in
 *  executable SQL (full-corpus scan, comments included), so nothing needed grandfathering. Shape
 *  matches _registry.ts ExemptedEntry so the meta-gates
 *  (check_exempted_lists_pointed / check_exempted_rotation_age) walk this dict; every new entry
 *  requires a `follow_up_story` with a well-formed story id OR a PERMANENT-EXEMPTION-* tag. */
export const EXEMPTED: Record<string, { reason: string; follow_up_story: string }> = {};

// Detection regexes — matched against the uppercased, comment-stripped SQL, so the uppercase
// literals below are exhaustive. Presence-test and table-extraction are SEPARATE regexes:
// `DELETE FROM "Quoted"` trips the presence test but reports table `<unknown>` (extraction wants a
// [\w.]+ name).
const DELETE_FROM_RE = /\bDELETE\s+FROM\s+/;
const DELETE_FROM_TABLE_RE = /\bDELETE\s+FROM\s+([\w.]+)/;
const SET_NOT_NULL_RE = /\bSET\s+NOT\s+NULL\b/;
const NOT_VALID_RE = /\bNOT\s+VALID\b/; // Python: plain "NOT VALID" substring; \s+ tolerates line breaks.

/** A single anti-pattern finding within one migration's SQL (file-agnostic; see Violation). */
export type Finding = {
  /** Rule id (one of the RULE_* constants). */
  rule: string;
  /** 1-based line of the triggering match in the original file. */
  line: number;
  message: string;
  suggestion: string;
}

/** A Finding attributed to a migration file (repo-relative POSIX path). */
export type Violation = Finding & {
  file: string;
}

/**
 * Replace SQL comments with equal-length whitespace (newlines preserved), leaving every executable
 * byte at its original offset so line numbers survive. Handles the lexical states that matter for
 * not mis-stripping: `--` line comments, nested `/&#42; ... &#42;/` block comments (PostgreSQL
 * block comments nest), single-quoted strings (with `''` doubling), double-quoted identifiers, and
 * dollar-quoted strings (`$$...$$` / `$tag$...$tag$`). Quoted payloads are kept verbatim — they are
 * executable content and stay in match scope. A `--` inside a string is NOT a comment; a `'`
 * inside a comment does
 * NOT open a string (this repo's rationale comments are full of quoted state names).
 */
export function stripSqlComments(sql: string): string {
  const out: Array<string> = [];
  const n = sql.length;
  // Two flat alternatives ($$ | $tag$) rather than one optional group — same language, but keeps
  // eslint-plugin-security's star-height heuristic (detect-unsafe-regex) quiet.
  const dollarTag = /\$\$|\$[A-Za-z_]\w*\$/y;
  let i = 0;
  while (i < n) {
    const ch = sql[i]!;
    // `--` line comment: blank to end-of-line (the newline itself is copied by the outer loop).
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }
    // `/* ... */` block comment — PostgreSQL block comments NEST, so track depth.
    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 0;
      while (i < n) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          out.push("  ");
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          out.push("  ");
          i += 2;
          if (depth === 0) break;
        } else {
          out.push(sql[i] === "\n" ? "\n" : " ");
          i += 1;
        }
      }
      continue;
    }
    // Single-quoted string / double-quoted identifier: copy verbatim; `''` (or `""`) is the
    // doubled-quote escape, not a terminator.
    if (ch === "'" || ch === '"') {
      out.push(ch);
      i += 1;
      while (i < n) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            out.push(ch, ch);
            i += 2;
            continue;
          }
          out.push(ch);
          i += 1;
          break;
        }
        out.push(sql[i]!);
        i += 1;
      }
      continue;
    }
    // Dollar-quoted string ($$...$$ or $tag$...$tag$): copy verbatim through the matching close
    // tag. `$1` positional parameters don't match the tag shape and fall through as plain chars.
    if (ch === "$") {
      dollarTag.lastIndex = i;
      const m = dollarTag.exec(sql);
      if (m !== null && m.index === i) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        out.push(sql.slice(i, end));
        i = end;
        continue;
      }
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

/** 1-based line number of a character offset (offsets are stable across stripSqlComments). */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * Pure detector: scan one migration's raw SQL for the two anti-patterns. Uppercase the executable
 * SQL and presence-test each pattern over the whole body (A and B can BOTH fire on the same
 * migration — a DELETE + SET NOT NULL migration with no NOT VALID reports two violations).
 */
export function findUnsafeMigrationPatterns(sql: string): Array<Finding> {
  const combined = stripSqlComments(sql).toUpperCase();
  const findings: Array<Finding> = [];

  const deleteMatch = DELETE_FROM_RE.exec(combined);
  const setNotNullMatch = SET_NOT_NULL_RE.exec(combined);
  const hasNotValid = NOT_VALID_RE.test(combined);

  // Pattern A: DELETE FROM + SET NOT NULL anywhere in the same migration.
  if (deleteMatch !== null && setNotNullMatch !== null) {
    const tableMatch = DELETE_FROM_TABLE_RE.exec(combined);
    const table = tableMatch?.[1]?.toLowerCase() ?? "<unknown>";
    findings.push({
      rule: RULE_DELETE_AND_SET_NOT_NULL,
      line: lineOf(combined, deleteMatch.index), // attributed to the irrecoverable DELETE itself
      message:
        `migration contains DELETE FROM ${table} and SET NOT NULL in the same ` +
        `migration — irrecoverable data loss on the deleted rows. Archive to ` +
        `${table}_archive_<NNNN> first.`,
      suggestion:
        "Split into a separate migration that archives rows into <table>_archive_<NNNN> " +
        "before the DELETE, OR use a count-guard RAISE EXCEPTION if " +
        "(SELECT count(*) WHERE <predicate>) > :threshold.",
    });
  }

  // Pattern B: SET NOT NULL without a preceding NOT VALID + VALIDATE shortcut.
  if (setNotNullMatch !== null && !hasNotValid) {
    findings.push({
      rule: RULE_SET_NOT_NULL_WITHOUT_NOT_VALID,
      line: lineOf(combined, setNotNullMatch.index),
      message:
        "migration contains SET NOT NULL without a preceding ADD CONSTRAINT ... CHECK ... " +
        "NOT VALID + VALIDATE CONSTRAINT shortcut. Postgres will scan the entire table under " +
        "ACCESS EXCLUSIVE during the SET NOT NULL — write outage on a hot table.",
      suggestion:
        "Use expand-contract: (1) ADD CONSTRAINT ck_<col>_not_null CHECK (<col> IS NOT NULL) " +
        "NOT VALID, (2) VALIDATE CONSTRAINT ck_<col>_not_null, (3) ALTER COLUMN <col> " +
        "SET NOT NULL — PG12+ skips the scan.",
    });
  }

  return findings;
}

/**
 * Lint one migration file: EXEMPTED stems are skipped wholesale; everything else runs the pattern
 * detector.
 */
export function lintMigrationFile(relPath: string, sql: string): Array<Violation> {
  const stem = path.posix.basename(relPath).replace(/\.sql$/i, "");
  if (Object.hasOwn(EXEMPTED, stem)) return [];
  return findUnsafeMigrationPatterns(sql).map((f) => ({ file: relPath, ...f }));
}

/** migrations/ sits two levels above this file (scripts/gates/ -> repo root), independent of cwd. */
function migrationsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
}

/** CLI entry: emit H-16-format ERROR lines; return 1 on any violation (ERROR-mode). */
export function main(): number {
  const dir = migrationsDir();
  if (!fs.existsSync(dir)) {
    process.stderr.write(`[ERROR] migrations dir not found: ${dir}\n`);
    return 1;
  }

  const migrationFiles = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const violations: Array<Violation> = [];
  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    violations.push(...lintMigrationFile(`migrations/${file}`, sql));
  }

  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(
        `[ERROR] file=${v.file}:${v.line} rule=${v.rule} ` +
          `message="${v.message}" suggestion="${v.suggestion}"\n`,
      );
    }
    process.stderr.write(
      `\n[ERROR] unsafe-migration-pattern gate: ${violations.length} violation(s)\n`,
    );
    return 1;
  }

  process.stdout.write(
    `[INFO] unsafe-migration-pattern gate: ok (${migrationFiles.length} migrations scanned, ` +
      `${Object.keys(EXEMPTED).length} EXEMPTED)\n`,
  );
  return 0;
}

// CLI shim: run main() when invoked directly (`npx tsx scripts/gates/check_unsafe_migration_pattern.ts`).
// The aggregate runner (run_all.ts) imports main() instead, so this branch is dormant there.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
