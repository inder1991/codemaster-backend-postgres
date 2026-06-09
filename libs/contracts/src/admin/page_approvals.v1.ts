import { z } from "zod";

// Zod port of contracts/admin/page_approvals/v1.py — read envelope for the paginated page list.
// The page-approval row shape (create/read) is in ../page_approval.v1.ts (Sub-spec 0); this module adds
// the per-space page-list envelope the admin UI renders.
//
// Field parity notes (1:1 with the Python BaseModel, ConfigDict(extra="forbid") → .strict()):
//   - schema_version is a PLAIN `int = 1` → z.number().int().default(1).
//   - approver_email / revoked_by: EmailStr | None → z.string().email().nullable().default(null).
//   - last_modified_at / approved_at_utc / revoked_at are PLAIN `datetime` (no _require_tz) → the
//     offset+local-permissive datetime guard (accepts both Z/±offset and naive forms the DB emits).

export const PageApprovalStatusV1 = z.enum(["approved", "revoked", "none"]);
export type PageApprovalStatusV1 = z.infer<typeof PageApprovalStatusV1>;

/**
 * One Confluence page in a space, with its current approval state.
 *
 * page_title + page_version come from the most-recent active chunk in core.confluence_chunks.
 *
 * approval_status:
 *   - "approved" — a row exists in confluence_page_approvals with revoked_at IS NULL.
 *   - "revoked" — a row exists but revoked_at IS NOT NULL.
 *   - "none" — no row in confluence_page_approvals for this page.
 */
export const PageWithApprovalV1 = z
  .object({
    schema_version: z.number().int().default(1),
    space_key: z.string(),
    page_id: z.string(),
    page_title: z.string(),
    page_version: z.number().int().min(1),
    labels: z.array(z.string()).max(100).default([]),
    last_modified_at: z.string().datetime({ offset: true, local: true }),
    approval_status: PageApprovalStatusV1,
    approver_email: z.string().email().nullable().default(null),
    approved_at_utc: z.string().datetime({ offset: true, local: true }).nullable().default(null),
    revoked_at: z.string().datetime({ offset: true, local: true }).nullable().default(null),
    revoked_by: z.string().email().nullable().default(null),
  })
  .strict();
export type PageWithApprovalV1 = z.infer<typeof PageWithApprovalV1>;

/** Paginated envelope for the list endpoint. */
export const PagesListPageV1 = z
  .object({
    schema_version: z.number().int().default(1),
    rows: z.array(PageWithApprovalV1),
    next_cursor: z.string().max(512).nullable().default(null),
  })
  .strict();
export type PagesListPageV1 = z.infer<typeof PagesListPageV1>;
