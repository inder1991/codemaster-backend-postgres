// test/integration/runner/shell_mutex.integration.test.ts
//
// W5.1 (D3 + F6): acquireOrReuseMutex — the shell's mutex acquire-or-reuse with OWNERSHIP VALIDATION.
//
// DB-gated integration test against the DISPOSABLE Postgres (CODEMASTER_PG_CORE_DSN=…:5434/codemaster).
// Runs ONLY when the DSN is set (describeDb); SKIPS otherwise so validate-fast stays green without a DB.
// We NEVER touch any other DB. Each test seeds its own FK chain (installation → repository → review chain
// → job) and cleans it up; the suite-wide beforeEach DELETE on core.review_jobs handles the cross-tenant
// claim()/reap scans (vitest shuffles order + runs --no-file-parallelism).
//
// The four W5.1 cases:
//   (a) acquired         — first run (job.mutex_id IS NULL) acquires + persists mutex_id, status='acquired'.
//   (b) busy-foreign     — first run but a FOREIGN live lease already holds the PR → status='busy'.
//   (c) reused-on-rerun  — re-run with job.mutex_id set + the mutex row passes ownership validation →
//                          status='reused' WITHOUT a competing acquire (no self-skipped_busy).
//   (d) mismatch-reacquires — job.mutex_id points at a mutex row whose (install,repo,pr) do NOT match the
//                          payload (or is released) → DO NOT reuse; re-acquire fresh + persist the new id.

import { afterAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { randomUUID, randomInt } from "node:crypto"; // test/ is OUT of the clock/random gate's scope

import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { acquireOrReuseMutex } from "#backend/runner/shell_mutex.js";
import {
  acquirePrReviewMutex,
  renewPrReviewMutexLease,
  withMutexTransaction,
} from "#backend/concurrency/pr_mutex.js";
import { WallClock } from "#platform/clock.js";
import { ReviewPullRequestPayloadV1 } from "#contracts/review_pull_request.v1.js";

let db: Kysely<unknown>;
let pool: Pool;
if (INTEGRATION_DSN) {
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
}
afterAll(async () => {
  await db?.destroy();
});

// Cross-tenant claim() scans ALL core.review_jobs rows; clear them between tests so a shuffled leftover
// 'ready'/'leased' row cannot be claimed instead of the just-enqueued one (1:1 with the sibling runner tests).
beforeEach(async () => {
  if (INTEGRATION_DSN) await sql`DELETE FROM core.review_jobs`.execute(db);
});

const clock = new WallClock();

/** A small unique bigint so github_* unique columns never collide across tests. */
function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = {
  installationId: string;
  repositoryId: string;
  runId: string;
  reviewId: string;
  prNumber: number;
};

/**
 * Seed the full FK chain the mutex acquire needs: installation → repository (the pr_review_mutex FK
 * parents) PLUS the review chain (pull_request_reviews → review_runs) so review_jobs.run_id FK holds.
 * Returns ids the payload + the job reuse so they are self-consistent.
 */
async function seedTenant(prNumber = 7): Promise<Seed> {
  const installationId = randomUUID();
  const repositoryId = randomUUID();
  const runId = randomUUID();
  const reviewId = randomUUID();
  const ghInstall = uniqueBigint();
  const ghRepo = uniqueBigint();

  await sql`INSERT INTO core.installations
      (installation_id, github_installation_id, account_login, account_type)
    VALUES (${installationId}, ${ghInstall}, ${`acct-${ghInstall}`}, 'Organization')`.execute(db);
  await sql`INSERT INTO core.repositories
      (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
    VALUES (${repositoryId}, ${installationId}, ${ghRepo}, ${`org/repo-${ghRepo}`}, 'main', true)`.execute(db);

  const repoId = parseInt(reviewId.replace(/-/g, "").slice(0, 12), 16);
  await sql`INSERT INTO core.pull_request_reviews
      (review_id, provider, repo_id, pr_number, provider_pr_id, status, created_at)
    VALUES (${reviewId}, 'github', ${repoId}, ${prNumber}, ${`gh-${reviewId}`}, 'open', now())`.execute(db);
  await sql`INSERT INTO core.review_runs
      (run_id, review_id, trigger_type, attempt_number, lifecycle_state, is_ephemeral, started_at, created_at)
    VALUES (${runId}, ${reviewId}, 'pr_opened', 1, 'PENDING', false, now(), now())`.execute(db);

  return { installationId, repositoryId, runId, reviewId, prNumber };
}

/** A valid ReviewPullRequestPayloadV1 tied to the seeded tenant (matching install/repo/pr). */
function payloadFor(seed: Seed): ReviewPullRequestPayloadV1 {
  return ReviewPullRequestPayloadV1.parse({
    schema_version: 2,
    installation_id: seed.installationId,
    repository_id: seed.repositoryId,
    pr_id: randomUUID(),
    pr_number: seed.prNumber,
    head_sha: "0".repeat(40),
    gh_owner: "acme",
    gh_repo_name: "widgets",
    pr_title: "Add widget",
    pr_description: "",
    delivery_id: `dlv-${seed.reviewId}`,
    policy_revision: 0,
    run_id: seed.runId,
    review_id: seed.reviewId,
  });
}

/** Enqueue a job for the seed + CLAIM it (so it is `leased` with a lease_owner + attempt_token fence). */
async function enqueueAndClaim(repo: ReviewJobsRepo, seed: Seed, owner: string) {
  await repo.enqueue({
    runId: seed.runId,
    reviewId: seed.reviewId,
    installationId: seed.installationId,
    payload: payloadFor(seed),
  });
  const job = await repo.claim({ owner, leaseMs: 60_000, maxRuntimeMs: 600_000 });
  expect(job).not.toBeNull();
  return job!;
}

/** Count the LIVE (released_at IS NULL) mutex rows for a PR. */
async function liveRowCount(seed: Seed): Promise<number> {
  const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM core.pr_review_mutex
      WHERE installation_id = ${seed.installationId} AND repository_id = ${seed.repositoryId}
        AND pr_number = ${seed.prNumber} AND released_at IS NULL`.execute(db);
  return r.rows[0]!.n;
}

async function cleanup(seed: Seed): Promise<void> {
  // Delete the job row FIRST — it FK-references review_runs.run_id (review_jobs_run_id_fkey), so the run
  // delete below would otherwise violate it (the beforeEach DELETE only fires at the NEXT test's start).
  // ON DELETE CASCADE from installations then clears repositories + pr_review_mutex.
  await sql`DELETE FROM core.review_jobs WHERE run_id = ${seed.runId}`.execute(db);
  await sql`DELETE FROM core.review_runs WHERE run_id = ${seed.runId}`.execute(db);
  await sql`DELETE FROM core.pull_request_reviews WHERE review_id = ${seed.reviewId}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${seed.installationId}`.execute(db);
}

describeDb("acquireOrReuseMutex — first run (acquire)", () => {
  it("(a) job.mutex_id IS NULL → acquires via the gate txn shape, persists mutex_id, returns acquired", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant(11);
    try {
      const job = await enqueueAndClaim(repo, seed, "owner-a");
      expect(job.mutex_id ?? null).toBeNull();

      const res = await acquireOrReuseMutex({ payload: payloadFor(seed), job, repo, pool, clock });

      expect(res.status).toBe("acquired");
      expect(res.mutexId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      // mutex_id persisted onto the job row (fenced) so a re-run reuses it.
      const after = await repo.getById(job.job_id);
      expect(after!.mutex_id).toBe(res.mutexId);
      // exactly one live mutex row exists for the PR.
      expect(await liveRowCount(seed)).toBe(1);
    } finally {
      await cleanup(seed);
    }
  });
});

describeDb("acquireOrReuseMutex — busy foreign lease", () => {
  it("(b) a FOREIGN live lease already holds the PR → status='busy' (no second live row)", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant(22);
    try {
      // A DIFFERENT execution already holds a live lease on this PR.
      const foreign = await withMutexTransaction(pool, (client) =>
        acquirePrReviewMutex({
          client,
          installationId: seed.installationId,
          repositoryId: seed.repositoryId,
          prNumber: seed.prNumber,
          holderWorkflowId: "wf-foreign",
          clock,
        }),
      );
      expect(foreign.acquired).toBe(true);

      const job = await enqueueAndClaim(repo, seed, "owner-b");
      const res = await acquireOrReuseMutex({ payload: payloadFor(seed), job, repo, pool, clock });

      expect(res.status).toBe("busy");
      expect(res.mutexId).toBeNull();
      // We did NOT persist anything; the only live row is the foreign holder's.
      expect((await repo.getById(job.job_id))!.mutex_id ?? null).toBeNull();
      expect(await liveRowCount(seed)).toBe(1);
    } finally {
      await cleanup(seed);
    }
  });
});

describeDb("acquireOrReuseMutex — reuse on re-run", () => {
  it("(c) job.mutex_id set + ownership valid → reused WITHOUT a competing acquire (no self-skipped_busy)", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant(33);
    try {
      // First run: acquire + persist.
      const job1 = await enqueueAndClaim(repo, seed, "owner-c1");
      const first = await acquireOrReuseMutex({ payload: payloadFor(seed), job: job1, repo, pool, clock });
      expect(first.status).toBe("acquired");
      if (first.status !== "acquired") throw new Error("unreachable: expected acquired"); // narrows mutexId to string
      const mutexId = first.mutexId;

      // Simulate a crash + re-claim of the SAME job (mutex_id is now persisted, lease still held by US).
      await sql`UPDATE core.review_jobs
          SET state = 'leased', leased_until = now() - interval '1 second'
        WHERE job_id = ${job1.job_id}`.execute(db);
      const job2 = await repo.claim({ owner: "owner-c2", leaseMs: 60_000, maxRuntimeMs: 600_000 });
      expect(job2).not.toBeNull();
      expect(job2!.mutex_id).toBe(mutexId);

      // Re-run: ownership validation passes → reuse the SAME mutex (no fresh competing acquire).
      const reused = await acquireOrReuseMutex({ payload: payloadFor(seed), job: job2!, repo, pool, clock });
      expect(reused.status).toBe("reused");
      expect(reused.mutexId).toBe(mutexId);
      // STILL exactly one live row (no second acquire happened) and it is the SAME mutex.
      expect(await liveRowCount(seed)).toBe(1);
      // The reused lease is renewable by us (live, ours) — the reuse path proved reclaimable-by-us.
      const renewed = await withMutexTransaction(pool, (client) =>
        renewPrReviewMutexLease({ client, installationId: seed.installationId, mutexId }),
      );
      expect(renewed).toBe(true);
    } finally {
      await cleanup(seed);
    }
  });
});

describeDb("acquireOrReuseMutex — mismatch / released re-acquires fresh (F6)", () => {
  it("(d-released) job.mutex_id points at a RELEASED row → re-acquire fresh + persist the new id", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant(44);
    try {
      const job1 = await enqueueAndClaim(repo, seed, "owner-d1");
      const first = await acquireOrReuseMutex({ payload: payloadFor(seed), job: job1, repo, pool, clock });
      expect(first.status).toBe("acquired");
      const staleMutexId = first.mutexId;

      // Release the persisted mutex (a janitor sweep / prior release) — ownership validation must FAIL.
      await sql`UPDATE core.pr_review_mutex SET released_at = now() WHERE mutex_id = ${staleMutexId}`.execute(db);

      const job2 = await repo.getById(job1.job_id);
      const res = await acquireOrReuseMutex({ payload: payloadFor(seed), job: job2!, repo, pool, clock });

      expect(res.status).toBe("acquired"); // a FRESH acquire, not a reuse
      expect(res.mutexId).not.toBe(staleMutexId);
      // The job row now carries the NEW mutex id; exactly one live row.
      expect((await repo.getById(job1.job_id))!.mutex_id).toBe(res.mutexId);
      expect(await liveRowCount(seed)).toBe(1);
    } finally {
      await cleanup(seed);
    }
  });

  it("(d-mismatch) job.mutex_id points at a mutex for a DIFFERENT (install/repo/pr) → re-acquire fresh", async () => {
    const repo = new ReviewJobsRepo(db);
    const seedA = await seedTenant(55);
    const seedB = await seedTenant(56); // a different PR (same tenant, different pr_number) with its own live mutex
    try {
      // Acquire a live mutex for seedB.
      const otherMutex = await withMutexTransaction(pool, (client) =>
        acquirePrReviewMutex({
          client,
          installationId: seedB.installationId,
          repositoryId: seedB.repositoryId,
          prNumber: seedB.prNumber,
          holderWorkflowId: "wf-other-pr",
          clock,
        }),
      );
      expect(otherMutex.acquired).toBe(true);

      // Point the seedA job at seedB's mutex (a mismatched mutex_id — the FK still holds since the row exists).
      const job = await enqueueAndClaim(repo, seedA, "owner-d2");
      await sql`UPDATE core.review_jobs SET mutex_id = ${otherMutex.mutexId} WHERE job_id = ${job.job_id}`.execute(db);
      const job2 = await repo.getById(job.job_id);
      expect(job2!.mutex_id).toBe(otherMutex.mutexId);

      // Ownership validation: the referenced mutex is for seedB's PR, NOT seedA's payload → re-acquire fresh.
      const res = await acquireOrReuseMutex({ payload: payloadFor(seedA), job: job2!, repo, pool, clock });
      expect(res.status).toBe("acquired");
      expect(res.mutexId).not.toBe(otherMutex.mutexId);
      // seedA now has its OWN live mutex; seedB's is untouched.
      expect((await repo.getById(job.job_id))!.mutex_id).toBe(res.mutexId);
      expect(await liveRowCount(seedA)).toBe(1);
      expect(await liveRowCount(seedB)).toBe(1);
    } finally {
      await cleanup(seedA);
      await cleanup(seedB);
    }
  });

  it("(d-mismatch-busy) mismatched mutex_id AND a FOREIGN live lease holds our PR → busy", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant(66);
    try {
      // Our PR is held by a FOREIGN execution.
      const foreign = await withMutexTransaction(pool, (client) =>
        acquirePrReviewMutex({
          client,
          installationId: seed.installationId,
          repositoryId: seed.repositoryId,
          prNumber: seed.prNumber,
          holderWorkflowId: "wf-foreign-busy",
          clock,
        }),
      );
      expect(foreign.acquired).toBe(true);

      // The job carries a RELEASED (stale) mutex_id — ownership fails → fall through to a fresh acquire,
      // which finds the foreign live lease → busy.
      const job = await enqueueAndClaim(repo, seed, "owner-d3");
      const staleId = randomUUID();
      // A released mutex row for a totally different PR, just to give mutex_id a real FK target.
      const stale = await sql<{ mutex_id: string }>`INSERT INTO core.pr_review_mutex
          (installation_id, repository_id, pr_number, holder_workflow_id, acquired_at, lease_expires_at, released_at)
        VALUES (${seed.installationId}, ${seed.repositoryId}, ${999},
                'wf-stale', now() - interval '2 hours', now() - interval '1 hour', now() - interval '1 hour')
        RETURNING mutex_id`.execute(db);
      void staleId;
      await sql`UPDATE core.review_jobs SET mutex_id = ${stale.rows[0]!.mutex_id} WHERE job_id = ${job.job_id}`.execute(db);
      const job2 = await repo.getById(job.job_id);

      const res = await acquireOrReuseMutex({ payload: payloadFor(seed), job: job2!, repo, pool, clock });
      expect(res.status).toBe("busy");
      expect(res.mutexId).toBeNull();
      expect(await liveRowCount(seed)).toBe(1); // only the foreign holder
    } finally {
      await cleanup(seed);
    }
  });
});

/** Read a single mutex row's `released_at` by id (NULL ⇒ still live). Returns `undefined` if the row is gone. */
async function releasedAtFor(mutexId: string): Promise<string | null | undefined> {
  const r = await sql<{ released_at: string | null }>`SELECT released_at FROM core.pr_review_mutex
      WHERE mutex_id = ${mutexId}`.execute(db);
  return r.rows[0]?.released_at;
}

describeDb("acquireOrReuseMutex — fresh acquire whose fenced persist fails (F1: lease stolen between acquire+persist)", () => {
  it("(e) lease STOLEN between the fresh acquire and the fenced persist → RELEASE the mutex + return lease_lost (no stranding)", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant(77);
    try {
      // owner A claims the job (lease_owner='owner-a', a minted attempt_token). This is the legitimate worker.
      const jobA = await enqueueAndClaim(repo, seed, "owner-a");
      expect(jobA.mutex_id ?? null).toBeNull();

      // STEAL the lease BEFORE the acquire path persists: a second worker (owner B) re-claims the job row, so
      // lease_owner/attempt_token no longer match jobA's fence. persistMutexId(jobA.owner, jobA.token) will then
      // affect 0 rows (applied:false) — the exact race F1 describes (lease reclaimed between acquire and persist).
      const newToken = randomUUID();
      await sql`UPDATE core.review_jobs
          SET lease_owner = 'owner-b', attempt_token = ${newToken}
        WHERE job_id = ${jobA.job_id}`.execute(db);

      // owner A runs the acquire path with its now-STALE fence (the in-hand jobA still carries owner-a + old token).
      const res = await acquireOrReuseMutex({ payload: payloadFor(seed), job: jobA, repo, pool, clock });

      // F1: the fresh acquire SUCCEEDED but the fenced persist did NOT — the mutex would be stranded if we
      // returned 'acquired'. Instead we RELEASE the freshly-acquired mutex and report lease_lost (NOT busy —
      // busy would terminal-cancel a review owner B legitimately owns).
      expect(res.status).toBe("lease_lost");
      expect(res.mutexId).toBeNull();

      // The job row carries NO mutex id (the fenced persist never landed under owner A's stale token).
      expect((await repo.getById(jobA.job_id))!.mutex_id ?? null).toBeNull();

      // CRITICAL: no live mutex row is stranded — every row this PR ever had is released (the fresh acquire's
      // row was released by the fix; there is no 30-min PR-blocking window).
      expect(await liveRowCount(seed)).toBe(0);

      // owner B (the legitimate lease holder) can now do its OWN fresh acquire — the mutex was freed, so this
      // is NOT a self-skipped_busy against a stranded foreign row.
      const jobB = (await repo.getById(jobA.job_id))!;
      expect(jobB.lease_owner).toBe("owner-b");
      const resB = await acquireOrReuseMutex({ payload: payloadFor(seed), job: jobB, repo, pool, clock });
      expect(resB.status).toBe("acquired");
      if (resB.status !== "acquired") throw new Error("unreachable: expected acquired");
      // owner B's fresh acquire is now the single live row; its persist landed under owner B's live fence.
      expect(await liveRowCount(seed)).toBe(1);
      expect(jobB.attempt_token).toBe(newToken);
      const releasedB = await releasedAtFor(resB.mutexId);
      expect(releasedB).toBeNull(); // owner B's mutex is LIVE (not released)
      expect((await repo.getById(jobA.job_id))!.mutex_id).toBe(resB.mutexId);
    } finally {
      await cleanup(seed);
    }
  });
});
