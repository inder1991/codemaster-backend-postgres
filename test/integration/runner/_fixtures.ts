// test/integration/runner/_fixtures.ts
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { type Kysely, sql } from "kysely";
import {
  ReviewPullRequestPayloadV1,
  type ReviewPullRequestPayloadV1 as ReviewPullRequestPayloadV1Type,
} from "#contracts/review_pull_request.v1.js";

/**
 * Seed a real review chain (pull_request_reviews → review_runs) so review_jobs.run_id FK holds.
 * Column sets + UNIQUE indexes verified against :5434/codemaster:
 *  - core.pull_request_reviews NOT NULL: review_id, provider, repo_id(bigint), pr_number, provider_pr_id,
 *    status(CHECK ∈ open|closed|merged), created_at. (repo_id is a GitHub bigint, NOT a hard FK — orphans allowed.)
 *    UNIQUE (provider, provider_pr_id) AND UNIQUE (provider, repo_id, pr_number) — the fixture ties BOTH to the
 *    globally-unique reviewId so parallel/repeated seeds cannot collide (v4 #5).
 *  - core.review_runs NOT NULL: run_id, review_id(FK→pull_request_reviews.review_id), trigger_type
 *    (CHECK ∈ pr_opened|pr_synchronize|manual_rerun|comment_trigger|retry|scheduled), attempt_number(≥1),
 *    lifecycle_state(CHECK ∈ PENDING|RUNNING|WAITING_RETRY|COMPLETED|FAILED|CANCELLED|PARTIAL), is_ephemeral,
 *    started_at, created_at.
 */
export async function seedRun(db: Kysely<unknown>): Promise<{ runId: string; reviewId: string; installationId: string }> {
  return seedRunWithState(db, "PENDING");
}

/**
 * Like {@link seedRun} but seeds the run in an explicit `lifecycle_state` (W5.1b: terminalSettle tests need a
 * run in `RUNNING` so the atomic job+run terminal transition can be asserted from `RUNNING → CANCELLED/FAILED`).
 * The same uniqueness derivation as {@link seedRun} keeps both UNIQUE indexes collision-proof across seeds.
 */
export async function seedRunWithState(
  db: Kysely<unknown>,
  lifecycleState: string,
): Promise<{ runId: string; reviewId: string; installationId: string }> {
  const runId = randomUUID(), reviewId = randomUUID(), installationId = randomUUID();
  // Derive uniqueness from the globally-unique reviewId so NEITHER unique index can flake:
  //   provider_pr_id carries the full reviewId  → UNIQUE (provider, provider_pr_id) holds.
  //   repo_id = 48 bits of the reviewId         → UNIQUE (provider, repo_id, pr_number) holds (collision-proof for tests;
  //   48-bit birthday bound ≈ 16M rows, exact as a JS integer < 2^53, fits the bigint column). pr_number is fixed at 1.
  const repoId = parseInt(reviewId.replace(/-/g, "").slice(0, 12), 16);
  await sql`INSERT INTO core.pull_request_reviews
      (review_id, provider, repo_id, pr_number, provider_pr_id, status, created_at)
    VALUES (${reviewId}, 'github', ${repoId}, 1, ${`gh-${reviewId}`}, 'open', now())`.execute(db);
  await sql`INSERT INTO core.review_runs
      (run_id, review_id, trigger_type, attempt_number, lifecycle_state, is_ephemeral, started_at, created_at)
    VALUES (${runId}, ${reviewId}, 'pr_opened', 1, ${lifecycleState}, false, now(), now())`.execute(db);
  return { runId, reviewId, installationId };
}

/** Read a run row's lifecycle_state + terminal-timestamp columns for terminalSettle assertions. */
export async function readRun(
  db: Kysely<unknown>,
  runId: string,
): Promise<{ lifecycle_state: string; cancelled_at: string | null; failed_at: string | null; cancel_reason: string | null }> {
  const r = await sql<{
    lifecycle_state: string; cancelled_at: string | null; failed_at: string | null; cancel_reason: string | null;
  }>`SELECT lifecycle_state, cancelled_at, failed_at, cancel_reason FROM core.review_runs WHERE run_id = ${runId}`
    .execute(db);
  return r.rows[0]!;
}

/**
 * A minimal VALID ReviewPullRequestPayloadV1 (inner `schema_version` = 2) tied to a seeded run's ids, so
 * `enqueue` (Task W0.2) accepts it and the durable-argument store round-trips. Phase-1 enqueue tests call
 * `enqueue` with no payload; after W0.2 `enqueue` REQUIRES one — every existing call site threads this.
 *
 * The `s` overload (minimalReviewPayloadForSeed) reuses the run/review/installation ids from `seedRun` so the
 * payload is self-consistent with the FK chain; `repository_id`/`pr_id` are fresh UUIDs (the payload carries
 * GitHub-side identity that need not exist as DB FKs for the enqueue path). The result is parsed through the
 * contract so the fixture itself can never drift from the schema.
 */
export function minimalReviewPayload(
  ids: { runId: string; reviewId: string; installationId: string },
): ReviewPullRequestPayloadV1Type {
  return ReviewPullRequestPayloadV1.parse({
    schema_version: 2,
    installation_id: ids.installationId,
    repository_id: randomUUID(),
    pr_id: randomUUID(),
    pr_number: 1,
    head_sha: "0".repeat(40),
    gh_owner: "acme",
    gh_repo_name: "widgets",
    pr_title: "Add widget",
    pr_description: "",
    delivery_id: `dlv-${ids.reviewId}`,
    policy_revision: 0,
    run_id: ids.runId,
    review_id: ids.reviewId,
  });
}
