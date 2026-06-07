/**
 * Integration test for POST /api/admin/reviews/{review_id}/findings/{finding_id}/feedback against the
 * DISPOSABLE Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set.
 *
 * Seeds the full coherence graph (installation → gh_user → repository → pull_request → pull_request_reviews
 * → review_finding) and a key registry (raw_payload is AES-encrypted). Exercises the verb→kind collapse,
 * the encrypted write, the tenancy/coherence 404, and the role guard.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
// Isolated identifier namespace ("ff" UUIDs / 9961000xx ints) — provider_pr_id, github_repo_id,
// github_user_id, github_pull_request_id, github_installation_id and full_name all carry GLOBAL unique
// constraints, so any value shared with a sibling integration file collides under vitest's concurrent-file
// execution (the loser of the INSERT race throws in beforeAll → suite skipped). Every literal below is
// verified-unique across the whole test/ tree.
const INST = "b1ff0000-0000-0000-0000-000000000001";
const OTHER = "b1ff0000-0000-0000-0000-000000000002";
const GHU = "b1ff0000-0000-0000-0000-000000000003";
const REPO = "b1ff0000-0000-0000-0000-000000000004";
const PR = "b1ff0000-0000-0000-0000-000000000005";
const REVIEW = "b1ff0000-0000-0000-0000-000000000006";
const FIND = "b1ff0000-0000-0000-0000-000000000007";
const GHREPO = 996100010;

let pool: Pool;
let db: Kysely<unknown>;
const registry = new KeyRegistry();
registry.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(7)]]) }));

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.feedback_events WHERE review_finding_id = ${FIND}`.execute(db);
  await sql`DELETE FROM core.review_findings WHERE review_finding_id = ${FIND}`.execute(db);
  await sql`DELETE FROM core.pull_request_reviews WHERE review_id = ${REVIEW}`.execute(db);
  await sql`DELETE FROM core.pull_requests WHERE pr_id = ${PR}`.execute(db);
  await sql`DELETE FROM core.repositories WHERE repository_id = ${REPO}`.execute(db);
  await sql`DELETE FROM core.gh_users WHERE gh_user_id = ${GHU}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id IN (${INST}, ${OTHER})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  for (const inst of [INST, OTHER]) {
    await sql`INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
              VALUES (${inst}, ${996100000 + Number.parseInt(inst.slice(-1), 16)}, ${"itest-ff-" + inst.slice(-1)}, 'Organization')`.execute(db);
  }
  await sql`INSERT INTO core.gh_users (gh_user_id, github_user_id, login, user_type) VALUES (${GHU}, 996100099, 'ffauthor', 'User')`.execute(db);
  await sql`INSERT INTO core.repositories (repository_id, installation_id, github_repo_id, full_name, default_branch)
            VALUES (${REPO}, ${INST}, ${GHREPO}, 'ffrog/ffrepo', 'main')`.execute(db);
  await sql`INSERT INTO core.pull_requests
              (pr_id, installation_id, repository_id, github_pull_request_id, pr_number, author_gh_user_id,
               state, title, base_ref, base_sha, head_ref, head_sha, opened_at)
            VALUES (${PR}, ${INST}, ${REPO}, 996100042, 42, ${GHU}, 'open', 'PR', 'main',
                    ${"a".repeat(40)}, 'feat', ${"b".repeat(40)}, now())`.execute(db);
  await sql`INSERT INTO core.pull_request_reviews (review_id, provider, repo_id, pr_number, provider_pr_id)
            VALUES (${REVIEW}, 'github', ${GHREPO}, 42, 'gh-ff42')`.execute(db);
  await sql`INSERT INTO core.review_findings
              (review_finding_id, installation_id, pr_id, file_path, start_line, end_line, severity, category, title, body, confidence)
            VALUES (${FIND}, ${INST}, ${PR}, 'src/a.ts', 1, 2, 'issue', 'bug', 'T', 'B', 0.900)`.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function cookie(role: Role, installationId: string | null): Record<string, string> {
  return {
    [SESSION_COOKIE_NAME]: issueCookie({
      user_id: "00000000-0000-0000-0000-0000000000aa",
      email: "u@x",
      role,
      auth_source: "local",
      ldap_groups: [],
      now: NOW,
      signing_key: SIGNING_KEY,
      installation_id: installationId,
    }),
  };
}

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }), registry });
  await app.ready();
  return app;
}

const URL = `/api/admin/reviews/${REVIEW}/findings/${FIND}/feedback`;

describeDb("admin finding-feedback write (disposable :5434)", () => {
  it("verb→kind collapse + encrypted write; tenancy 404; role 403; 422", async () => {
    const app = await makeApp();
    const ok = await app.inject({ method: "POST", url: URL, cookies: cookie("platform_operator", INST), payload: { verb: "helpful" } });
    expect(ok.statusCode).toBe(201);
    const eid = ok.json<{ feedback_event_id: string }>().feedback_event_id;
    const row = await sql<{ kind: string; raw_payload: Buffer | null }>`SELECT kind, raw_payload FROM core.feedback_events WHERE feedback_event_id = ${eid}`.execute(db);
    expect(row.rows[0]!.kind).toBe("thumbs_up"); // helpful → thumbs_up
    expect(row.rows[0]!.raw_payload).not.toBeNull(); // encrypted bytea
    expect(Buffer.from(row.rows[0]!.raw_payload!).toString("ascii")).toMatch(/^kms2:/); // AAD-bound envelope

    // 'wrong' collapses to thumbs_down (verb preserved only in raw_payload)
    const wrong = await app.inject({ method: "POST", url: URL, cookies: cookie("platform_owner", INST), payload: { verb: "wrong" } });
    expect(wrong.statusCode).toBe(201);
    const wrongRow = await sql<{ kind: string }>`SELECT kind FROM core.feedback_events WHERE feedback_event_id = ${wrong.json<{ feedback_event_id: string }>().feedback_event_id}`.execute(db);
    expect(wrongRow.rows[0]!.kind).toBe("thumbs_down");

    // tenancy: a session bound to a different installation → 404 (the finding isn't in that tenant)
    expect((await app.inject({ method: "POST", url: URL, cookies: cookie("platform_operator", OTHER), payload: { verb: "helpful" } })).statusCode).toBe(404);
    // unknown finding id → 404
    expect((await app.inject({ method: "POST", url: `/api/admin/reviews/${REVIEW}/findings/b1ff0000-0000-0000-0000-0000000000ff/feedback`, cookies: cookie("platform_operator", INST), payload: { verb: "helpful" } })).statusCode).toBe(404);
    // reader 403; bad verb 422; bad uuid 422
    expect((await app.inject({ method: "POST", url: URL, cookies: cookie("reader", INST), payload: { verb: "helpful" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: URL, cookies: cookie("platform_operator", INST), payload: { verb: "love-it" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: `/api/admin/reviews/not-a-uuid/findings/${FIND}/feedback`, cookies: cookie("platform_operator", INST), payload: { verb: "helpful" } })).statusCode).toBe(422);
    await app.close();
  });
});
