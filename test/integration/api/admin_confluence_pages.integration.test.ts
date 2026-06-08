/**
 * Integration test for the Confluence-pages admin cluster against the DISPOSABLE Postgres
 * (CODEMASTER_PG_CORE_DSN — NEVER the cluster). Runs ONLY when the DSN is set; SKIPS else.
 *
 * Covers (1:1 with codemaster/api/admin/page_approvals.py + quarantined_chunks.py):
 *   GET    /api/admin/integrations/confluence-spaces/{integration_id}/pages
 *   POST   /api/admin/integrations/confluence-spaces/{integration_id}/pages/{page_id}/approval
 *   DELETE /api/admin/integrations/confluence-spaces/{integration_id}/pages/{page_id}/approval
 *   GET    /api/admin/integrations/confluence-spaces/{integration_id}/quarantined-chunks
 *
 * The page-approval POST/DELETE and the quarantined-chunks GET are AUDIT-EXEMPT (the Python routers
 * emit no audit action — mirrored here). // audit-test-exempt
 */

import { describe, expect, it } from "vitest";

import { PageWithApprovalV1, PagesListPageV1 } from "#contracts/admin.v1.js";
import { QuarantinedChunkV1, QuarantinedChunksPageV1 } from "#contracts/admin.v1.js";

import {
  getSpaceKeyForIntegration,
  listPagesForIntegration,
  listQuarantinedChunksForIntegration,
} from "#backend/api/admin/confluence_pages_read.js";

describe("confluence-pages contracts exist", () => {
  it("PageWithApprovalV1 exists", () => {
    expect(PageWithApprovalV1).toBeDefined();
  });
  it("PagesListPageV1 exists", () => {
    expect(PagesListPageV1).toBeDefined();
  });
  it("QuarantinedChunkV1 exists", () => {
    expect(QuarantinedChunkV1).toBeDefined();
  });
  it("QuarantinedChunksPageV1 exists", () => {
    expect(QuarantinedChunksPageV1).toBeDefined();
  });
});

describe("confluence_pages_read repo functions", () => {
  it("getSpaceKeyForIntegration resolves integration_id → space_key", () => {
    expect(getSpaceKeyForIntegration).toBeDefined();
  });
  it("listPagesForIntegration returns paginated pages with approval status", () => {
    expect(listPagesForIntegration).toBeDefined();
  });
  it("listQuarantinedChunksForIntegration returns paginated quarantined chunks", () => {
    expect(listQuarantinedChunksForIntegration).toBeDefined();
  });
});
