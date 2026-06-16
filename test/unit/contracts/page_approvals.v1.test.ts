/**
 * Unit tests for the page-approval read envelopes (Option C, Phase 2).
 *
 * Phase 2 adds two label-free derived fields the SPA renders the lifecycle chip from:
 *   - PageWithApprovalV1.ingest_status: 'ingested' | 'not_ingested' (from non-deleted chunks).
 *   - PagesListPageV1.live_list_available: boolean (false → the live read failed; stored fallback).
 * approval_status keeps its three values INCLUDING 'revoked' (D10 lifecycle).
 */

import { describe, expect, it } from "vitest";

import {
  PageApprovalStatusV1,
  PageWithApprovalV1,
  PagesListPageV1,
} from "#contracts/admin.v1.js";

const BASE_ROW = {
  space_key: "SEP",
  page_id: "196626",
  page_title: "Default Page",
  page_version: 4,
  labels: ["default"],
  last_modified_at: "2026-06-10T00:00:00Z",
  ingest_status: "not_ingested" as const,
  approval_status: "none" as const,
};

describe("PageWithApprovalV1 — ingest_status (Phase 2)", () => {
  it("accepts a not_ingested + none row (the SEP-196626 deadlock case)", () => {
    const parsed = PageWithApprovalV1.parse(BASE_ROW);
    expect(parsed.ingest_status).toBe("not_ingested");
    expect(parsed.approval_status).toBe("none");
  });

  it("accepts ingested + approved", () => {
    const parsed = PageWithApprovalV1.parse({
      ...BASE_ROW,
      ingest_status: "ingested",
      approval_status: "approved",
      approver_email: "op@example.com",
      approved_at_utc: "2026-06-10T01:00:00Z",
    });
    expect(parsed.ingest_status).toBe("ingested");
  });

  it("requires ingest_status (no silent default — the producer always sets it)", () => {
    const { ingest_status: _omit, ...withoutIngest } = BASE_ROW;
    expect(() => PageWithApprovalV1.parse(withoutIngest)).toThrow();
  });

  it("rejects an unknown ingest_status value", () => {
    expect(() => PageWithApprovalV1.parse({ ...BASE_ROW, ingest_status: "pending" })).toThrow();
  });

  it("rejects unknown keys (still strict)", () => {
    expect(() => PageWithApprovalV1.parse({ ...BASE_ROW, surprise: 1 })).toThrow();
  });
});

describe("PageApprovalStatusV1 — keeps 'revoked' (D10 lifecycle)", () => {
  it("approved | revoked | none are all representable", () => {
    expect(PageApprovalStatusV1.parse("approved")).toBe("approved");
    expect(PageApprovalStatusV1.parse("revoked")).toBe("revoked");
    expect(PageApprovalStatusV1.parse("none")).toBe("none");
  });

  it("a revoked row round-trips through PageWithApprovalV1", () => {
    const parsed = PageWithApprovalV1.parse({
      ...BASE_ROW,
      ingest_status: "ingested",
      approval_status: "revoked",
      revoked_at: "2026-06-11T00:00:00Z",
      revoked_by: "op@example.com",
    });
    expect(parsed.approval_status).toBe("revoked");
  });
});

describe("PagesListPageV1 — live_list_available (Phase 2)", () => {
  it("carries live_list_available alongside rows + cursor", () => {
    const parsed = PagesListPageV1.parse({
      rows: [PageWithApprovalV1.parse(BASE_ROW)],
      next_cursor: "live:opaque",
      live_list_available: true,
    });
    expect(parsed.live_list_available).toBe(true);
    expect(parsed.rows).toHaveLength(1);
  });

  it("represents the degraded (stored-fallback) view", () => {
    const parsed = PagesListPageV1.parse({
      rows: [],
      next_cursor: "stored:50",
      live_list_available: false,
    });
    expect(parsed.live_list_available).toBe(false);
  });

  it("requires live_list_available (the handler always sets it)", () => {
    expect(() => PagesListPageV1.parse({ rows: [], next_cursor: null })).toThrow();
  });
});
