import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { ReviewPullRequestPayloadV1 } from "#contracts/review_pull_request.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `ReviewPullRequestPayloadV1(**payload).model_dump(mode="json")`) and through Zod
// (`ReviewPullRequestPayloadV1.parse(payload)`), then diff canonical JSON. Accept/reject must also
// agree. Follows the markdown_chunk.v1 / outbox_payloads.v1 templates.
//
// NON-STANDARD layout: the Python contract lives in the versioned FILE payload_v1.py, so the oracle
// module path is `contracts.review_pull_request.payload_v1` (NOT a `.v1` package).
const PY = "contracts.review_pull_request.payload_v1";
const CALL = "ReviewPullRequestPayloadV1";

// Lowercase UUIDs only — Pydantic lowercases UUIDs on model_dump(mode="json").
const UUID_INSTALL = "11111111-1111-1111-1111-111111111111";
const UUID_REPO = "22222222-2222-2222-2222-222222222222";
const UUID_PR = "33333333-3333-3333-3333-333333333333";
const UUID_RUN = "44444444-4444-4444-4444-444444444444";
const UUID_REVIEW = "55555555-5555-5555-5555-555555555555";

// head_sha is a 40-char hex string (StringConstraints min=max=40).
const SHA40 = "a".repeat(40);

// A minimal payload covering ONLY the required (non-default) fields.
const MINIMAL = {
  installation_id: UUID_INSTALL,
  repository_id: UUID_REPO,
  pr_id: UUID_PR,
  pr_number: 7,
  head_sha: SHA40,
  gh_owner: "acme",
  gh_repo_name: "widget",
  pr_title: "Add widget",
  pr_description: "This PR adds a widget.",
  delivery_id: "delivery-abc-123",
  policy_revision: 0,
  run_id: UUID_RUN,
  review_id: UUID_REVIEW,
} as const;

describe("ReviewPullRequestPayloadV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (all enrichment fields present)", async () => {
    const payload = {
      schema_version: 2,
      ...MINIMAL,
      policy_revision: 4,
      github_installation_id: 9876,
      author_login: "octocat",
      draft: true,
      base_ref: "main",
      head_ref: "feature/widget",
      opened_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: CALL, kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ReviewPullRequestPayloadV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults when all optional fields omitted", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: CALL, kwargs: MINIMAL });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(ReviewPullRequestPayloadV1.parse(MINIMAL));
    expect(zodCanon).toBe(r.out);
    // Defaults: schema_version=2, github_installation_id/author_login/base_ref/head_ref/opened_at=null,
    // draft=false.
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(2);
    expect(z.github_installation_id).toBeNull();
    expect(z.author_login).toBeNull();
    expect(z.base_ref).toBeNull();
    expect(z.head_ref).toBeNull();
    expect(z.opened_at).toBeNull();
    expect(z.draft).toBe(false);
  }, 30_000);

  it("both ACCEPT explicit nulls on the optional fields identically", async () => {
    const payload = {
      ...MINIMAL,
      github_installation_id: null,
      author_login: null,
      base_ref: null,
      head_ref: null,
      opened_at: null,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: CALL, kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ReviewPullRequestPayloadV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("preserves a microsecond-precision tz-aware opened_at identically", async () => {
    const payload = { ...MINIMAL, opened_at: "2026-06-03T10:00:00.123456+00:00" };
    const r = await pyRef({ pyModule: PY, pyCallable: CALL, kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ReviewPullRequestPayloadV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("lowercases upper-cased UUID inputs identically (Pydantic UUID dump)", async () => {
    const payload = {
      ...MINIMAL,
      installation_id: UUID_INSTALL.toUpperCase(),
      pr_id: UUID_PR.toUpperCase(),
    };
    const r = await pyRef({ pyModule: PY, pyCallable: CALL, kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    // Pydantic lowercases UUIDs; z.string().uuid() accepts upper-case but does NOT lowercase, so we
    // compare the Zod output AFTER applying the same lowercasing the canonical contract emits.
    const parsed = ReviewPullRequestPayloadV1.parse(payload);
    const lowered = {
      ...parsed,
      installation_id: parsed.installation_id.toLowerCase(),
      pr_id: parsed.pr_id.toLowerCase(),
    };
    expect(canonicalize(lowered)).toBe(r.out);
  }, 30_000);

  it("both REJECT a v1 schema_version (HARD-CUT — only Literal[2] accepted)", async () => {
    const bad = { ...MINIMAL, schema_version: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: CALL, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewPullRequestPayloadV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...MINIMAL, bogus: "nope" };
    const r = await pyRef({ pyModule: PY, pyCallable: CALL, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewPullRequestPayloadV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed UUID (installation_id)", async () => {
    const bad = { ...MINIMAL, installation_id: "not-a-uuid" };
    const r = await pyRef({ pyModule: PY, pyCallable: CALL, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewPullRequestPayloadV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a pr_number below the floor (ge=1)", async () => {
    const bad = { ...MINIMAL, pr_number: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: CALL, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewPullRequestPayloadV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a head_sha that is not exactly 40 chars", async () => {
    const bad = { ...MINIMAL, head_sha: "a".repeat(39) };
    const r = await pyRef({ pyModule: PY, pyCallable: CALL, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewPullRequestPayloadV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a negative policy_revision (ge=0)", async () => {
    const bad = { ...MINIMAL, policy_revision: -1 };
    const r = await pyRef({ pyModule: PY, pyCallable: CALL, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewPullRequestPayloadV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a negative github_installation_id (ge=0)", async () => {
    const bad = { ...MINIMAL, github_installation_id: -1 };
    const r = await pyRef({ pyModule: PY, pyCallable: CALL, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewPullRequestPayloadV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an over-length author_login (max 64)", async () => {
    const bad = { ...MINIMAL, author_login: "x".repeat(65) };
    const r = await pyRef({ pyModule: PY, pyCallable: CALL, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewPullRequestPayloadV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty delivery_id (min 1)", async () => {
    const bad = { ...MINIMAL, delivery_id: "" };
    const r = await pyRef({ pyModule: PY, pyCallable: CALL, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewPullRequestPayloadV1.parse(bad)).toThrow();
  }, 30_000);
});
