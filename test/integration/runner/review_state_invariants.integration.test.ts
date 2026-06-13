// W3.3 — review state-machine invariant tests. Pins the DB-ENFORCED invariants of the review lifecycle
// (the single-source-of-truth in docs/runbooks/review-state-machine.md): a run cannot be half-terminal
// (terminal state ⇔ its timestamp), a supersede must name its successor, and at most one live job per run.
// (Invariant 2 "dead/cancelled ⇒ no live mutex" is pinned by the run-reaper OH9 test; invariant 4
// "posted ⇒ recoverable" by the post_review_results tests.) Runs ONLY when CODEMASTER_PG_CORE_DSN is set.

import { createHash, randomInt } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { disposePool, getPool } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;

beforeAll(() => {
  if (INTEGRATION_DSN) pool = getPool(INTEGRATION_DSN);
});
afterAll(async () => {
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

function newUuid(): string {
  const h = createHash("sha1")
    .update(Buffer.from(`${process.hrtime.bigint()}-${randomInt(0, 1 << 30)}`, "utf-8"))
    .digest();
  const b = Buffer.from(h.subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x40, 6);
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const hx = b.toString("hex");
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20, 32)}`;
}
const bigint = (): number => randomInt(1, 2_000_000_000);

/** Seed a minimal pull_request_reviews + review_run (PENDING) chain. Returns {reviewId, runId}. */
async function seedReview(): Promise<{ reviewId: string; runId: string }> {
  const reviewId = newUuid();
  const runId = newUuid();
  const repoId = bigint();
  await pool.query(
    `INSERT INTO core.pull_request_reviews (review_id, provider, repo_id, pr_number, provider_pr_id, status, current_run_id)
     VALUES ($1, 'github', $2, $3, $4, 'open', NULL)`,
    [reviewId, repoId, (bigint() % 9999) + 1, `pr-${repoId}`],
  );
  await pool.query(
    `INSERT INTO core.review_runs (run_id, review_id, trigger_type, lifecycle_state, started_at)
     VALUES ($1, $2, 'pr_opened', 'RUNNING', now())`,
    [runId, reviewId],
  );
  return { reviewId, runId };
}

async function dropReview(reviewId: string, runId: string): Promise<void> {
  await pool.query(`DELETE FROM core.review_jobs WHERE run_id = $1`, [runId]);
  await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [runId]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [reviewId]);
}

describeDb("review state-machine invariants (W3.3)", () => {
  it("a run cannot be marked COMPLETED without completed_at (no half-terminal run — invariant 1 enforcement)", async () => {
    const { reviewId, runId } = await seedReview();
    try {
      await expect(
        pool.query(`UPDATE core.review_runs SET lifecycle_state = 'COMPLETED' WHERE run_id = $1`, [runId]),
      ).rejects.toThrow(/ck_review_runs_completed_at_present/);
      // …and the matching transition (state + timestamp together) is accepted.
      await pool.query(
        `UPDATE core.review_runs SET lifecycle_state = 'COMPLETED', completed_at = now() WHERE run_id = $1`,
        [runId],
      );
      const r = await pool.query<{ lifecycle_state: string }>(
        `SELECT lifecycle_state FROM core.review_runs WHERE run_id = $1`,
        [runId],
      );
      expect(r.rows[0]?.lifecycle_state).toBe("COMPLETED");
    } finally {
      await dropReview(reviewId, runId);
    }
  });

  it("a supersede must name its successor (cancel_reason='superseded' ⇒ superseded_by_run_id NOT NULL)", async () => {
    const { reviewId, runId } = await seedReview();
    try {
      await expect(
        pool.query(
          `UPDATE core.review_runs SET lifecycle_state = 'CANCELLED', cancelled_at = now(), cancel_reason = 'superseded'
             WHERE run_id = $1`,
          [runId],
        ),
      ).rejects.toThrow(/ck_review_runs_supersede_reason/);
    } finally {
      await dropReview(reviewId, runId);
    }
  });

  it("at most ONE live (ready/leased) job per run — the second insert violates uq_review_jobs_active_run (invariant 5)", async () => {
    const { reviewId, runId } = await seedReview();
    const installationId = newUuid();
    await pool.query(
      `INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
       VALUES ($1, $2, $3, 'Organization')`,
      [installationId, bigint(), `acct-${installationId.slice(0, 8)}`],
    );
    const job = (): Array<unknown> => [newUuid(), runId, reviewId, installationId];
    const insertReady = `INSERT INTO core.review_jobs (job_id, run_id, review_id, installation_id, state, payload, payload_sha256)
                         VALUES ($1, $2, $3, $4, 'ready', '{}'::jsonb, repeat('0', 64))`;
    try {
      await pool.query(insertReady, job()); // first live job: OK
      await expect(pool.query(insertReady, job())).rejects.toThrow(/uq_review_jobs_active_run/); // second: rejected
    } finally {
      await pool.query(`DELETE FROM core.review_jobs WHERE run_id = $1`, [runId]);
      await dropReview(reviewId, runId);
      await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [installationId]);
    }
  });
});
