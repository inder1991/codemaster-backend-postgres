import { z } from "zod";

// Zod port of contracts/admin/page_approvals/v1.py — read envelope for the paginated page list.
// The page-approval row shape (create/read) is in ../page_approval.v1.ts (Sub-spec 0); this module adds
// the per-space page-list envelope the admin UI renders.
//
// Field parity notes (ConfigDict(extra="forbid") → .strict()):
//   - schema_version is a PLAIN `int = 1` → z.number().int().default(1).
//   - approver_email / revoked_by: EmailStr | None → z.string().email().nullable().default(null).
//   - last_modified_at / approved_at_utc / revoked_at are PLAIN `datetime` (no _require_tz) → the
//     offset+local-permissive datetime guard (accepts both Z/±offset and naive forms the DB emits).

export const PageApprovalStatusV1 = z.enum(["approved", "revoked", "none"]);
export type PageApprovalStatusV1 = z.infer<typeof PageApprovalStatusV1>;

/**
 * Storage state of a page (Option C, Phase 2 — D2). Decoupled from labels + approval:
 *   - "ingested" — ≥1 non-deleted row in core.confluence_chunks for this page.
 *   - "not_ingested" — no non-deleted chunks (a never-approved `default` page lives here — it is
 *     surfaced from LIVE Confluence so it is visible + approvable BEFORE ingest).
 * The SPA derives the lifecycle chip from the (ingest_status, approval_status) pair.
 */
export const PageIngestStatusV1 = z.enum(["ingested", "not_ingested"]);
export type PageIngestStatusV1 = z.infer<typeof PageIngestStatusV1>;

/**
 * One Confluence page in a space, with its storage + approval state.
 *
 * page_title + page_version come from the LIVE page summary (live branch) or the most-recent
 * non-deleted chunk in core.confluence_chunks (stored fallback).
 *
 * ingest_status (D2): "ingested" | "not_ingested" — from non-deleted core.confluence_chunks.
 *
 * approval_status (D10 — latest approval row per page):
 *   - "approved" — the latest row has revoked_at IS NULL.
 *   - "revoked" — the latest row has revoked_at IS NOT NULL.
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
    // Phase 2 (D2): label-free storage state. REQUIRED — the read handler always derives it (no silent
    // default that would hide the not_ingested deadlock case).
    ingest_status: PageIngestStatusV1,
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
    // Phase 2 (D3/D4): false when the live Confluence read failed/was unavailable and the rows came from
    // the stored query — the SPA renders a degrade note. REQUIRED — the handler always sets it.
    live_list_available: z.boolean(),
  })
  .strict();
export type PagesListPageV1 = z.infer<typeof PagesListPageV1>;
