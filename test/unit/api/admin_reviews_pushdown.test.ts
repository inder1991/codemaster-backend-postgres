// W2.7 / EH10 — the reviews list must NOT aggregate core.review_findings over the entire matching
// set on every request. The per-PR finding_count/severity aggregate is constrained to the rows of
// the CURRENT page (LEFT JOIN LATERAL applied AFTER the LIMIT/OFFSET), and the route caps `page`
// so the OFFSET scan-discard cost is bounded. `total` (a locked wire field) stays exact via the
// windowed count over the SLIM pull_request_reviews query — findings never join into it.

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { searchReviews } from "#backend/api/admin/admin_read_repo.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { recordingKysely } from "./_recording_kysely.js";

const INST = "3a3a3a3a-1111-2222-3333-444444444444";
const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");

function reviewRow(id: string) {
  return {
    review_id: id,
    repo: "acme/widgets",
    pr_number: 7,
    pr_title: "PR #7",
    state: "queued",
    severity_max: null,
    finding_count: 0,
    started_at: NOW,
    completed_at: null,
    total_count: 1,
  };
}

describe("W2.7/EH10 searchReviews pushdown", () => {
  it("scopes the review_findings aggregate to the page: LATERAL join AFTER the LIMIT", async () => {
    const { db, queries } = recordingKysely([
      [reviewRow("d5d5d5d5-1111-2222-3333-444444444444")],
    ]);
    await searchReviews(db, { installationId: INST, page: 1, size: 50 });
    expect(queries).toHaveLength(1);
    const text = queries[0]!.sql;
    expect(text).toMatch(/left join lateral/i);
    // The findings table must be referenced only AFTER pagination (inside the per-page lateral),
    // never in a pre-LIMIT full-set aggregate.
    const findingsAt = text.toLowerCase().indexOf("core.review_findings");
    const limitAt = text.toLowerCase().indexOf("limit");
    expect(findingsAt).toBeGreaterThan(-1);
    expect(limitAt).toBeGreaterThan(-1);
    expect(findingsAt).toBeGreaterThan(limitAt);
  });

  it("keeps the tenancy filter on both the page query and the lateral aggregate", async () => {
    const { db, queries } = recordingKysely([[]]);
    await searchReviews(db, { installationId: INST, page: 1, size: 50 });
    const text = queries[0]!.sql;
    const occurrences = text.match(/installation_id/gi) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    expect(queries[0]!.parameters).toContain(INST);
  });

  it("route: page above the cap → 422 without touching the database", async () => {
    const { db, queries } = recordingKysely([[]]);
    const app = buildApp({});
    await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
    await app.ready();
    const cookie = issueCookie({
      user_id: "00000000-0000-0000-0000-0000000000aa",
      email: "u@x",
      role: "platform_operator",
      auth_source: "core_local",
      ldap_groups: [],
      now: NOW,
      signing_key: SIGNING_KEY,
      installation_id: INST,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/reviews?page=501",
      cookies: { [SESSION_COOKIE_NAME]: cookie },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/page/i);
    expect(queries).toHaveLength(0);
    await app.close();
  });

  it("route: the page cap boundary itself (500) is still served", async () => {
    const { db } = recordingKysely([[]]);
    const app = buildApp({});
    await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
    await app.ready();
    const cookie = issueCookie({
      user_id: "00000000-0000-0000-0000-0000000000aa",
      email: "u@x",
      role: "platform_operator",
      auth_source: "core_local",
      ldap_groups: [],
      now: NOW,
      signing_key: SIGNING_KEY,
      installation_id: INST,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/reviews?page=500",
      cookies: { [SESSION_COOKIE_NAME]: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ page: number }>().page).toBe(500);
    await app.close();
  });
});
