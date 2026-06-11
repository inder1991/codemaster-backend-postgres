import { describe, expect, it } from "vitest";

import {
  EXEMPTED,
  findUnsafeMigrationPatterns,
  lintMigrationFile,
  main,
  RULE_DELETE_AND_SET_NOT_NULL,
  RULE_SET_NOT_NULL_WITHOUT_NOT_VALID,
  stripSqlComments,
} from "../../scripts/gates/check_unsafe_migration_pattern.js";

// Inline raw-SQL fixtures exercise the gate's pure detectors directly (no temp dirs), mirroring the
// frozen Python gate's tests, which fed synthetic alembic upgrade() bodies through lint_file. The
// fixtures below reproduce the same shapes: the unsafe purge-then-SET-NOT-NULL migration the gate
// exists to block (the Python repo's grandfathered 0074), the expand-contract shortcut that makes
// SET NOT NULL safe, and the comment/string lexical traps specific to raw .sql files.

const UNSAFE_PURGE_THEN_NOT_NULL = [
  "DELETE FROM core.outbox WHERE run_id IS NULL;",
  "ALTER TABLE core.outbox ALTER COLUMN run_id SET NOT NULL;",
].join("\n");

const SAFE_EXPAND_CONTRACT = [
  "ALTER TABLE core.outbox ADD CONSTRAINT ck_outbox_run_id_not_null",
  "  CHECK (run_id IS NOT NULL) NOT VALID;",
  "ALTER TABLE core.outbox VALIDATE CONSTRAINT ck_outbox_run_id_not_null;",
  "ALTER TABLE core.outbox ALTER COLUMN run_id SET NOT NULL;",
].join("\n");

function rulesOf(sql: string): Array<string> {
  return findUnsafeMigrationPatterns(sql).map((f) => f.rule);
}

describe("unsafe-migration-pattern gate", () => {
  it("should export an empty EXEMPTED dict at landing (no existing migration trips the gate)", () => {
    expect(EXEMPTED).toEqual({});
  });

  describe("Pattern A: DELETE FROM + SET NOT NULL in the same migration", () => {
    it("should flag the purge-then-SET-NOT-NULL shape (both A and B fire, like the Python gate)", () => {
      const findings = findUnsafeMigrationPatterns(UNSAFE_PURGE_THEN_NOT_NULL);
      expect(findings.map((f) => f.rule)).toEqual([
        RULE_DELETE_AND_SET_NOT_NULL,
        RULE_SET_NOT_NULL_WITHOUT_NOT_VALID,
      ]);
    });

    it("should report the DELETE target table, lowercased", () => {
      const [a] = findUnsafeMigrationPatterns(UNSAFE_PURGE_THEN_NOT_NULL);
      expect(a!.message).toContain("DELETE FROM core.outbox");
      expect(a!.message).toContain("core.outbox_archive_<NNNN>");
    });

    it("should fire even when DELETE and SET NOT NULL hit different tables (joined-body scope, faithful to the original)", () => {
      const sql = [
        "DELETE FROM audit.events WHERE created_at < '2025-01-01';",
        "ALTER TABLE core.outbox ADD CONSTRAINT ck CHECK (run_id IS NOT NULL) NOT VALID;",
        "ALTER TABLE core.outbox VALIDATE CONSTRAINT ck;",
        "ALTER TABLE core.outbox ALTER COLUMN run_id SET NOT NULL;",
      ].join("\n");
      const findings = findUnsafeMigrationPatterns(sql);
      // NOT VALID is present, so only A fires — and it names the DELETE target.
      expect(findings.map((f) => f.rule)).toEqual([RULE_DELETE_AND_SET_NOT_NULL]);
      expect(findings[0]!.message).toContain("audit.events");
    });

    it("should fall back to <unknown> when the DELETE target is a quoted identifier (extraction regex is [\\w.]+, like the original)", () => {
      const sql = ['DELETE FROM "Legacy Table";', "ALTER TABLE t ALTER COLUMN c SET NOT NULL;"].join("\n");
      const [a] = findUnsafeMigrationPatterns(sql);
      expect(a!.rule).toBe(RULE_DELETE_AND_SET_NOT_NULL);
      expect(a!.message).toContain("DELETE FROM <unknown>");
    });

    it("should NOT fire on DELETE FROM alone (archive rule only pairs with a NOT NULL backfill)", () => {
      expect(rulesOf("DELETE FROM core.outbox WHERE run_id IS NULL;")).toEqual([]);
    });
  });

  describe("Pattern B: SET NOT NULL without the NOT VALID expand-contract shortcut", () => {
    it("should flag a bare SET NOT NULL", () => {
      expect(rulesOf("ALTER TABLE core.outbox ALTER COLUMN run_id SET NOT NULL;")).toEqual([
        RULE_SET_NOT_NULL_WITHOUT_NOT_VALID,
      ]);
    });

    it("should pass the full expand-contract sequence (NOT VALID + VALIDATE + SET NOT NULL)", () => {
      expect(rulesOf(SAFE_EXPAND_CONTRACT)).toEqual([]);
    });

    it("should match case-insensitively (the original uppercases the joined body)", () => {
      expect(rulesOf("alter table t alter column c set not null;")).toEqual([
        RULE_SET_NOT_NULL_WITHOUT_NOT_VALID,
      ]);
    });

    it("should tolerate a line break inside NOT VALID (raw-SQL adaptation of the original's substring check)", () => {
      const sql = [
        "ALTER TABLE t ADD CONSTRAINT ck CHECK (c IS NOT NULL) NOT",
        "  VALID;",
        "ALTER TABLE t VALIDATE CONSTRAINT ck;",
        "ALTER TABLE t ALTER COLUMN c SET NOT NULL;",
      ].join("\n");
      expect(rulesOf(sql)).toEqual([]);
    });
  });

  describe("comment stripping (raw-SQL analogue of the original's op.execute-strings-only scope)", () => {
    it("should not match pattern phrases that appear only in -- comments", () => {
      const sql = [
        "-- DELETE FROM core.outbox would be unsafe here; SET NOT NULL needs NOT VALID first",
        "CREATE TABLE core.example (id bigint PRIMARY KEY);",
      ].join("\n");
      expect(rulesOf(sql)).toEqual([]);
    });

    it("should not match pattern phrases inside nested /* */ block comments", () => {
      const sql = "/* outer /* DELETE FROM x; SET NOT NULL */ still comment */ SELECT 1;";
      expect(rulesOf(sql)).toEqual([]);
    });

    it("should preserve line numbers when stripping (comments replaced by equal-length whitespace)", () => {
      const sql = [
        "-- rationale header line 1",
        "-- rationale header line 2",
        "DELETE FROM core.events;",
        "ALTER TABLE core.events ALTER COLUMN x SET NOT NULL;",
      ].join("\n");
      const findings = findUnsafeMigrationPatterns(sql);
      expect(findings.find((f) => f.rule === RULE_DELETE_AND_SET_NOT_NULL)!.line).toBe(3);
      expect(findings.find((f) => f.rule === RULE_SET_NOT_NULL_WITHOUT_NOT_VALID)!.line).toBe(4);
    });

    it("should not treat -- inside a string literal as a comment", () => {
      expect(stripSqlComments("SELECT 'a--b' FROM t;")).toBe("SELECT 'a--b' FROM t;");
    });

    it("should not let an apostrophe inside a comment swallow the following SQL", () => {
      // 0042-style rationale comments quote state names ('ready', 'dead'); an unpaired ' in a
      // comment must not open a string and hide subsequent executable SQL from the scan.
      const sql = ["-- don't purge here", "ALTER TABLE t ALTER COLUMN c SET NOT NULL;"].join("\n");
      expect(rulesOf(sql)).toEqual([RULE_SET_NOT_NULL_WITHOUT_NOT_VALID]);
    });

    it("should keep dollar-quoted bodies in scope (faithful: the original matched the full executed string)", () => {
      // A DO-block string literal mentioning the phrases counts, exactly as it would have inside
      // an op.execute() string in the Python original — coarse, but cheap to exempt vs. a missed purge.
      const sql = [
        "DO $$ BEGIN RAISE EXCEPTION 'never DELETE FROM core.x'; END $$;",
        "ALTER TABLE t ALTER COLUMN c SET NOT NULL;",
      ].join("\n");
      expect(rulesOf(sql)).toEqual([
        RULE_DELETE_AND_SET_NOT_NULL,
        RULE_SET_NOT_NULL_WITHOUT_NOT_VALID,
      ]);
    });
  });

  describe("EXEMPTED grandfather mechanism (stem-keyed, like the Python gate)", () => {
    const relPath = "migrations/0099_outbox_run_id_not_null.sql";

    it("should attribute violations to the migration's repo-relative path", () => {
      const v = lintMigrationFile(relPath, UNSAFE_PURGE_THEN_NOT_NULL);
      expect(v).toHaveLength(2);
      expect(v[0]!.file).toBe(relPath);
    });

    it("should skip a migration whose stem is in EXEMPTED", () => {
      EXEMPTED["0099_outbox_run_id_not_null"] = {
        reason: "test-only grandfather entry (removed in finally)",
        follow_up_story: "PERMANENT-EXEMPTION-test-fixture",
      };
      try {
        expect(lintMigrationFile(relPath, UNSAFE_PURGE_THEN_NOT_NULL)).toHaveLength(0);
      } finally {
        delete EXEMPTED["0099_outbox_run_id_not_null"];
      }
    });
  });

  describe("main() against the real migrations corpus", () => {
    it("should return 0 (migrations 0001-0042 contain no DELETE FROM / SET NOT NULL — steady-state invariant)", () => {
      expect(main()).toBe(0);
    });
  });
});
