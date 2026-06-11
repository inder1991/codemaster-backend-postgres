// "Prove the FULL chain" — the operator-gated live smoke of the REAL review pipeline, in EITHER runtime.
//
// Unlike scripts/dualrun/prove_pipe.ts (which dispatches the thin `reviewSkeleton` spine and proves only
// worker→activity→DataConverter→Postgres→stale-write-guard), this drives the entire chain: gate →
// placeholder → enrich → allocate → clone → classify → [chunk‖static-analysis] → carry-forward →
// retrieve → fan-out(review via the LLM) → dedup → aggregate → post-filter → citation → persist →
// arbitration → walkthrough → [post‖check] → fix-prompt → lifecycle → finalize → cleanup → release-mutex.
// See docs/runbooks/2026-06-06-orchestrator-live-dual-run.md.
//
// RUNTIME MODE (CS1.1 cutover parity — the SAME smoke proves BOTH worlds):
//   * CODEMASTER_RUNTIME_MODE unset/"temporal" — the pre-cutover path: dispatch via the Temporal
//     Client to a polling worker (start apps/.../worker/main.ts first). @temporalio/client is loaded
//     LAZILY in this branch only.
//   * CODEMASTER_RUNTIME_MODE="postgres" — the TEMPORAL-FREE path: the dispatch goes through the REAL
//     production cutover spine — PostgresOutboxRepo.appendReviewDispatch (the byte-shape the webhook
//     emitter writes) → wireOutboxSinks → drainOutboxOnce (the AD-4 guard + PENDING→RUNNING flip +
//     ReviewJobsRepo.enqueue with delivery_id, CS4.1) → runReviewCycleOnce (claim → the REAL
//     runReviewJob shell → orchestrate → settle). ZERO @temporalio imports execute in this mode.
//
// Because the chain CLONES a real repo and REVIEWS via the LLM, the operator MUST point it at a real PR:
// a GitHub App installation that can read the repo + a head_sha that exists. Those come from env (below).
// Both modes additionally need the worker-grade env (Vault GitHub App creds + a seeded
// core.llm_provider_settings + embedder vars; preflight #4 in the runbook).
//
// node:crypto is fine here — scripts/ is outside the clock/random gate's scope.
import { randomInt, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { PostgresOutboxRepo } from "#backend/domain/repos/outbox_repo.js";
import {
  buildBackgroundRunner,
  wireOutboxSinks,
} from "#backend/runner/background_runner_main.js";

import { WallClock } from "#platform/clock.js";
import { disposePool } from "#platform/db/database.js";

import {
  ReviewPullRequestPayloadV1,
  ReviewPullRequestResultV1,
} from "#contracts/review_pull_request.v1.js";

// ── Config ───────────────────────────────────────────────────────────────────────────────────────────
const RUNTIME_MODE: "temporal" | "postgres" =
  process.env.CODEMASTER_RUNTIME_MODE === "postgres" ? "postgres" : "temporal";
const DSN = process.env.CODEMASTER_PG_CORE_DSN ?? "";
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "dualrun";
// Default MUST match the worker's default task queue (apps/backend/src/worker/temporal_config.ts), so the
// worker actually polls what we dispatch when neither side sets TEMPORAL_TASK_QUEUE.
const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? "review-pull-request-dualrun";

// The REAL PR to review — the GitHub App installation must be able to clone the repo at head_sha.
const GH_OWNER = process.env.DUALRUN_GH_OWNER ?? "";
const GH_REPO = process.env.DUALRUN_GH_REPO ?? "";
const GH_INSTALLATION_ID = process.env.DUALRUN_GH_INSTALLATION_ID ?? "";
const HEAD_SHA = process.env.DUALRUN_HEAD_SHA ?? "";
const PR_NUMBER = process.env.DUALRUN_PR_NUMBER ?? "";
const BASE_SHA = process.env.DUALRUN_BASE_SHA ?? "0".repeat(40);
const PR_TITLE = process.env.DUALRUN_PR_TITLE ?? "Dual-run full-chain review";

function requireEnv(name: string, value: string): void {
  if (value === "") {
    throw new Error(
      `${name} is required for the full-chain dual-run (it clones + reviews a REAL PR). ` +
        "Set DUALRUN_GH_OWNER, DUALRUN_GH_REPO, DUALRUN_GH_INSTALLATION_ID, DUALRUN_HEAD_SHA, DUALRUN_PR_NUMBER.",
    );
  }
}

function validateConfig(): void {
  if (!DSN.includes("localhost") && !DSN.includes("127.0.0.1")) {
    throw new Error(`refusing a non-localhost DSN (cluster-DB guard): ${DSN}`);
  }
  requireEnv("DUALRUN_GH_OWNER", GH_OWNER);
  requireEnv("DUALRUN_GH_REPO", GH_REPO);
  requireEnv("DUALRUN_GH_INSTALLATION_ID", GH_INSTALLATION_ID);
  requireEnv("DUALRUN_HEAD_SHA", HEAD_SHA);
  requireEnv("DUALRUN_PR_NUMBER", PR_NUMBER);
  if (HEAD_SHA.length !== 40) {
    throw new Error(`DUALRUN_HEAD_SHA must be a 40-char commit sha; got ${HEAD_SHA.length} chars`);
  }
}

function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = {
  installationId: string;
  repositoryId: string;
  prId: string;
  reviewId: string;
  runId: string;
};

/**
 * Seed the FK chain on the disposable PG with the REAL GitHub identifiers so the clone + post activities
 * resolve. Mirrors prove_pipe.ts::seedTenant (installation → repo → gh_user → PR → pull_request_reviews →
 * review_runs, with current_run_id pointed at the run we dispatch so the stale-write guard passes), but
 * uses the operator's real github_installation_id / owner/repo / head_sha. ON CONFLICT-free: every id is
 * freshly minted, so re-running creates a fresh logical review (no cross-run interference).
 */
async function seedTenant(pool: Pool): Promise<Seed> {
  const installationId = randomUUID();
  const repositoryId = randomUUID();
  const ghUserId = randomUUID();
  const prId = randomUUID();
  const reviewId = randomUUID();
  const runId = randomUUID();
  const ghRepo = uniqueBigint();
  const ghUser = uniqueBigint();
  const ghPr = uniqueBigint();
  const prNumber = Number(PR_NUMBER);

  await pool.query(
    `INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, Number(GH_INSTALLATION_ID), GH_OWNER],
  );
  await pool.query(
    `INSERT INTO core.repositories (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, $4, 'main', true)`,
    [repositoryId, installationId, ghRepo, `${GH_OWNER}/${GH_REPO}`],
  );
  await pool.query(
    `INSERT INTO core.gh_users (gh_user_id, github_user_id, login, user_type) VALUES ($1, $2, $3, 'User')`,
    [ghUserId, ghUser, `user-${ghUser}`],
  );
  await pool.query(
    `INSERT INTO core.pull_requests
       (pr_id, installation_id, repository_id, github_pull_request_id, pr_number,
        author_gh_user_id, state, title, base_ref, base_sha, head_ref, head_sha, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, 'main', $8, 'feature', $9, now())`,
    [prId, installationId, repositoryId, ghPr, prNumber, ghUserId, PR_TITLE, BASE_SHA, HEAD_SHA],
  );
  await pool.query(
    `INSERT INTO core.pull_request_reviews (review_id, provider, repo_id, pr_number, provider_pr_id, current_run_id)
     VALUES ($1, 'github', $2, $3, $4, NULL)`,
    [reviewId, ghRepo, prNumber, `pr-${ghRepo}-${ghPr}`],
  );
  await pool.query(
    `INSERT INTO core.review_runs (run_id, review_id, trigger_type) VALUES ($1, $2, 'pr_opened')`,
    [runId, reviewId],
  );
  await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = $1 WHERE review_id = $2`, [
    runId,
    reviewId,
  ]);
  return { installationId, repositoryId, prId, reviewId, runId };
}

function buildPayload(seed: Seed): ReviewPullRequestPayloadV1 {
  return ReviewPullRequestPayloadV1.parse({
    schema_version: 2,
    installation_id: seed.installationId,
    repository_id: seed.repositoryId,
    pr_id: seed.prId,
    pr_number: Number(PR_NUMBER),
    head_sha: HEAD_SHA,
    gh_owner: GH_OWNER,
    gh_repo_name: GH_REPO,
    pr_title: PR_TITLE,
    pr_description: "Full-chain dual-run dispatch (scripts/dualrun/prove_full_chain.ts).",
    delivery_id: `dualrun-${randomUUID()}`,
    policy_revision: 0,
    run_id: seed.runId,
    review_id: seed.reviewId,
    github_installation_id: Number(GH_INSTALLATION_ID),
  });
}

// ── Dispatch — temporal mode (the pre-cutover path; @temporalio loaded LAZILY, only here) ────────────
async function runViaTemporal(
  payload: ReviewPullRequestPayloadV1,
  seed: Seed,
): Promise<{ accepted: boolean; resultFindingsCount: number | null }> {
  const { Client, Connection } = await import("@temporalio/client");
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection, namespace: NAMESPACE });
  try {
    const workflowId = `review-pr-dualrun-${seed.prId}`;
    process.stdout.write(
      `dispatching reviewPullRequest (workflowId=${workflowId}, ns=${NAMESPACE}, tq=${TASK_QUEUE})\n`,
    );
    const handle = await client.workflow.start("reviewPullRequest", {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [payload],
    });
    process.stdout.write(`workflow started (runId=${handle.firstExecutionRunId}); awaiting result…\n`);
    const result = ReviewPullRequestResultV1.parse(await handle.result());
    process.stdout.write(
      `\nworkflow result: status=${result.status} findings_count=${result.findings_count} ` +
        `publication_outcome=${result.publication_outcome ?? "none"}\n`,
    );
    return { accepted: result.status === "accepted", resultFindingsCount: result.findings_count };
  } finally {
    await connection.close();
  }
}

// ── Dispatch — postgres mode (the TEMPORAL-FREE cutover spine, byte-identical to production) ─────────
async function runViaPostgresRunner(
  payload: ReviewPullRequestPayloadV1,
  seed: Seed,
): Promise<{ accepted: boolean; resultFindingsCount: number | null }> {
  const clock = new WallClock();
  const kpool = new Pool({ connectionString: DSN, max: 6 });
  const kdb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: kpool }) });
  try {
    // (1) The PRODUCER's byte-shape: the same outer envelope github_webhook_persistence.ts
    // buildOuterPayload stamps, appended through the same repo fn (sink='temporal_workflow_start',
    // run_id-anchored so the drain's AD-4 guard + PENDING→RUNNING flip fire exactly as live).
    const envelope = {
      workflow_type: "reviewPullRequest",
      workflow_id: `review/${payload.installation_id}/${payload.repository_id}/${payload.pr_number}`,
      task_queue: "review-default",
      args: [payload],
      id_reuse_policy: "ALLOW_DUPLICATE",
      id_conflict_policy: "USE_EXISTING",
      execution_timeout_seconds: 1800,
      run_timeout_seconds: 1800,
    };
    await new PostgresOutboxRepo({ clock }).appendReviewDispatch({
      db: kdb,
      runId: seed.runId,
      payload: envelope,
      schemaVersion: 2,
      installationId: seed.installationId,
      deliveryId: payload.delivery_id,
      traceContext: null,
    });

    // (2) The CONSUMER: the real composed runtime — sinks wired onto the Postgres port (CS1.1),
    // one outbox drain (dispatchRow guard → ReviewJobsRepo.enqueue with delivery_id, CS4.1), then
    // one review cycle (claim → the REAL runReviewJob shell → orchestrate → settle). maxRuntimeS
    // matches the Temporal run_timeout (1800s) — a real clone+LLM review takes minutes.
    wireOutboxSinks(kdb);
    const handles = buildBackgroundRunner({
      db: kdb,
      clock,
      dsn: DSN,
      config: {
        owner: `prove-full-chain-${randomUUID().slice(0, 8)}`,
        leaseS: 120,
        heartbeatS: 15,
        maxRuntimeS: 1800,
        idleS: 5,
        pollIntervalS: 600,
        outboxIdleS: 600,
        outboxMaxAttempts: 5,
      },
    });
    const drained = await handles.drainOutboxOnce();
    process.stdout.write(`outbox drained: ${drained} row(s) → review_jobs (Temporal-free dispatch)\n`);

    // The review loop is composed in every non-shadow build (CS2.1); its absence is a wiring bug.
    const runReviewCycleOnce = handles.runReviewCycleOnce;
    if (runReviewCycleOnce === undefined) {
      throw new Error("buildBackgroundRunner composed NO review loop — postgres mode requires it (CS2.1)");
    }
    let outcome = "idle";
    for (let attempt = 0; attempt < 30 && outcome === "idle"; attempt++) {
      const cycle = await runReviewCycleOnce();
      outcome = cycle.outcome;
      if (outcome === "idle") {
        await new Promise((resolve) => setTimeout(resolve, 1000)); // run_after may be a beat away
      }
    }
    process.stdout.write(`review cycle outcome: ${outcome}\n`);

    const job = await kpool.query<{ state: string; attempts: number; delivery_id: string | null }>(
      `SELECT state, attempts, delivery_id FROM core.review_jobs WHERE run_id = $1`,
      [seed.runId],
    );
    process.stdout.write(
      `core.review_jobs: state=${job.rows[0]?.state ?? "<missing>"} attempts=${job.rows[0]?.attempts ?? "-"} ` +
        `delivery_id=${job.rows[0]?.delivery_id ?? "<null>"}\n`,
    );
    // No workflow return envelope exists in this runtime — the persisted rows ARE the result; the
    // shared verification below reads them. Acceptance = the job settled done.
    return { accepted: outcome === "done", resultFindingsCount: null };
  } finally {
    await kdb.destroy();
    await disposePool(DSN); // the shell's in-process ports rode the shared ADR-0062 pool
  }
}

async function main(): Promise<void> {
  validateConfig();
  const pool = new Pool({ connectionString: DSN, max: 4 });
  try {
    const seed = await seedTenant(pool);
    const payload = buildPayload(seed);
    process.stdout.write(
      `mode=${RUNTIME_MODE} repo=${GH_OWNER}/${GH_REPO} pr#=${PR_NUMBER} head=${HEAD_SHA.slice(0, 12)} ` +
        `install=${GH_INSTALLATION_ID}\n`,
    );

    const { accepted, resultFindingsCount } =
      RUNTIME_MODE === "postgres" ? await runViaPostgresRunner(payload, seed) : await runViaTemporal(payload, seed);

    // ── Verify the side effects landed (runtime-agnostic: pure DB reads) ─────────────────────────────
    const findings = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.review_findings WHERE pr_id = $1 AND installation_id = $2`,
      [seed.prId, seed.installationId],
    );
    const walkthrough = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.review_walkthroughs WHERE review_id = $1`,
      [seed.reviewId],
    );
    const run = await pool.query<{ status: string | null; lifecycle_state: string | null }>(
      `SELECT status, lifecycle_state FROM core.review_runs WHERE run_id = $1`,
      [seed.runId],
    );
    const milestones = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit.workflow_events WHERE review_id = $1 ORDER BY created_at`,
      [seed.reviewId],
    );

    const findingsCount = Number(findings.rows[0]?.n ?? 0);
    const walkthroughCount = Number(walkthrough.rows[0]?.n ?? 0);
    // lifecycle_state is the runner-era authority (finalizeReviewRun RUNNING→COMPLETED); the legacy
    // status column remains the temporal-era read.
    const runStatus = run.rows[0]?.lifecycle_state ?? run.rows[0]?.status ?? "<missing>";
    const milestoneTypes = milestones.rows.map((r) => r.event_type);

    process.stdout.write(`core.review_findings rows:    ${findingsCount}\n`);
    process.stdout.write(`core.review_walkthroughs rows: ${walkthroughCount}\n`);
    process.stdout.write(`core.review_runs state:        ${runStatus}\n`);
    process.stdout.write(`audit.workflow_events:         ${milestoneTypes.join(" → ")}\n`);

    // Acceptance: the runtime accepted the review, the run finished cleanly (no zombie RUNNING), and —
    // when the runtime returns a result envelope (temporal mode) — the persisted-finding count matches
    // it. findings_count may legitimately be 0 for a clean PR; the chain still PASSED.
    const runDone = runStatus === "COMPLETED";
    const countsMatch = resultFindingsCount === null || findingsCount === resultFindingsCount;
    const ok = accepted && runDone && countsMatch;
    if (ok) {
      process.stdout.write(
        `\nFULL-CHAIN PASS [mode=${RUNTIME_MODE}] — the real reviewPullRequest pipeline composed ` +
          `end-to-end against live PG + ${RUNTIME_MODE === "postgres" ? "the Postgres runner (NO Temporal)" : "Temporal"} ` +
          `+ the LLM (${findingsCount} finding(s) persisted, run COMPLETED).\n`,
      );
    } else {
      process.stderr.write(
        `\nFULL-CHAIN FAIL [mode=${RUNTIME_MODE}] — accepted=${accepted} runDone=${runDone} ` +
          `countsMatch=${countsMatch} (persisted=${findingsCount} result=${resultFindingsCount ?? "n/a"})\n`,
      );
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `prove_full_chain FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
