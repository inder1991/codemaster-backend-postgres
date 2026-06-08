/**
 * Unit tests for `parseCodeowners` — 1:1 with the frozen Python
 * `vendor/codemaster-py/codemaster/integrations/github/codeowners_parser.py::parse_codeowners`. Pure
 * function; asserts the GitHub CODEOWNERS grammar (comments, inline comments, blank/whitespace lines,
 * malformed lines, multi-owner, user-vs-team @refs, line-number diagnostics, CRLF line endings).
 */

import { describe, expect, it } from "vitest";

import { parseCodeowners } from "#backend/integrations/github/codeowners_parser.js";

describe("parseCodeowners", () => {
  it("returns [] for empty input", () => {
    expect(parseCodeowners("")).toEqual([]);
  });

  it("parses a single rule with one owner and 1-indexed line number", () => {
    const rules = parseCodeowners("*  @org/global");
    expect(rules).toEqual([{ path_pattern: "*", owner_logins: ["@org/global"], line_number: 1 }]);
  });

  it("parses multiple owners on one line (user + team), preserving order + the leading @", () => {
    const rules = parseCodeowners("/docs/  @writer @org/docs-team @indersingh");
    expect(rules).toEqual([
      {
        path_pattern: "/docs/",
        owner_logins: ["@writer", "@org/docs-team", "@indersingh"],
        line_number: 1,
      },
    ]);
  });

  it("ignores full-line comments + blank/whitespace-only lines (line numbers still track source)", () => {
    const body = ["# header comment", "", "   ", "*  @org/owners", "# trailing comment"].join("\n");
    const rules = parseCodeowners(body);
    // Only line 4 is a valid rule; its line_number reflects the SOURCE line (4), not the rule index.
    expect(rules).toEqual([{ path_pattern: "*", owner_logins: ["@org/owners"], line_number: 4 }]);
  });

  it("strips an inline comment after the owners on the same line", () => {
    const rules = parseCodeowners("src/**.ts  @indersingh   # platform owns the TS spine");
    expect(rules).toEqual([
      { path_pattern: "src/**.ts", owner_logins: ["@indersingh"], line_number: 1 },
    ]);
  });

  it("drops a line with a pattern but no owners (< 2 tokens)", () => {
    expect(parseCodeowners("/orphan-pattern")).toEqual([]);
  });

  it("drops owners that fail the @ grammar but keeps the valid ones on the same line", () => {
    // `not-an-owner` (no leading @) and `@` (empty after @) are dropped; `@valid` survives.
    const rules = parseCodeowners("/mixed  not-an-owner @valid bare-word");
    expect(rules).toEqual([{ path_pattern: "/mixed", owner_logins: ["@valid"], line_number: 1 }]);
  });

  it("drops a line whose ALL owner tokens are invalid (no valid owner remains)", () => {
    expect(parseCodeowners("/none  plainword another")).toEqual([]);
  });

  it("collapses runs of whitespace between tokens (tabs + multiple spaces)", () => {
    const rules = parseCodeowners("/tabs\t\t@a   \t  @b");
    expect(rules).toEqual([{ path_pattern: "/tabs", owner_logins: ["@a", "@b"], line_number: 1 }]);
  });

  it("handles CRLF line endings the same as LF (Python splitlines parity)", () => {
    const rules = parseCodeowners("*  @a\r\n/docs  @b\r\n");
    expect(rules).toEqual([
      { path_pattern: "*", owner_logins: ["@a"], line_number: 1 },
      { path_pattern: "/docs", owner_logins: ["@b"], line_number: 2 },
    ]);
  });

  it("accepts owner refs containing dots/hyphens/underscores/slashes per the @ grammar", () => {
    const rules = parseCodeowners("/p  @user.name-1_x @org/team-2.0");
    expect(rules[0]?.owner_logins).toEqual(["@user.name-1_x", "@org/team-2.0"]);
  });
});
