import { z } from "zod";

import { ConfluencePageV1 } from "./confluence_sync.v1.js";

// Zod port of contracts/integrations/confluence/v1.py (frozen Python — Sprint 13 / S13.3.1a). These
// are the WIRE shapes the read-only Confluence REST client (apps/backend/src/integrations/confluence/
// client.ts) returns. Parity-validated in confluence_wire.v1.parity.test.ts against the frozen Python
// (pyRef oracle, module `contracts.integrations.confluence.v1`).
//
// Every Python model carries the dunder marker `__contract_internal__ = True` (a class attribute, NOT
// a model field) so it never appears in model_dump(mode="json") — nothing to port on the wire. Every
// model is ConfigDict(extra="forbid", frozen=True) → .strict(). `schema_version` is a PLAIN Python
// `int` (default 1) — NOT a Literal — so a future schema_version bump is not false-rejected:
// z.number().int().default(1).
//
// REUSE NOTE (ConfluencePage): the frozen Python module ALSO defines `ConfluencePage` (schema v2,
// labels + status). That shape is byte-identical to the already-ported `ConfluencePageV1` in
// confluence_sync.v1.ts (the sync contracts inline the SAME `contracts.integrations.confluence.v1.
// ConfluencePage`). So we re-export `ConfluencePageV1` here rather than redefine it — the client's
// `get_page` returns this shape. The confluence_sync.v1.parity.test.ts already proves it byte-equal
// to the frozen Python `ConfluencePage`.
//
// DATETIME NOTE (last_modified_at): the frozen Python `ConfluenceSpace` has NO datetime; the page
// SUMMARY + PAGE carry `last_modified_at: datetime` as a PLAIN Pydantic datetime (no _require_tz) —
// the client's `_parse_dt` does `datetime.fromisoformat(raw)` which accepts BOTH a `Z` suffix and an
// explicit offset (and a naive value). So z.string().datetime({ offset: true, local: true }) mirrors
// the accept set — same as ConfluencePageV1.last_modified_at in confluence_sync.v1.ts.

// Re-export the wire page shape (identical to the frozen Python `ConfluencePage`).
export { ConfluencePageV1 };

// ─── ConfluenceSpace ──────────────────────────────────────────────────────────────────────────
// One Confluence space the service-account credentials can see. IDs are opaque numeric strings
// (Confluence convention) — bounded 1..64 like space_key. `name` is bounded 1..512.
export const ConfluenceSpaceV1 = z
  .object({
    schema_version: z.number().int().default(1),
    space_id: z.string().min(1).max(64),
    space_key: z.string().min(1).max(64),
    name: z.string().min(1).max(512),
  })
  .strict();
export type ConfluenceSpaceV1 = z.infer<typeof ConfluenceSpaceV1>;

// ─── ConfluencePageSummary ────────────────────────────────────────────────────────────────────
// A page-list entry. The full body comes from get_page; list responses ship metadata only so a
// 1000-page space doesn't require 1000 body downloads. last_modified_at is a PLAIN datetime.
export const ConfluencePageSummaryV1 = z
  .object({
    schema_version: z.number().int().default(1),
    page_id: z.string().min(1).max(64),
    space_key: z.string().min(1).max(64),
    title: z.string().min(1).max(1024),
    version: z.number().int().gte(1),
    last_modified_at: z.string().datetime({ offset: true, local: true }),
  })
  .strict();
export type ConfluencePageSummaryV1 = z.infer<typeof ConfluencePageSummaryV1>;

// ─── ConfluencePageList ───────────────────────────────────────────────────────────────────────
// Paginated page list. next_cursor is null when there's no more data; otherwise the caller passes it
// to ConfluenceClient.list_pages({ cursor }). items is a tuple[ConfluencePageSummary, ...] in Python.
export const ConfluencePageListV1 = z
  .object({
    schema_version: z.number().int().default(1),
    items: z.array(ConfluencePageSummaryV1),
    next_cursor: z.string().nullable().default(null),
  })
  .strict();
export type ConfluencePageListV1 = z.infer<typeof ConfluencePageListV1>;
