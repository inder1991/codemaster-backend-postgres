import { z } from "zod";

// Zod port of contracts/confluence/page_approval/v1.py (frozen Python). Parity-validated in
// page_approval.v1.parity.test.ts.
//
// Source members ported (every public one in v1.py):
//   - DefaultScope                  (Python Literal)            → z.enum on the 5 scope strings
//   - _require_tz                   (module-level AfterValidator) → z.string().datetime({ offset: true })
//                                     on the two fields that carry it (rejects a naive / offset-less value)
//   - DefaultApprovalV1             (ConfigDict extra=forbid, frozen) → .strict()
//   - CreatePageApprovalRequestV1   (ConfigDict extra=forbid, frozen) → .strict()
//                                     (approver_email INTENTIONALLY ABSENT — session-derived, audit P0-1)
//   - ConfluencePageApprovalV1      (ConfigDict extra=forbid, frozen) → .strict()
//
// Field notes:
//   - schema_version is a PLAIN `int = 1` on every model (NOT `Literal[1]`), so any int validates —
//     z.number().int().default(1). (Verified: Pydantic accepts schema_version=7 and dumps 7.)
//   - approver_email / revoked_by: EmailStr → z.string().email(). Pydantic lowercases the email DOMAIN
//     on dump (local-part preserved); parity payloads supply fully-lowercase emails so Zod's
//     pass-through matches the canonical output.
//   - approval_artifact_url: HttpUrl → z.string().url(). Pydantic lowercases the host + appends a
//     trailing slash to a bare host on dump; parity payloads supply already-normalized URLs.
//   - approval_id: uuid.UUID → z.string().uuid(). Pydantic lowercases on dump; parity payloads use
//     lowercase UUIDs so Zod's pass-through matches.
//   - approved_at_utc on DefaultApprovalV1 / CreatePageApprovalRequestV1 carries the `_require_tz`
//     AfterValidator (must be timezone-aware) → z.string().datetime({ offset: true }) (rejects naive).
//   - approved_at_utc / created_at / updated_at on ConfluencePageApprovalV1 are PLAIN `datetime`
//     (NO _require_tz) → Pydantic accepts a naive value there; z.string().datetime({ offset: true,
//     local: true }) is as-permissive. Parity payloads still supply offset-bearing values so the
//     canonicalizer's Z↔+00:00 + fractional-precision normalization applies.
//   - revoked_at: datetime | None = None; revoked_by: EmailStr | None = None → .nullable().default(null).

// DefaultScope = Literal["universal", "security_only", "compliance_only", "framework_only", "language_only"]
export const DefaultScope = z.enum([
  "universal",
  "security_only",
  "compliance_only",
  "framework_only",
  "language_only",
]);
export type DefaultScope = z.infer<typeof DefaultScope>;

// DefaultApprovalV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// The shape stored in core.confluence_chunks.default_approval JSONB (mirrors the
// core.confluence_page_approvals source-of-truth row).
export const DefaultApprovalV1 = z
  .object({
    schema_version: z.number().int().default(1),
    approver_email: z.string().email(),
    // _require_tz AfterValidator: must be timezone-aware → reject a naive value.
    approved_at_utc: z.string().datetime({ offset: true }),
    approval_artifact_url: z.string().url(),
    scope_justification: z.string().min(20).max(2000),
    default_scope: DefaultScope,
  })
  .strict();
export type DefaultApprovalV1 = z.infer<typeof DefaultApprovalV1>;

// CreatePageApprovalRequestV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// Admin API POST body. SECURITY (audit P0-1, 2026-05-27): approver_email is INTENTIONALLY absent —
// derived from the authenticated session in the handler, never trusted from the request body.
export const CreatePageApprovalRequestV1 = z
  .object({
    schema_version: z.number().int().default(1),
    space_key: z.string().min(1).max(64),
    page_id: z.string().min(1).max(64),
    // approver_email INTENTIONALLY ABSENT — derived from session in handler.
    // _require_tz AfterValidator: must be timezone-aware → reject a naive value.
    approved_at_utc: z.string().datetime({ offset: true }),
    approval_artifact_url: z.string().url(),
    scope_justification: z.string().min(20).max(2000),
    default_scope: DefaultScope,
  })
  .strict();
export type CreatePageApprovalRequestV1 = z.infer<typeof CreatePageApprovalRequestV1>;

// ConfluencePageApprovalV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// Read shape returned from the admin API. Wraps the row + revocation state. NOTE: approved_at_utc /
// created_at / updated_at are PLAIN `datetime` here (no _require_tz), so a naive value is accepted
// (offset+local permissive); scope_justification carries NO min/max here (the create-side enforces it).
export const ConfluencePageApprovalV1 = z
  .object({
    schema_version: z.number().int().default(1),
    approval_id: z.string().uuid(),
    space_key: z.string(),
    page_id: z.string(),
    approver_email: z.string().email(),
    approved_at_utc: z.string().datetime({ offset: true, local: true }),
    approval_artifact_url: z.string().url(),
    scope_justification: z.string(),
    default_scope: DefaultScope,
    revoked_at: z.string().datetime({ offset: true, local: true }).nullable().default(null),
    revoked_by: z.string().email().nullable().default(null),
    created_at: z.string().datetime({ offset: true, local: true }),
    updated_at: z.string().datetime({ offset: true, local: true }),
  })
  .strict();
export type ConfluencePageApprovalV1 = z.infer<typeof ConfluencePageApprovalV1>;
