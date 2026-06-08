// Parity test for parseIssueLinks — 1:1 port of the frozen Python
// `codemaster/ingest/issue_link_parser.py::parse_issue_links`. Every expectation below was confirmed
// against the LIVE frozen Python parser (vendor/codemaster-py/.venv/bin/python) so the TS byte-matches
// its keyword/bare-hash extraction, two-pass dedup, keyword-wins, and insertion-order semantics.

import { describe, expect, it } from "vitest";

import { parseIssueLinks } from "#backend/ingest/issue_link_parser.js";

import type { IssueLink } from "#contracts/issue_link.v1.js";

describe("parseIssueLinks", () => {
  it("maps Closes/Fixes/Resolves to the right linkage_kind", () => {
    expect(parseIssueLinks({ text: "Closes #5", source: "description" })).toEqual<Array<IssueLink>>([
      { github_issue_number: 5, linkage_kind: "closes", source: "description" },
    ]);
    expect(parseIssueLinks({ text: "Fixes #5", source: "description" })).toEqual<Array<IssueLink>>([
      { github_issue_number: 5, linkage_kind: "fixes", source: "description" },
    ]);
    expect(parseIssueLinks({ text: "Resolves #5", source: "description" })).toEqual<Array<IssueLink>>([
      { github_issue_number: 5, linkage_kind: "resolves", source: "description" },
    ]);
  });

  it("is case-insensitive and accepts the keyword variant forms (closed / FIX / resolved)", () => {
    expect(parseIssueLinks({ text: "closed #5", source: "description" })).toEqual<Array<IssueLink>>([
      { github_issue_number: 5, linkage_kind: "closes", source: "description" },
    ]);
    expect(parseIssueLinks({ text: "FIX #5", source: "description" })).toEqual<Array<IssueLink>>([
      { github_issue_number: 5, linkage_kind: "fixes", source: "description" },
    ]);
    expect(parseIssueLinks({ text: "resolved #5", source: "description" })).toEqual<Array<IssueLink>>([
      { github_issue_number: 5, linkage_kind: "resolves", source: "description" },
    ]);
  });

  it("accepts an optional colon and zero-or-more whitespace between keyword and #N", () => {
    expect(parseIssueLinks({ text: "Closes: #5", source: "description" })).toEqual<Array<IssueLink>>([
      { github_issue_number: 5, linkage_kind: "closes", source: "description" },
    ]);
    expect(parseIssueLinks({ text: "Closes#5", source: "description" })).toEqual<Array<IssueLink>>([
      { github_issue_number: 5, linkage_kind: "closes", source: "description" },
    ]);
  });

  it("treats a bare #N as a mentioned link", () => {
    expect(parseIssueLinks({ text: "some text #7 here", source: "description" })).toEqual<Array<IssueLink>>([
      { github_issue_number: 7, linkage_kind: "mentioned", source: "description" },
    ]);
  });

  it("keyword wins over a bare mention for the same issue number", () => {
    // `Closes #5 and also #5 mentioned` → ONE link, the keyword one (the bare #5 is skipped).
    expect(
      parseIssueLinks({ text: "Closes #5 and also #5 mentioned", source: "description" }),
    ).toEqual<Array<IssueLink>>([{ github_issue_number: 5, linkage_kind: "closes", source: "description" }]);
  });

  it("dedups the same (number, kind) within one text — Closes #5 twice → ONE link", () => {
    expect(parseIssueLinks({ text: "Closes #5 Closes #5", source: "description" })).toEqual<Array<IssueLink>>([
      { github_issue_number: 5, linkage_kind: "closes", source: "description" },
    ]);
  });

  it("does NOT match a bare #N after a word/slash (owner/repo#9, word#5) — the (?<![\\w/]) lookbehind", () => {
    // Confirmed against live Python: both produce [].
    expect(parseIssueLinks({ text: "see owner/repo#9 for details", source: "description" })).toEqual([]);
    expect(parseIssueLinks({ text: "word#5", source: "description" })).toEqual([]);
  });

  it("does NOT match `Closes owner/repo#9` — the keyword regex requires #N right after the keyword", () => {
    // Confirmed against live Python: `Closes owner/repo#9` → [] (cross-repo qualifier is unsupported in v0;
    // the keyword regex's `\\s*[:\\s]?\\s*#` does not span `owner/repo`, and the bare-hash lookbehind rejects
    // `#9` after `repo`).
    expect(parseIssueLinks({ text: "Closes owner/repo#9", source: "description" })).toEqual([]);
    expect(parseIssueLinks({ text: "Fixes owner/repo#9", source: "description" })).toEqual([]);
  });

  it("ignores #0 / n <= 0", () => {
    expect(parseIssueLinks({ text: "Closes #0 and #0", source: "description" })).toEqual([]);
  });

  it("returns [] for empty text", () => {
    expect(parseIssueLinks({ text: "", source: "description" })).toEqual([]);
  });

  it("preserves insertion order: keyword pass (in text order) then bare-mention pass", () => {
    // Live Python order: [(10,fixes),(20,closes),(3,mentioned)].
    expect(
      parseIssueLinks({ text: "Fixes #10 mentions #3 closes #20", source: "description" }),
    ).toEqual<Array<IssueLink>>([
      { github_issue_number: 10, linkage_kind: "fixes", source: "description" },
      { github_issue_number: 20, linkage_kind: "closes", source: "description" },
      { github_issue_number: 3, linkage_kind: "mentioned", source: "description" },
    ]);
  });

  it("threads the given source onto every link", () => {
    for (const source of ["description", "title", "branch_name", "commit_message"] as const) {
      const links = parseIssueLinks({ text: "Closes #5 mentions #7", source });
      expect(links).toEqual<Array<IssueLink>>([
        { github_issue_number: 5, linkage_kind: "closes", source },
        { github_issue_number: 7, linkage_kind: "mentioned", source },
      ]);
    }
  });
});
