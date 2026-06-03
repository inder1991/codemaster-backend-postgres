import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { PersistReviewWalkthroughInputV1 } from "#contracts/persist_review_walkthrough.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `PersistReviewWalkthroughInputV1(**payload).model_dump(mode="json")`) and through Zod
// (`PersistReviewWalkthroughInputV1.parse(payload)`), then diff canonical JSON. Accept/reject must
// also agree. Follows the markdown_chunk.v1 / walkthrough.v1 template. The contract embeds a nested
// WalkthroughV1 (sibling contract — built per its fields).
const PY = "contracts.persist_review_walkthrough.v1";

// Lowercase UUIDs: Pydantic lowercases on dump; Zod .transform matches.
const REVIEW_ID = "123e4567-e89b-12d3-a456-426614174000";
const INSTALLATION_ID = "123e4567-e89b-12d3-a456-426614174001";

// Minimal valid nested WalkthroughV1 payload (sibling contract — only tldr is required).
const VALID_WALKTHROUGH_MINIMAL = { tldr: "Reviewed 3 files; one blocker." };

// Fully-populated nested WalkthroughV1 (built per the sibling's fields, incl. its nested contracts).
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
const VALID_SANITIZE = {
  installation_id: "123e4567-e89b-12d3-a456-426614174002",
  request_id: "123e4567-e89b-12d3-a456-426614174003",
  original_text: "leaked AKIA-style secret in preamble",
  redacted_text: "[redacted]",
  spans_redacted: 2,
  detector_kinds: ["aws_key", "generic_secret"],
  stage: "walkthrough",
};
const VALID_WALKTHROUGH_FULL = {
  tldr: "Reviewed 3 files; one blocker.",
  file_rows: [VALID_FILE_ROW],
  configuration_section_md: "## Config\n- foo: bar",
  degradation_note: "Review ran in fallback mode.",
  truncated: true,
  suggested_reviewers: ["octocat", "hubot"],
  linked_issues: [VALID_LINKED_ISSUE],
  sanitization_event: VALID_SANITIZE,
};

const VALID_INPUT = {
  review_id: REVIEW_ID,
  installation_id: INSTALLATION_ID,
  walkthrough: VALID_WALKTHROUGH_MINIMAL,
};

describe("PersistReviewWalkthroughInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a minimal payload identically (schema_version default + minimal walkthrough)", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewWalkthroughInputV1", kwargs: VALID_INPUT });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(PersistReviewWalkthroughInputV1.parse(VALID_INPUT));
    expect(zodCanon).toBe(r.out);
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(1);
    expect(z.review_id).toBe(REVIEW_ID);
    expect(z.installation_id).toBe(INSTALLATION_ID);
  }, 30_000);

  it("validates + dumps a fully-populated payload identically (nested WalkthroughV1 round-trips)", async () => {
    const payload = {
      schema_version: 1,
      review_id: REVIEW_ID,
      installation_id: INSTALLATION_ID,
      walkthrough: VALID_WALKTHROUGH_FULL,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewWalkthroughInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PersistReviewWalkthroughInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts an arbitrary schema_version (bare int, NOT Literal)", async () => {
    const payload = { ...VALID_INPUT, schema_version: 2 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewWalkthroughInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(PersistReviewWalkthroughInputV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as { schema_version: number }).schema_version).toBe(2);
  }, 30_000);

  it("lowercases uppercase UUIDs on dump (Pydantic ↔ Zod .transform), both fields", async () => {
    const payload = {
      ...VALID_INPUT,
      review_id: "123E4567-E89B-12D3-A456-426614174000",
      installation_id: "123E4567-E89B-12D3-A456-426614174001",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewWalkthroughInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(PersistReviewWalkthroughInputV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    const z = JSON.parse(zodCanon) as { review_id: string; installation_id: string };
    expect(z.review_id).toBe(REVIEW_ID);
    expect(z.installation_id).toBe(INSTALLATION_ID);
  }, 30_000);

  it("both REJECT a malformed review_id UUID", async () => {
    const bad = { ...VALID_INPUT, review_id: "not-a-uuid" };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewWalkthroughInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PersistReviewWalkthroughInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed installation_id UUID", async () => {
    const bad = { ...VALID_INPUT, installation_id: "not-a-uuid" };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewWalkthroughInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PersistReviewWalkthroughInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing walkthrough (required, no default)", async () => {
    const bad = { review_id: REVIEW_ID, installation_id: INSTALLATION_ID };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewWalkthroughInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PersistReviewWalkthroughInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed nested walkthrough (empty tldr propagates)", async () => {
    const bad = { ...VALID_INPUT, walkthrough: { tldr: "" } };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewWalkthroughInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PersistReviewWalkthroughInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed nested walkthrough file_row (empty path propagates)", async () => {
    const bad = {
      ...VALID_INPUT,
      walkthrough: { tldr: "x", file_rows: [{ ...VALID_FILE_ROW, path: "" }] },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewWalkthroughInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PersistReviewWalkthroughInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...VALID_INPUT, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewWalkthroughInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PersistReviewWalkthroughInputV1.parse(bad)).toThrow();
  }, 30_000);
});
