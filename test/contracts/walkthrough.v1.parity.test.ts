import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  FileRowV1,
  LinkedIssueV1,
  PrMetaV1,
  WalkthroughV1,
} from "#contracts/walkthrough.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Follows the markdown_chunk.v1 / review_chunk_response.v1
// template. The walkthrough package spans two Python modules (parent v1 + the pr_meta_v1 sibling).
const PY = "contracts.walkthrough.v1";
const PY_PR_META = "contracts.walkthrough.pr_meta_v1";

// Valid nested OutputSafetySanitizationEventV1 payload (sibling contract — built per its fields).
const VALID_SANITIZE = {
  installation_id: "123e4567-e89b-12d3-a456-426614174001",
  request_id: "123e4567-e89b-12d3-a456-426614174002",
  original_text: "leaked AKIA-style secret in preamble",
  redacted_text: "[redacted]",
  spans_redacted: 2,
  detector_kinds: ["aws_key", "generic_secret"],
  stage: "walkthrough",
};

const VALID_FILE_ROW = {
  path: "src/app.py",
  change_summary: "refactored the request handler",
  severity_max: "issue",
  finding_count: 3,
};

const VALID_LINKED_ISSUE = {
  issue_number: 42,
  linkage_kind: "closes",
  title: "Null deref in handler",
  state: "open",
};

describe("FileRowV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: "FileRowV1", kwargs: VALID_FILE_ROW });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FileRowV1.parse(VALID_FILE_ROW))).toBe(r.out);
  }, 30_000);

  it("both REJECT an empty path (min_length=1)", async () => {
    const bad = { ...VALID_FILE_ROW, path: "" };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileRowV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FileRowV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT change_summary over max_length=300", async () => {
    const bad = { ...VALID_FILE_ROW, change_summary: "x".repeat(301) };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileRowV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FileRowV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a finding_count < 0 (ge=0)", async () => {
    const bad = { ...VALID_FILE_ROW, finding_count: -1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileRowV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FileRowV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an out-of-enum severity_max", async () => {
    const bad = { ...VALID_FILE_ROW, severity_max: "critical" };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileRowV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FileRowV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...VALID_FILE_ROW, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileRowV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FileRowV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("LinkedIssueV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: "LinkedIssueV1", kwargs: VALID_LINKED_ISSUE });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(LinkedIssueV1.parse(VALID_LINKED_ISSUE))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (title=null, state=null) when omitted", async () => {
    const payload = { issue_number: 7, linkage_kind: "mentioned" };
    const r = await pyRef({ pyModule: PY, pyCallable: "LinkedIssueV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(LinkedIssueV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.title).toBeNull();
    expect(z.state).toBeNull();
  }, 30_000);

  it("both REJECT issue_number < 1 (ge=1)", async () => {
    const bad = { ...VALID_LINKED_ISSUE, issue_number: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "LinkedIssueV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => LinkedIssueV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT issue_number > 999_999_999 (le)", async () => {
    const bad = { ...VALID_LINKED_ISSUE, issue_number: 1_000_000_000 };
    const r = await pyRef({ pyModule: PY, pyCallable: "LinkedIssueV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => LinkedIssueV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an out-of-enum linkage_kind", async () => {
    const bad = { ...VALID_LINKED_ISSUE, linkage_kind: "addresses" };
    const r = await pyRef({ pyModule: PY, pyCallable: "LinkedIssueV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => LinkedIssueV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an out-of-enum state", async () => {
    const bad = { ...VALID_LINKED_ISSUE, state: "merged" };
    const r = await pyRef({ pyModule: PY, pyCallable: "LinkedIssueV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => LinkedIssueV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT title over max_length=500", async () => {
    const bad = { ...VALID_LINKED_ISSUE, title: "x".repeat(501) };
    const r = await pyRef({ pyModule: PY, pyCallable: "LinkedIssueV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => LinkedIssueV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...VALID_LINKED_ISSUE, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "LinkedIssueV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => LinkedIssueV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("WalkthroughV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a minimal envelope identically (all defaults)", async () => {
    const payload = { tldr: "Reviewed 3 files; one blocker." };
    const r = await pyRef({ pyModule: PY, pyCallable: "WalkthroughV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(WalkthroughV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(1);
    expect(z.file_rows).toEqual([]);
    expect(z.configuration_section_md).toBe("");
    expect(z.degradation_note).toBeNull();
    expect(z.truncated).toBe(false);
    expect(z.suggested_reviewers).toEqual([]);
    expect(z.linked_issues).toEqual([]);
    expect(z.sanitization_event).toBeNull();
  }, 30_000);

  it("validates + dumps a fully-populated envelope identically", async () => {
    const payload = {
      tldr: "Reviewed 3 files; one blocker.",
      file_rows: [VALID_FILE_ROW],
      configuration_section_md: "## Config\n- foo: bar",
      degradation_note: "Review ran in fallback mode.",
      truncated: true,
      suggested_reviewers: ["octocat", "hubot"],
      linked_issues: [VALID_LINKED_ISSUE],
      sanitization_event: VALID_SANITIZE,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "WalkthroughV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(WalkthroughV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts an arbitrary schema_version (bare int, NOT Literal)", async () => {
    const payload = { tldr: "x", schema_version: 2 };
    const r = await pyRef({ pyModule: PY, pyCallable: "WalkthroughV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(WalkthroughV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as { schema_version: number }).schema_version).toBe(2);
  }, 30_000);

  it("both REJECT an empty tldr (min_length=1)", async () => {
    const bad = { tldr: "" };
    const r = await pyRef({ pyModule: PY, pyCallable: "WalkthroughV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WalkthroughV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a tldr over max_length=500", async () => {
    const bad = { tldr: "x".repeat(501) };
    const r = await pyRef({ pyModule: PY, pyCallable: "WalkthroughV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WalkthroughV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT configuration_section_md over max_length=2000", async () => {
    const bad = { tldr: "x", configuration_section_md: "y".repeat(2001) };
    const r = await pyRef({ pyModule: PY, pyCallable: "WalkthroughV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WalkthroughV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT suggested_reviewers over max_length=10", async () => {
    const bad = { tldr: "x", suggested_reviewers: Array.from({ length: 11 }, (_, i) => `r${i}`) };
    const r = await pyRef({ pyModule: PY, pyCallable: "WalkthroughV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WalkthroughV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT linked_issues over max_length=20", async () => {
    const bad = {
      tldr: "x",
      linked_issues: Array.from({ length: 21 }, (_, i) => ({
        issue_number: i + 1,
        linkage_kind: "closes",
      })),
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "WalkthroughV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WalkthroughV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed nested file_row (empty path propagates)", async () => {
    const bad = { tldr: "x", file_rows: [{ ...VALID_FILE_ROW, path: "" }] };
    const r = await pyRef({ pyModule: PY, pyCallable: "WalkthroughV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WalkthroughV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed nested sanitization_event (empty detector_kinds)", async () => {
    const bad = { tldr: "x", sanitization_event: { ...VALID_SANITIZE, detector_kinds: [] } };
    const r = await pyRef({ pyModule: PY, pyCallable: "WalkthroughV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WalkthroughV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { tldr: "x", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "WalkthroughV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WalkthroughV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("PrMetaV1 parity (Pydantic ↔ Zod)", () => {
  // Lowercase UUIDs: Pydantic lowercases on dump; Zod .transform matches.
  const VALID_PR_META = {
    pr_id: "123e4567-e89b-12d3-a456-426614174000",
    installation_id: "123e4567-e89b-12d3-a456-426614174001",
    repo: "octo-org/hello-world",
    pr_title: "Add request handler",
    pr_description: "This PR adds a request handler.",
  };

  it("validates + dumps a minimal payload identically (all enrichment defaults)", async () => {
    const r = await pyRef({ pyModule: PY_PR_META, pyCallable: "PrMetaV1", kwargs: VALID_PR_META });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(PrMetaV1.parse(VALID_PR_META));
    expect(zodCanon).toBe(r.out);
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.author_login).toBeNull();
    expect(z.draft).toBe(false);
    expect(z.base_ref).toBeNull();
    expect(z.head_ref).toBeNull();
    expect(z.opened_at).toBeNull();
    // No schema_version field on PrMetaV1 (versioned with the parent).
    expect("schema_version" in z).toBe(false);
  }, 30_000);

  it("validates + dumps a fully-populated payload identically (incl. datetime + lowercased UUIDs)", async () => {
    const payload = {
      ...VALID_PR_META,
      author_login: "octocat",
      draft: true,
      base_ref: "main",
      head_ref: "feature/handler",
      // RFC3339 with Z — both canonicalizers normalize to .ffffff+00:00.
      opened_at: "2026-06-03T10:00:00Z",
    };
    const r = await pyRef({ pyModule: PY_PR_META, pyCallable: "PrMetaV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PrMetaV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("lowercases an uppercase UUID on dump (Pydantic ↔ Zod .transform)", async () => {
    const payload = { ...VALID_PR_META, pr_id: "123E4567-E89B-12D3-A456-426614174000" };
    const r = await pyRef({ pyModule: PY_PR_META, pyCallable: "PrMetaV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(PrMetaV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as { pr_id: string }).pr_id).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );
  }, 30_000);

  it("accepts an empty pr_title (no min_length)", async () => {
    const payload = { ...VALID_PR_META, pr_title: "" };
    const r = await pyRef({ pyModule: PY_PR_META, pyCallable: "PrMetaV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PrMetaV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a malformed pr_id UUID", async () => {
    const bad = { ...VALID_PR_META, pr_id: "not-a-uuid" };
    const r = await pyRef({ pyModule: PY_PR_META, pyCallable: "PrMetaV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PrMetaV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty repo (min_length=1)", async () => {
    const bad = { ...VALID_PR_META, repo: "" };
    const r = await pyRef({ pyModule: PY_PR_META, pyCallable: "PrMetaV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PrMetaV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a repo over max_length=200", async () => {
    const bad = { ...VALID_PR_META, repo: "x".repeat(201) };
    const r = await pyRef({ pyModule: PY_PR_META, pyCallable: "PrMetaV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PrMetaV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a pr_title over max_length=500", async () => {
    const bad = { ...VALID_PR_META, pr_title: "x".repeat(501) };
    const r = await pyRef({ pyModule: PY_PR_META, pyCallable: "PrMetaV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PrMetaV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a pr_description over max_length=10000", async () => {
    const bad = { ...VALID_PR_META, pr_description: "x".repeat(10_001) };
    const r = await pyRef({ pyModule: PY_PR_META, pyCallable: "PrMetaV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PrMetaV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an author_login over max_length=64", async () => {
    const bad = { ...VALID_PR_META, author_login: "x".repeat(65) };
    const r = await pyRef({ pyModule: PY_PR_META, pyCallable: "PrMetaV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PrMetaV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...VALID_PR_META, bogus: 1 };
    const r = await pyRef({ pyModule: PY_PR_META, pyCallable: "PrMetaV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PrMetaV1.parse(bad)).toThrow();
  }, 30_000);
});
