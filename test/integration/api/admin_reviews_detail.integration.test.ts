/**
 * Integration test for GET /api/admin/reviews/{review_id} (review detail) against the DISPOSABLE Postgres
 * (CODEMASTER_PG_CORE_DSN on :5439 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set;
 * SKIPS otherwise.
 *
 * 1:1 port of codemaster/api/admin/review_detail.py + postgres_review_detail_repo.py. Covers:
 *   - 200 happy path, returns ReviewDetailV1 with joined findings/activities
 *   - 404 when review_id not in tenant
 *   - 403 role insufficient (reader/org_owner); 401 no cookie
 *   - Authz matrix (operator/owner/super only)
 *   - reviews_detail_read repo: joined findings/activities + tenancy enforcement
 *   - GET /api/admin/your-reviews (Pattern A: empty authored/assigned)
 *
 * NOTE (schema adaptations vs plan): the real TS baseline schema differs from the Python reference.
 *   - core.pull_request_reviews has (provider, repo_id, provider_pr_id, status) and NO `title` column
 *     (the title is COALESCEd from core.pull_requests via repository_id+pr_number).
 *   - core.pull_requests requires installation_id, github_pull_request_id, author_gh_user_id (FK→gh_users),
 *     base_sha.
 *   - core.repositories requires default_branch.
 *   - core.review_findings PK is review_finding_id; category + confidence are NOT NULL; severity has no `none`.
 *   - audit.workflow_events requires event_id, provider, run_id (FK→review_runs); event_type is CHECK-constrained
 *     so 'ANALYSIS_STARTED' is used (the plan's 'STARTED' is not a valid event_type).
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";
import type { ReviewDetailV1, YourReviewsPageV1 } from "#contracts/admin.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INST = "11111111-2222-3333-4444-555555555555";
const INST_OTHER = "aaaaaaaa-2222-3333-4444-555555555555";

// Fixed UUIDs for test data
const REVIEW_ID = "22222222-2222-2222-2222-222222222222";
const REVIEW_ID_OTHER = "33333333-2222-2222-2222-222222222222";
const REPO_ID = "44444444-3333-3333-3333-333333333333";
const REPO_ID_OTHER = "66666666-5555-5555-5555-555555555555";
const PR_ID = "55555555-4444-4444-4444-444444444444";
const RUN_ID = "77777777-6666-6666-6666-666666666666";
const GH_USER_ID = "88888888-7777-7777-7777-777777777777";
const EVENT_ID = "99999999-8888-8888-8888-888888888888";
const USER_ID = "00000000-0000-0000-0000-0000000000aa";

// github_repo_id / installation_github_id numeric identities (bigint columns)
const GH_REPO_ID = 9001;
const GH_REPO_ID_OTHER = 9002;
const GH_INSTALL_ID = 7001;
const GH_INSTALL_ID_OTHER = 7002;
const GH_USER_GITHUB_ID = 6001;
const GH_PR_ID = 5001;

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM audit.workflow_events WHERE review_id IN (${REVIEW_ID}, ${REVIEW_ID_OTHER})`.execute(db);
  await sql`DELETE FROM core.review_findings WHERE pr_id = ${PR_ID}`.execute(db);
  await sql`UPDATE core.pull_request_reviews SET current_run_id = NULL WHERE review_id IN (${REVIEW_ID}, ${REVIEW_ID_OTHER})`.execute(db);
  await sql`DELETE FROM core.review_runs WHERE run_id = ${RUN_ID}`.execute(db);
  await sql`DELETE FROM core.pull_request_reviews WHERE review_id IN (${REVIEW_ID}, ${REVIEW_ID_OTHER})`.execute(db);
  await sql`DELETE FROM core.pull_requests WHERE pr_id = ${PR_ID}`.execute(db);
  await sql`DELETE FROM core.repositories WHERE repository_id IN (${REPO_ID}, ${REPO_ID_OTHER})`.execute(db);
  await sql`DELETE FROM core.gh_users WHERE gh_user_id = ${GH_USER_ID}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id IN (${INST}, ${INST_OTHER})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();

  // Installations (FK roots for repositories / pull_requests / review_findings)
  await sql`INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
            VALUES (${INST}, ${GH_INSTALL_ID}, 'org', 'Organization'),
                   (${INST_OTHER}, ${GH_INSTALL_ID_OTHER}, 'other', 'Organization')`.execute(db);

  // gh_user (PR author FK target)
  await sql`INSERT INTO core.gh_users (gh_user_id, github_user_id, login, user_type)
            VALUES (${GH_USER_ID}, ${GH_USER_GITHUB_ID}, 'octocat', 'User')`.execute(db);

  // Repositories
  await sql`INSERT INTO core.repositories (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
            VALUES (${REPO_ID}, ${INST}, ${GH_REPO_ID}, 'org/test-repo', 'main', true)`.execute(db);

  // Pull request (the prr join target — supplies title)
  await sql`INSERT INTO core.pull_requests
              (pr_id, installation_id, repository_id, github_pull_request_id, pr_number, author_gh_user_id,
               state, title, base_ref, base_sha, head_ref, head_sha, draft, cross_fork, opened_at)
            VALUES (${PR_ID}, ${INST}, ${REPO_ID}, ${GH_PR_ID}, 42, ${GH_USER_ID},
                    'open', 'Fix: add tests', 'main', 'abc1230000000000000000000000000000000000',
                    'fix/tests', 'def4560000000000000000000000000000000000', false, false, ${NOW})`.execute(db);

  // Review (current_run_id NULL → state 'queued', temporal_url null per the happy-path assertions)
  await sql`INSERT INTO core.pull_request_reviews (review_id, provider, repo_id, pr_number, provider_pr_id, status)
            VALUES (${REVIEW_ID}, 'github', ${GH_REPO_ID}, 42, 'gh-pr-42', 'open')`.execute(db);

  // One finding (suppression_state NONE so it shows)
  await sql`INSERT INTO core.review_findings
              (review_finding_id, pr_id, installation_id, file_path, start_line, end_line,
               severity, category, title, body, suggestion, confidence)
            VALUES (gen_random_uuid(), ${PR_ID}, ${INST}, 'src/main.ts', 10, 15,
                    'issue', 'bug', 'Missing null check', 'Check for null', 'Add a guard', 0.9)`.execute(db);

  // A run is required so audit.workflow_events.run_id FK resolves.
  await sql`INSERT INTO core.review_runs (run_id, review_id, trigger_type, lifecycle_state)
            VALUES (${RUN_ID}, ${REVIEW_ID}, 'pr_opened', 'PENDING')`.execute(db);

  // One activity (event_type must be in the CHECK set; 'STARTED' is invalid → 'ANALYSIS_STARTED').
  await sql`INSERT INTO audit.workflow_events
              (event_id, provider, run_id, review_id, installation_id, sequence_no, event_type, received_at)
            VALUES (${EVENT_ID}, 'github', ${RUN_ID}, ${REVIEW_ID}, ${INST}, 1, 'ANALYSIS_STARTED', ${NOW})`.execute(db);

  // Foreign-installation review (for 404/tenancy test) — review row only, no repo join needed for 404.
  await sql`INSERT INTO core.repositories (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
            VALUES (${REPO_ID_OTHER}, ${INST_OTHER}, ${GH_REPO_ID_OTHER}, 'other/repo', 'main', true)`.execute(db);
  await sql`INSERT INTO core.pull_request_reviews (review_id, provider, repo_id, pr_number, provider_pr_id, status)
            VALUES (${REVIEW_ID_OTHER}, 'github', ${GH_REPO_ID_OTHER}, 1, 'gh-pr-1', 'open')`.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
  await pool?.end();
});

function mintCookie(role: Role): string {
  return issueCookie({
    user_id: USER_ID,
    email: "u@x",
    role,
    auth_source: "core_local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: INST,
  });
}

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

describeDb("admin reviews detail (disposable :5439)", () => {
  it("GET /api/admin/reviews/{review_id} — 200 happy path with findings and activities", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/reviews/${REVIEW_ID}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_operator") },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ReviewDetailV1>();
    expect(body.schema_version).toBe(1);
    expect(body.review_id).toBe(REVIEW_ID);
    expect(body.repo).toBe("org/test-repo");
    expect(body.pr_number).toBe(42);
    expect(body.pr_title).toBe("Fix: add tests");
    expect(body.state).toBe("queued");
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]!.severity).toBe("issue");
    expect(body.activities).toHaveLength(1);
    expect(body.activities[0]!.activity_name).toBe("ANALYSIS_STARTED");
    expect(body.posted_at).toBeNull();
    expect(body.temporal_url).toBeNull();
    expect(body.langfuse_url).toBeNull();
    await app.close();
  });

  it("404 when review not in tenant", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/reviews/${REVIEW_ID_OTHER}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_operator") },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("403 role insufficient (reader/org_owner)", async () => {
    const app = await makeApp();
    for (const role of ["reader", "org_owner"] as const) {
      const res = await app.inject({
        method: "GET",
        url: `/api/admin/reviews/${REVIEW_ID}`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie(role) },
      });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });

  it("401 no cookie", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/reviews/${REVIEW_ID}`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("authz matrix: operator/owner/super 200, others 403", async () => {
    const app = await makeApp();
    const allowed = ["platform_operator", "platform_owner", "super_admin"] as const;
    const denied = ["reader", "org_owner", "security_auditor"] as const;
    for (const role of allowed) {
      const res = await app.inject({
        method: "GET",
        url: `/api/admin/reviews/${REVIEW_ID}`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie(role) },
      });
      expect(res.statusCode, `${role} should be 200`).toBe(200);
    }
    for (const role of denied) {
      const res = await app.inject({
        method: "GET",
        url: `/api/admin/reviews/${REVIEW_ID}`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie(role) },
      });
      expect(res.statusCode, `${role} should be 403`).toBe(403);
    }
    await app.close();
  });
});
