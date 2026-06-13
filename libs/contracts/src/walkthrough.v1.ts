import { z } from "zod";

import { OutputSafetySanitizationEventV1 } from "./review_chunk_response.v1.js";

// Zod port of the walkthrough contract package. Parity-validated in
// walkthrough.v1.parity.test.ts.
//
// The package spans TWO Python modules (versioned together — pr_meta_v1 has no standalone
// schema_version because callers construct it inline alongside the Sprint-8 contracts):
//   - contracts/walkthrough/v1.py        → Severity, FileRowV1, LinkedIssueV1, WalkthroughV1
//   - contracts/walkthrough/pr_meta_v1.py → PrMetaV1
//
// Source models / enums / constants ported (every public one):
//  - Severity        (Python Literal)                  → z.enum.
//  - FileRowV1       (ConfigDict extra=forbid, frozen) → .strict().
//  - LinkedIssueV1   (ConfigDict extra=forbid, frozen) → .strict(); linkage_kind + state are Literals.
//  - WalkthroughV1   (ConfigDict extra=forbid, frozen) → .strict(); sanitization_event references the
//      sibling Zod schema OutputSafetySanitizationEventV1 — IMPORTED above, not redefined.
//  - PrMetaV1        (ConfigDict extra=forbid, frozen) → .strict().
//
// schema_version GOTCHA: WalkthroughV1.schema_version is a bare Python `int = 1` (NOT Literal) →
// z.number().int().default(1) (any int accepted, default 1; verified empirically — `schema_version=2`
// constructs in Python). PrMetaV1 has NO schema_version field (versioned with the parent).
//
// UUID GOTCHA: PrMetaV1.pr_id / installation_id are Pydantic uuid.UUID — model_dump(mode="json") emits
// the lowercase canonical form, matched by the Zod .transform(toLowerCase). datetime opened_at is
// AUTO-handled by both canonicalizers (RFC3339 → .ffffff+00:00), so a valid RFC3339 string round-trips.

// Severity = Literal["nit", "suggestion", "issue", "blocker"]
export const Severity = z.enum(["nit", "suggestion", "issue", "blocker"]);
export type Severity = z.infer<typeof Severity>;

// FileRowV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// One row of the per-file table in the walkthrough.
export const FileRowV1 = z
  .object({
    path: z.string().min(1),
    change_summary: z.string().min(1).max(300),
    severity_max: Severity,
    finding_count: z.number().int().gte(0),
  })
  .strict();
export type FileRowV1 = z.infer<typeof FileRowV1>;

// LinkageKind = Literal["closes", "fixes", "resolves", "mentioned"]
export const LinkageKind = z.enum(["closes", "fixes", "resolves", "mentioned"]);
export type LinkageKind = z.infer<typeof LinkageKind>;

// IssueState = Literal["open", "closed"] (LinkedIssueV1.state is this Literal | None).
export const IssueState = z.enum(["open", "closed"]);
export type IssueState = z.infer<typeof IssueState>;

// LinkedIssueV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// title is `str | None = Field(default=None, max_length=500)` → .max(500).nullable().default(null).
// state is `Literal["open", "closed"] | None = None` → IssueState.nullable().default(null).
export const LinkedIssueV1 = z
  .object({
    issue_number: z.number().int().gte(1).lte(999_999_999),
    linkage_kind: LinkageKind,
    title: z.string().max(500).nullable().default(null),
    state: IssueState.nullable().default(null),
  })
  .strict();
export type LinkedIssueV1 = z.infer<typeof LinkedIssueV1>;

// WalkthroughV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// schema_version is a bare Python `int = 1` (NOT Literal) → z.number().int().default(1).
// file_rows / suggested_reviewers / linked_issues are `tuple[..., ...] = default_factory=tuple` →
// z.array(...).default([]) (with the same max_length bounds where present).
// degradation_note is `str | None = None` → .nullable().default(null).
// sanitization_event is `OutputSafetySanitizationEventV1 | None = None` → .nullable().default(null).
export const WalkthroughV1 = z
  .object({
    schema_version: z.number().int().default(1),
    tldr: z.string().min(1).max(500),
    file_rows: z.array(FileRowV1).default([]),
    configuration_section_md: z.string().max(2000).default(""),
    degradation_note: z.string().nullable().default(null),
    truncated: z.boolean().default(false),
    suggested_reviewers: z.array(z.string()).max(10).default([]),
    linked_issues: z.array(LinkedIssueV1).max(20).default([]),
    sanitization_event: OutputSafetySanitizationEventV1.nullable().default(null),
  })
  .strict();
export type WalkthroughV1 = z.infer<typeof WalkthroughV1>;

// PrMetaV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// PR-level metadata for the walkthrough activity input. No schema_version (versioned with the parent).
// pr_id / installation_id are Pydantic uuid.UUID → .uuid().transform(toLowerCase) (Pydantic lowercases
// on dump). pr_title has max_length=500 with NO min_length (empty title accepted). The S22.DM.12
// enrichment fields are additive optionals (default-None / default-False).
export const PrMetaV1 = z
  .object({
    pr_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    installation_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    repo: z.string().min(1).max(200),
    pr_title: z.string().max(500),
    pr_description: z.string().max(10_000),
    author_login: z.string().max(64).nullable().default(null),
    draft: z.boolean().default(false),
    base_ref: z.string().max(255).nullable().default(null),
    head_ref: z.string().max(255).nullable().default(null),
    // datetime | None = None — AUTO-handled by the canonicalizer (RFC3339 → .ffffff+00:00).
    opened_at: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();
export type PrMetaV1 = z.infer<typeof PrMetaV1>;
