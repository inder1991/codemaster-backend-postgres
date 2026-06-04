// "Prove the pipe" — the first end-to-end Temporal-TS execution of the codemaster-backend port.
//
// Seeds the FK chain on the DISPOSABLE Postgres (CODEMASTER_PG_CORE_DSN — localhost:5434 ONLY), then
// dispatches the `reviewSkeleton` workflow through the in-cluster Temporal (via the port-forward) on the
// ISOLATED `dualrun` namespace + `review-skeleton-dualrun` task queue, awaits the returned finding ids,
// and verifies the rows actually landed in core.review_findings + the FINDINGS_PERSISTED milestone in
// audit.workflow_events. Proves: worker -> activity -> DataConverter -> Postgres -> stale-write-guard.
//
// node:crypto here is fine — scripts/ is outside the clock/random gate's scope. The WORKER must already
// be polling `review-skeleton-dualrun` (start apps/.../worker/main.ts first).
import { randomInt, randomUUID } from "node:crypto";

import { Client, Connection } from "@temporalio/client";
import { Pool } from "pg";

import { PersistReviewFindingsInputV1 } from "#contracts/persist_review_findings.v1.js";

const DSN = process.env.CODEMASTER_PG_CORE_DSN ?? "";
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "dualrun";
const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? "review-skeleton-dualrun";

if (!DSN.includes("localhost") && !DSN.includes("127.0.0.1")) {
  throw new Error(`refusing a non-localhost DSN (cluster-DB guard): ${DSN}`);
}

function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = {
  installationId: string;
  prId: string;
  reviewId: string;
  currentRunId: string;
};

/** Mirror of the integration test's seedTenant: installation -> repo -> gh_user -> PR, plus a
 *  pull_request_reviews row whose current_run_id is the authoritative run (so the stale-write guard in
 *  persistAggregated passes when we dispatch with run_id === current_run_id). */
async function seedTenant(pool: Pool): Promise<Seed> {
  const installationId = randomUUID();
  const repositoryId = randomUUID();
  const ghUserId = randomUUID();
  const prId = randomUUID();
  const reviewId = randomUUID();
  const currentRunId = randomUUID();
  const ghInstall = uniqueBigint();
  const ghRepo = uniqueBigint();
  const ghUser = uniqueBigint();
  const ghPr = uniqueBigint();

  await pool.query(
    `INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, ghInstall, `acct-${ghInstall}`],
  );
  await pool.query(
    `INSERT INTO core.repositories (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, $4, 'main', true)`,
    [repositoryId, installationId, ghRepo, `org/repo-${ghRepo}`],
  );
  await pool.query(
    `INSERT INTO core.gh_users (gh_user_id, github_user_id, login, user_type) VALUES ($1, $2, $3, 'User')`,
    [ghUserId, ghUser, `user-${ghUser}`],
  );
  await pool.query(
    `INSERT INTO core.pull_requests
       (pr_id, installation_id, repository_id, github_pull_request_id, pr_number,
        author_gh_user_id, state, title, base_ref, base_sha, head_ref, head_sha, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', 'Skeleton PR', 'main', $7, 'feature', $8, now())`,
    [prId, installationId, repositoryId, ghPr, (ghPr % 9999) + 1, ghUserId, "a".repeat(40), "b".repeat(40)],
  );
  await pool.query(
    `INSERT INTO core.pull_request_reviews (review_id, provider, repo_id, pr_number, provider_pr_id, current_run_id)
     VALUES ($1, 'github', $2, $3, $4, NULL)`,
    [reviewId, ghRepo, (ghPr % 9999) + 1, `pr-${ghRepo}-${ghPr}`],
  );
  await pool.query(
    `INSERT INTO core.review_runs (run_id, review_id, trigger_type) VALUES ($1, $2, 'pr_opened')`,
    [currentRunId, reviewId],
  );
  await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = $1 WHERE review_id = $2`, [
    currentRunId,
    reviewId,
  ]);
  return { installationId, prId, reviewId, currentRunId };
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DSN, max: 4 });
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection, namespace: NAMESPACE });
  try {
    const seed = await seedTenant(pool);

    const input = PersistReviewFindingsInputV1.parse({
      pr_id: seed.prId,
      installation_id: seed.installationId,
      run_id: seed.currentRunId,
      review_id: seed.reviewId,
      aggregated: {
        schema_version: 1,
        findings: [
          {
            schema_version: 1,
            file: "src/app.py",
            start_line: 10,
            end_line: 12,
            severity: "issue",
            category: "bug",
            title: "Off-by-one",
            body: "The loop bound is wrong.",
            suggestion: "Use <= instead of <.",
            confidence: 0.875,
            sources: [{ kind: "repo_path", locator: "src/app.py", excerpt: null }],
            scope: "chunk_observed",
            evidence_refs: ["ev_0123456789abcdef"],
          },
          {
            schema_version: 1,
            file: "src/db.py",
            start_line: 5,
            end_line: 5,
            severity: "blocker",
            category: "security",
            title: "SQLi",
            body: "Unparameterized query.",
            suggestion: null,
            confidence: 1.0,
            sources: [],
            scope: "cross_chunk",
            evidence_refs: [],
          },
        ],
        dedupe_stats: {
          input_count: 2,
          exact_dropped: 0,
          semantic_merged: 0,
          capped: 0,
          semantic_skipped: false,
        },
        policy_revision: 0,
      },
    });

    const workflowId = `skeleton-${randomUUID()}`;
    process.stdout.write(`dispatching reviewSkeleton (workflowId=${workflowId}, ns=${NAMESPACE}, tq=${TASK_QUEUE})...\n`);
    const handle = await client.workflow.start("reviewSkeleton", {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [input],
    });
    const returnedIds = (await handle.result()) as Array<string>;
    process.stdout.write(`workflow returned ${returnedIds.length} finding id(s): ${returnedIds.join(", ")}\n`);

    // Verify the side effects landed in Postgres.
    const persisted = await pool.query<{ review_finding_id: string; file_path: string; severity: string }>(
      `SELECT review_finding_id, file_path, severity FROM core.review_findings
        WHERE installation_id = $1 ORDER BY file_path`,
      [seed.installationId],
    );
    const milestones = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.workflow_events WHERE review_id = $1 AND event_type = 'FINDINGS_PERSISTED'`,
      [seed.reviewId],
    );

    const persistedIds = persisted.rows.map((r) => r.review_finding_id).sort();
    const returnedSorted = [...returnedIds].sort();
    const idsMatch = JSON.stringify(persistedIds) === JSON.stringify(returnedSorted);
    const milestoneCount = Number(milestones.rows[0]?.n);

    process.stdout.write(`persisted rows: ${persisted.rows.length} (${persisted.rows.map((r) => `${r.file_path}/${r.severity}`).join(", ")})\n`);
    process.stdout.write(`FINDINGS_PERSISTED milestones: ${milestoneCount}\n`);

    const ok = returnedIds.length === 2 && persisted.rows.length === 2 && idsMatch && milestoneCount === 1;
    if (ok) {
      process.stdout.write("\nPROVE-PIPE PASS — worker -> activity -> DataConverter -> Postgres -> stale-write-guard end to end.\n");
    } else {
      process.stderr.write(
        `\nPROVE-PIPE FAIL — returned=${returnedIds.length} persisted=${persisted.rows.length} idsMatch=${idsMatch} milestones=${milestoneCount}\n`,
      );
      process.exitCode = 1;
    }
  } finally {
    await connection.close();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`prove_pipe FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
