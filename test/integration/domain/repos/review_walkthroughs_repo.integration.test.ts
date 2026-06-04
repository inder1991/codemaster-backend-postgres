import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import {
  ReviewWalkthroughsRepo,
  closeReviewWalkthroughsDb,
} from "#backend/domain/repos/review_walkthroughs_repo.js";

import type { WalkthroughV1 } from "#contracts/walkthrough.v1.js";

import { describeDb, INTEGRATION_DSN } from "../../_db.js";

// DB-gated integration test against the DISPOSABLE Postgres (migrations applied; core.review_walkthroughs
// present). Runs ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so
// validate-fast stays green without a DB. We NEVER touch any other DB. Each test uses a UNIQUE
// installation_id + review_id so rows never collide, and cleans up its own rows in `finally`.

let repo: ReviewWalkthroughsRepo;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  // ADR-0062: the repo memoizes ONE Pool + ONE Kysely for the whole process (TenancyPlugin installed).
  repo = new ReviewWalkthroughsRepo({ dsn: INTEGRATION_DSN });
});

afterAll(async () => {
  await closeReviewWalkthroughsDb();
});

/** A minimal-but-complete WalkthroughV1 with every optional left to its default. */
function minimalWalkthrough(): WalkthroughV1 {
  return {
    schema_version: 1,
    tldr: "Tidies up the request handler.",
    file_rows: [],
    configuration_section_md: "",
    degradation_note: null,
    truncated: false,
    suggested_reviewers: [],
    linked_issues: [],
    sanitization_event: null,
  };
}

/** A maximal WalkthroughV1 exercising every nested array + the sanitization_event sub-contract,
 *  so the JSONB column must round-trip byte-faithfully. */
function richWalkthrough(installationId: string): WalkthroughV1 {
  return {
    schema_version: 2, // bare int, not Literal — must survive the round-trip
    tldr: "Refactors the handler and links the tracking issue.",
    file_rows: [
      {
        path: "src/app.py",
        change_summary: "refactored the request handler",
        severity_max: "issue",
        finding_count: 3,
      },
      {
        path: "src/util/helpers.py",
        change_summary: "extracted a pure helper",
        severity_max: "nit",
        finding_count: 0,
      },
    ],
    configuration_section_md: "## Config\n- `max_tokens` raised to 4096",
    degradation_note: "one chunk was truncated",
    truncated: true,
    suggested_reviewers: ["octocat", "hubot"],
    linked_issues: [
      { issue_number: 42, linkage_kind: "closes", title: "Null deref", state: "open" },
      { issue_number: 7, linkage_kind: "mentioned", title: null, state: null },
    ],
    sanitization_event: {
      schema_version: 1,
      installation_id: installationId,
      request_id: randomUUID(),
      original_text: "leaked AKIA-style secret in preamble",
      redacted_text: "[redacted]",
      spans_redacted: 2,
      detector_kinds: ["aws_key", "generic_secret"],
      stage: "walkthrough",
    },
  };
}

/** Delete the walkthrough row a test created (cross-tenant cleanup via raw pg through the repo). */
async function cleanup(reviewId: string): Promise<void> {
  await repo.deleteForTest({ reviewId });
}

describeDb("ReviewWalkthroughsRepo (integration, disposable PG)", () => {
  it("upsert then get round-trips a minimal walkthrough faithfully", async () => {
    const installationId = randomUUID();
    const reviewId = randomUUID();
    try {
      const wt = minimalWalkthrough();
      await repo.upsert({ reviewId, installationId, walkthrough: wt });

      const row = await repo.get({ reviewId, installationId });
      expect(row).not.toBeNull();
      expect(row?.review_id).toBe(reviewId);
      expect(row?.installation_id).toBe(installationId);
      expect(row?.walkthrough).toEqual(wt);
    } finally {
      await cleanup(reviewId);
    }
  });

  it("upsert then get round-trips a rich walkthrough byte-faithfully (nested arrays + sanitization_event JSONB)", async () => {
    const installationId = randomUUID();
    const reviewId = randomUUID();
    try {
      const wt = richWalkthrough(installationId);
      await repo.upsert({ reviewId, installationId, walkthrough: wt });

      const row = await repo.get({ reviewId, installationId });
      expect(row).not.toBeNull();
      // Deep-equal the entire JSONB payload — every nested field must survive the JSONB ::text read-cast.
      expect(row?.walkthrough).toEqual(wt);
      // schema_version=2 (a bare int, not a Literal) must survive.
      expect(row?.walkthrough.schema_version).toBe(2);
      expect(row?.walkthrough.sanitization_event?.detector_kinds).toEqual([
        "aws_key",
        "generic_secret",
      ]);
    } finally {
      await cleanup(reviewId);
    }
  });

  it("get returns null when the review has no walkthrough", async () => {
    const installationId = randomUUID();
    const reviewId = randomUUID();
    const row = await repo.get({ reviewId, installationId });
    expect(row).toBeNull();
  });

  it("upsert is idempotent on review_id — the second upsert UPDATEs in place (no duplicate row)", async () => {
    const installationId = randomUUID();
    const reviewId = randomUUID();
    try {
      const first = minimalWalkthrough();
      await repo.upsert({ reviewId, installationId, walkthrough: first });

      const second: WalkthroughV1 = { ...minimalWalkthrough(), tldr: "Now with a new summary." };
      await repo.upsert({ reviewId, installationId, walkthrough: second });

      const row = await repo.get({ reviewId, installationId });
      expect(row?.walkthrough.tldr).toBe("Now with a new summary.");

      // Exactly one row exists for this review_id.
      const count = await repo.countForTest({ reviewId });
      expect(count).toBe(1);
    } finally {
      await cleanup(reviewId);
    }
  });

  it("ON CONFLICT migrates installation_id when the same review is re-upserted under a different tenant", async () => {
    // Mirrors the Python ON CONFLICT (review_id) DO UPDATE SET installation_id = EXCLUDED.installation_id.
    const reviewId = randomUUID();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    try {
      await repo.upsert({ reviewId, installationId: tenantA, walkthrough: minimalWalkthrough() });
      await repo.upsert({ reviewId, installationId: tenantB, walkthrough: minimalWalkthrough() });

      // The row now belongs to tenant B.
      expect(await repo.get({ reviewId, installationId: tenantB })).not.toBeNull();
      // And is NO LONGER visible to tenant A.
      expect(await repo.get({ reviewId, installationId: tenantA })).toBeNull();
    } finally {
      await cleanup(reviewId);
    }
  });

  it("tenant isolation — a get scoped to tenant A does not see tenant B's row", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const reviewA = randomUUID();
    const reviewB = randomUUID();
    try {
      await repo.upsert({ reviewId: reviewA, installationId: tenantA, walkthrough: minimalWalkthrough() });
      await repo.upsert({ reviewId: reviewB, installationId: tenantB, walkthrough: minimalWalkthrough() });

      // A sees only its own row.
      expect(await repo.get({ reviewId: reviewA, installationId: tenantA })).not.toBeNull();
      // A's review_id queried under tenant A is fine; B's review_id queried under tenant A is invisible.
      expect(await repo.get({ reviewId: reviewB, installationId: tenantA })).toBeNull();
      // And cross-querying A's review under tenant B is invisible.
      expect(await repo.get({ reviewId: reviewA, installationId: tenantB })).toBeNull();
    } finally {
      await cleanup(reviewA);
      await cleanup(reviewB);
    }
  });
});
