import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  ConfluencePageApprovalV1,
  CreatePageApprovalRequestV1,
  DefaultApprovalV1,
} from "../../libs/contracts/src/page_approval.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `<Model>(**payload).model_dump(mode="json")`) and through Zod
// (`<Model>.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
//
// EmailStr / HttpUrl NORMALIZE on the Python side (EmailStr lowercases the email DOMAIN; HttpUrl
// lowercases the host + appends a trailing slash to a bare host). UUIDs are lowercased on dump. Zod's
// .email()/.url()/.uuid() pass the input through verbatim, so every parity payload supplies an
// already-normalized value (lowercase email + lowercase-host URL with explicit/trailing path +
// lowercase UUID) — otherwise the canonical diff would spuriously fail on the Python-side
// normalization. The two `_require_tz`-guarded models (DefaultApprovalV1 / CreatePageApprovalRequestV1)
// REJECT a naive datetime; ConfluencePageApprovalV1's datetime fields are plain (no _require_tz).
const PY = "contracts.confluence.page_approval.v1";

describe("DefaultApprovalV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = {
      approver_email: "admin@example.com",
      approved_at_utc: "2026-06-03T10:00:00+00:00",
      approval_artifact_url: "https://example.com/approval/123",
      scope_justification: "x".repeat(20),
      default_scope: "universal",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DefaultApprovalV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DefaultApprovalV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = {
      approver_email: "ops@example.com",
      approved_at_utc: "2026-06-03T10:00:00.123456+00:00",
      approval_artifact_url: "https://example.com/",
      scope_justification: "a clear justification of the scope decision",
      default_scope: "security_only",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DefaultApprovalV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DefaultApprovalV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a naive (offset-less) approved_at_utc (_require_tz)", async () => {
    const bad = {
      approver_email: "admin@example.com",
      approved_at_utc: "2026-06-03T10:00:00",
      approval_artifact_url: "https://example.com/",
      scope_justification: "x".repeat(20),
      default_scope: "universal",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DefaultApprovalV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DefaultApprovalV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a too-short scope_justification (min_length=20)", async () => {
    const bad = {
      approver_email: "admin@example.com",
      approved_at_utc: "2026-06-03T10:00:00+00:00",
      approval_artifact_url: "https://example.com/",
      scope_justification: "too short",
      default_scope: "universal",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DefaultApprovalV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DefaultApprovalV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid default_scope enum value", async () => {
    const bad = {
      approver_email: "admin@example.com",
      approved_at_utc: "2026-06-03T10:00:00+00:00",
      approval_artifact_url: "https://example.com/",
      scope_justification: "x".repeat(20),
      default_scope: "bogus_scope",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DefaultApprovalV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DefaultApprovalV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed approver_email", async () => {
    const bad = {
      approver_email: "not-an-email",
      approved_at_utc: "2026-06-03T10:00:00+00:00",
      approval_artifact_url: "https://example.com/",
      scope_justification: "x".repeat(20),
      default_scope: "universal",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DefaultApprovalV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DefaultApprovalV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-URL approval_artifact_url", async () => {
    const bad = {
      approver_email: "admin@example.com",
      approved_at_utc: "2026-06-03T10:00:00+00:00",
      approval_artifact_url: "not-a-url",
      scope_justification: "x".repeat(20),
      default_scope: "universal",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DefaultApprovalV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DefaultApprovalV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      approver_email: "admin@example.com",
      approved_at_utc: "2026-06-03T10:00:00+00:00",
      approval_artifact_url: "https://example.com/",
      scope_justification: "x".repeat(20),
      default_scope: "universal",
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DefaultApprovalV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DefaultApprovalV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("CreatePageApprovalRequestV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid POST body identically", async () => {
    const payload = {
      space_key: "ENG",
      page_id: "123456",
      approved_at_utc: "2026-06-03T10:00:00+00:00",
      approval_artifact_url: "https://example.com/approval/req",
      scope_justification: "this is a sufficiently long justification",
      default_scope: "compliance_only",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CreatePageApprovalRequestV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(CreatePageApprovalRequestV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an approver_email field (intentionally absent — audit P0-1)", async () => {
    // approver_email is NOT a field on the create body; supplying it is an extra-field → forbid/strict.
    const bad = {
      space_key: "ENG",
      page_id: "123456",
      approver_email: "attacker@example.com",
      approved_at_utc: "2026-06-03T10:00:00+00:00",
      approval_artifact_url: "https://example.com/",
      scope_justification: "x".repeat(20),
      default_scope: "universal",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CreatePageApprovalRequestV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CreatePageApprovalRequestV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a naive (offset-less) approved_at_utc (_require_tz)", async () => {
    const bad = {
      space_key: "ENG",
      page_id: "123456",
      approved_at_utc: "2026-06-03T10:00:00",
      approval_artifact_url: "https://example.com/",
      scope_justification: "x".repeat(20),
      default_scope: "universal",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CreatePageApprovalRequestV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CreatePageApprovalRequestV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty space_key (min_length=1)", async () => {
    const bad = {
      space_key: "",
      page_id: "123456",
      approved_at_utc: "2026-06-03T10:00:00+00:00",
      approval_artifact_url: "https://example.com/",
      scope_justification: "x".repeat(20),
      default_scope: "universal",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CreatePageApprovalRequestV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CreatePageApprovalRequestV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("ConfluencePageApprovalV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full row (with revocation state) identically", async () => {
    const payload = {
      approval_id: "1a2b3c4d-1111-2222-3333-444455556666",
      space_key: "ENG",
      page_id: "123456",
      approver_email: "admin@example.com",
      approved_at_utc: "2026-06-03T10:00:00+00:00",
      approval_artifact_url: "https://example.com/approval/123",
      scope_justification: "x".repeat(20),
      default_scope: "framework_only",
      revoked_at: "2026-06-04T12:00:00+00:00",
      revoked_by: "revoker@example.com",
      created_at: "2026-06-03T09:00:00+00:00",
      updated_at: "2026-06-03T09:30:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluencePageApprovalV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ConfluencePageApprovalV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same null defaults (revoked_at / revoked_by) when omitted", async () => {
    const payload = {
      approval_id: "aaaaaaaa-1111-2222-3333-444455556666",
      space_key: "ENG",
      page_id: "123456",
      approver_email: "admin@example.com",
      approved_at_utc: "2026-06-03T10:00:00.500000+00:00",
      approval_artifact_url: "https://example.com/",
      scope_justification: "short justification ok here",
      default_scope: "language_only",
      created_at: "2026-06-03T09:00:00+00:00",
      updated_at: "2026-06-03T09:30:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluencePageApprovalV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ConfluencePageApprovalV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a malformed approval_id (not a UUID)", async () => {
    const bad = {
      approval_id: "not-a-uuid",
      space_key: "ENG",
      page_id: "123456",
      approver_email: "admin@example.com",
      approved_at_utc: "2026-06-03T10:00:00+00:00",
      approval_artifact_url: "https://example.com/",
      scope_justification: "x".repeat(20),
      default_scope: "universal",
      created_at: "2026-06-03T09:00:00+00:00",
      updated_at: "2026-06-03T09:30:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluencePageApprovalV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ConfluencePageApprovalV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      approval_id: "1a2b3c4d-1111-2222-3333-444455556666",
      space_key: "ENG",
      page_id: "123456",
      approver_email: "admin@example.com",
      approved_at_utc: "2026-06-03T10:00:00+00:00",
      approval_artifact_url: "https://example.com/",
      scope_justification: "x".repeat(20),
      default_scope: "universal",
      created_at: "2026-06-03T09:00:00+00:00",
      updated_at: "2026-06-03T09:30:00+00:00",
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluencePageApprovalV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ConfluencePageApprovalV1.parse(bad)).toThrow();
  }, 30_000);
});
