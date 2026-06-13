/**
 * Integration test for `reviewRunReaperActivity` — REAL de-stubbed port of the frozen Python
 * `@activity.defn review_run_reaper_activity`
 * (vendor/codemaster-py/codemaster/activities/review_run_reaper.py), against a DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise. Every test scopes its seeded rows to
 * a UNIQUE random installation_id and DELETEs them in a `finally` (respecting FK order).
 *
 * Coverage (the activity's observable behaviour — the CTE UPDATE … RETURNING + LEFT JOIN audit fan-out):
 *   (A) RUNNING run started 2h ago, review→repo present → REAPED (CANCELLED, cancel_reason='timeout',
 *       cancelled_at set, completed_at still NULL) + EXACTLY ONE audit row review_run.reaped.
 *   (B) RUNNING run started now() (recent, inside the stale window) → PRESERVED (still RUNNING, no audit).
 *   (C) COMPLETED run (completed_at set) → PRESERVED (the UPDATE only touches lifecycle_state='RUNNING').
 *   (D) ORPHAN: a RUNNING run started 2h ago whose pull_request_reviews.repo_id matches NO
 *       core.repositories.github_repo_id → REAPED (CANCELLED) but NO audit row (LEFT JOIN → NULL
 *       installation_id → warn+skip; one orphan must NOT roll back the whole sweep).
 *
 * Counters: result.scanned === result.reaped === (# rows the CTE UPDATE flipped) = the A + D runs in
 * this test's tenant. NOTE: the reaper UPDATE is CROSS-TENANT (no installation_id filter — Python
 * @privileged_path), so a parallel run could flip other tenants' rows; this suite therefore runs with
 * --no-file-parallelism and asserts PER-RUN state + per-tenant audit fan-out rather than the global
 * scanned/reaped totals' exact value — it asserts scanned===reaped and that BOTH this tenant's stale
 * runs are present in the swept set via their on-disk CANCELLED state.
 */

import { createHash, randomInt } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { reviewRunReaperActivity } from "#backend/activities/review_run_reaper.activity.js";

import {
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";

import { getPool, disposePool } from "#platform/db/database.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;

if (INTEGRATION_DSN) {
  pool = getPool(INTEGRATION_DSN);
}

/** Install a deterministic dev key registry so the audit before/after encryption has a key (no Vault). */
beforeAll(() => {
  const reg = new KeyRegistry();
  reg.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(0x42)]]) }));
  setAuditKeyRegistry(reg);
});

afterAll(async () => {
  resetAuditKeyRegistryForTesting();
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

/** Deterministic-enough RFC4122 v4 UUID for test fixtures (NOT security-sensitive). */
function newUuid(): string {
  const h = createHash("sha1")
    .update(Buffer.from(`${process.hrtime.bigint()}-${randomInt(0, 1 << 30)}`, "utf-8"))
    .digest();
  const b = Buffer.from(h.subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x40, 6); // version 4
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const hx = b.toString("hex");
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20, 32)}`;
}

function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type RunSeed = {
  reviewId: string;
  runId: string;
  /** The github_repo_id the pull_request_reviews row points at (its `repo_id`). For the orphan case
   *  this is a value that has NO matching core.repositories row, so the reaper's LEFT JOIN misses. */
  repoIdRef: number;
};

/**
 * Seed one full run chain under a shared installation. `linkRepo=true` inserts a core.repositories row
 * whose github_repo_id the pull_request_reviews row references (so the LEFT JOIN resolves installation_id);
 * `linkRepo=false` makes the run an ORPHAN (the repo_id references no repositories row → NULL installation).
 *
 * `lifecycleState` + `startedAtSql` drive the staleness fixture. Terminal states (COMPLETED here) stamp the
 * matching biconditional terminal timestamp column so the AD-7 CHECK passes (ck_review_runs_completed_at_present).
 */
async function seedRun(args: {
  installationId: string;
  lifecycleState: string;
  startedAtSql: string;
  linkRepo: boolean;
}): Promise<RunSeed> {
  const reviewId = newUuid();
  const runId = newUuid();
  const repoIdRef = uniqueBigint();
  const prNumber = (uniqueBigint() % 9999) + 1;

  if (args.linkRepo) {
    await pool.query(
      `INSERT INTO core.repositories
         (installation_id, github_repo_id, full_name, default_branch, enabled)
       VALUES ($1, $2, $3, 'main', true)`,
      [args.installationId, repoIdRef, `octo/repo-${repoIdRef}`],
    );
  }
  await pool.query(
    `INSERT INTO core.pull_request_reviews
       (review_id, provider, repo_id, pr_number, provider_pr_id, status, current_run_id)
     VALUES ($1, 'github', $2, $3, $4, 'open', NULL)`,
    [reviewId, repoIdRef, prNumber, `pr-${repoIdRef}-${prNumber}`],
  );

  // COMPLETED needs completed_at present (ck_review_runs_completed_at_present); RUNNING leaves it NULL.
  if (args.lifecycleState === "COMPLETED") {
    await pool.query(
      `INSERT INTO core.review_runs
         (run_id, review_id, trigger_type, lifecycle_state, started_at, completed_at)
       VALUES ($1, $2, 'pr_opened', $3, ${args.startedAtSql}, now())`,
      [runId, reviewId, args.lifecycleState],
    );
  } else {
    await pool.query(
      `INSERT INTO core.review_runs
         (run_id, review_id, trigger_type, lifecycle_state, started_at)
       VALUES ($1, $2, 'pr_opened', $3, ${args.startedAtSql})`,
      [runId, reviewId, args.lifecycleState],
    );
  }
  return { reviewId, runId, repoIdRef };
}

/** Seed the installation row the audit FK / tenancy needs. */
async function seedInstallation(installationId: string): Promise<void> {
  await pool.query(
    `INSERT INTO core.installations
       (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, uniqueBigint(), `acct-${installationId.slice(0, 8)}`],
  );
}

/**
 * Seed ONE core.review_jobs row for a run in the given `state`, with `leased_until` set from `leasedUntilSql`.
 * `state='leased'` + a FUTURE `leased_until` models a LIVE job: the gate-④ `NOT EXISTS` predicate (state IN
 * ('ready','leased')) must shield the run from the age-sweep reaper while this row exists. NOT NULL columns
 * `payload`/`payload_sha256` (migration 0037, no DB default) are stamped with inert placeholders — the reaper
 * predicate reads neither; only `run_id` + `state` are load-bearing. The `payload_sha256` placeholder MUST be
 * 64 lowercase hex chars to satisfy migration 0038's `ck_review_jobs_payload_sha256_hex` CHECK. Returns the
 * job_id for later dead-letter.
 */
async function seedReviewJob(args: {
  runId: string;
  reviewId: string;
  installationId: string;
  state: string;
  leasedUntilSql: string;
}): Promise<string> {
  const jobId = newUuid();
  await pool.query(
    `INSERT INTO core.review_jobs
       (job_id, run_id, review_id, installation_id, state, leased_until, payload, payload_sha256)
     VALUES ($1, $2, $3, $4, $5, ${args.leasedUntilSql}, '{}'::jsonb, repeat('0', 64))`,
    [jobId, args.runId, args.reviewId, args.installationId, args.state],
  );
  return jobId;
}

/** Tear down a tenant's seeded rows in FK order: review_jobs → review_runs → pull_request_reviews →
 *  repositories → audit_events → installations. (review_jobs.run_id FK → review_runs, so jobs go FIRST;
 *  review_runs.review_id FK is ON DELETE RESTRICT, so runs precede pull_request_reviews.) */
async function cleanup(installationId: string, runs: ReadonlyArray<RunSeed>): Promise<void> {
  for (const r of runs) {
    await pool.query(`DELETE FROM core.review_jobs WHERE run_id = $1`, [r.runId]);
  }
  for (const r of runs) {
    await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [r.runId]);
  }
  for (const r of runs) {
    await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [r.reviewId]);
    await pool.query(`DELETE FROM core.repositories WHERE github_repo_id = $1`, [r.repoIdRef]);
  }
  await pool.query(`DELETE FROM audit.audit_events WHERE installation_id = $1`, [installationId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [installationId]);
}

type RunRow = {
  lifecycle_state: string;
  cancel_reason: string | null;
  cancelled_at: Date | null;
  completed_at: Date | null;
};

async function runRow(runId: string): Promise<RunRow> {
  const r = await pool.query<RunRow>(
    `SELECT lifecycle_state, cancel_reason, cancelled_at, completed_at
       FROM core.review_runs WHERE run_id = $1`,
    [runId],
  );
  return r.rows[0]!;
}

/** Audit rows for a given target run_id, scoped to the tenant. */
async function reapedAuditRows(
  installationId: string,
  runId: string,
): Promise<ReadonlyArray<{ action: string; actor_kind: string; target_kind: string }>> {
  const r = await pool.query<{ action: string; actor_kind: string; target_kind: string }>(
    `SELECT action, actor_kind, target_kind
       FROM audit.audit_events
      WHERE installation_id = $1 AND action = 'review_run.reaped' AND target_id = $2`,
    [installationId, runId],
  );
  return r.rows;
}

describeDb("reviewRunReaperActivity (integration, disposable PG)", () => {
  it("reaps stale RUNNING runs (incl. orphans), preserves recent/terminal runs, audits only non-orphans", async () => {
    const installationId = newUuid();
    await seedInstallation(installationId);

    // (A) stale RUNNING, repo present → reaped + audited.
    const a = await seedRun({
      installationId,
      lifecycleState: "RUNNING",
      startedAtSql: "now() - interval '2 hours'",
      linkRepo: true,
    });
    // (B) recent RUNNING → preserved.
    const b = await seedRun({
      installationId,
      lifecycleState: "RUNNING",
      startedAtSql: "now()",
      linkRepo: true,
    });
    // (C) COMPLETED (terminal) → preserved.
    const c = await seedRun({
      installationId,
      lifecycleState: "COMPLETED",
      startedAtSql: "now() - interval '2 hours'",
      linkRepo: true,
    });
    // (D) ORPHAN stale RUNNING (repo_id references no repositories row) → reaped, NO audit.
    const d = await seedRun({
      installationId,
      lifecycleState: "RUNNING",
      startedAtSql: "now() - interval '2 hours'",
      linkRepo: false,
    });

    try {
      // Inside describeDb the DSN is always set (the suite SKIPS otherwise); assert non-null so the
      // optional `dsn?: string` is satisfied under exactOptionalPropertyTypes.
      const result = await reviewRunReaperActivity({
        dsn: INTEGRATION_DSN!,
        staleAfterSeconds: 3600,
      });

      // Counters: scanned === reaped (every flipped row is counted on both axes). The reaper is
      // cross-tenant, so the absolute total may include other tenants' stale rows under parallelism —
      // we assert the equality invariant + that it counted at least this tenant's two stale runs.
      expect(result.scanned).toBe(result.reaped);
      expect(result.reaped).toBeGreaterThanOrEqual(2);
      expect(result.schema_version).toBe(1);

      // (A) reaped to CANCELLED/timeout; cancelled_at set; completed_at still NULL.
      const ra = await runRow(a.runId);
      expect(ra.lifecycle_state).toBe("CANCELLED");
      expect(ra.cancel_reason).toBe("timeout");
      expect(ra.cancelled_at).not.toBeNull();
      expect(ra.completed_at).toBeNull();

      // (D) orphan reaped to CANCELLED/timeout as well (the CTE UPDATE applied regardless of the LEFT JOIN).
      const rd = await runRow(d.runId);
      expect(rd.lifecycle_state).toBe("CANCELLED");
      expect(rd.cancel_reason).toBe("timeout");
      expect(rd.cancelled_at).not.toBeNull();
      expect(rd.completed_at).toBeNull();

      // (B) recent RUNNING preserved (inside the stale window).
      const rb = await runRow(b.runId);
      expect(rb.lifecycle_state).toBe("RUNNING");
      expect(rb.cancel_reason).toBeNull();
      expect(rb.cancelled_at).toBeNull();

      // (C) COMPLETED preserved (the UPDATE only matches lifecycle_state='RUNNING').
      const rc = await runRow(c.runId);
      expect(rc.lifecycle_state).toBe("COMPLETED");
      expect(rc.cancel_reason).toBeNull();
      expect(rc.cancelled_at).toBeNull();

      // Audit fan-out: A (non-orphan reaped) → exactly ONE review_run.reaped row; D (orphan) → ZERO.
      const auditA = await reapedAuditRows(installationId, a.runId);
      expect(auditA.length).toBe(1);
      expect(auditA[0]!.actor_kind).toBe("system");
      expect(auditA[0]!.target_kind).toBe("review_run");

      const auditD = await reapedAuditRows(installationId, d.runId);
      expect(auditD.length).toBe(0);

      // B and C never reaped → no audit rows either.
      expect((await reapedAuditRows(installationId, b.runId)).length).toBe(0);
      expect((await reapedAuditRows(installationId, c.runId)).length).toBe(0);
    } finally {
      await cleanup(installationId, [a, b, c, d]);
    }
  });

  it("OM7/W3.5: the reap is BOUNDED — at most sweepLimit runs per invocation; the next tick continues", async () => {
    // Pre-OM7 the CTE UPDATE flipped EVERY stale run in one unbounded transaction with per-row
    // audit INSERTs — a post-incident backlog could run past the job ceiling and roll back whole:
    // zero progress, same set retried. Bounded per-invocation work guarantees forward progress.
    const installationId = newUuid();
    await seedInstallation(installationId);
    const runs = [] as Array<Awaited<ReturnType<typeof seedRun>>>;
    for (let i = 0; i < 3; i += 1) {
      runs.push(
        await seedRun({
          installationId,
          lifecycleState: "RUNNING",
          startedAtSql: "now() - interval '2 hours'",
          linkRepo: true,
        }),
      );
    }
    try {
      const first = await reviewRunReaperActivity({
        dsn: INTEGRATION_DSN!,
        staleAfterSeconds: 3600,
        sweepLimit: 2,
      });
      expect(first.reaped).toBe(2);
      const second = await reviewRunReaperActivity({
        dsn: INTEGRATION_DSN!,
        staleAfterSeconds: 3600,
        sweepLimit: 2,
      });
      expect(second.reaped).toBeGreaterThanOrEqual(1); // the next tick drains the remainder
      for (const r of runs) {
        expect((await runRow(r.runId)).lifecycle_state).toBe("CANCELLED");
      }
    } finally {
      await cleanup(installationId, runs);
    }
  });

  it("does NOT reap a stale RUNNING run while a LIVE review_jobs row (state IN ready|leased) shields it [D3, gate ④]", async () => {
    const installationId = newUuid();
    await seedInstallation(installationId);

    // A stale RUNNING run (started 2h ago, well past the 3600s threshold) that WOULD be reaped on age alone.
    const run = await seedRun({
      installationId,
      lifecycleState: "RUNNING",
      startedAtSql: "now() - interval '2 hours'",
      linkRepo: true,
    });
    // A LIVE job for that run: state='leased' with leased_until in the FUTURE. The gate-④ NOT EXISTS predicate
    // (state IN ('ready','leased')) must shield the run from the age-sweep so the reaper never fights a live job.
    const jobId = await seedReviewJob({
      runId: run.runId,
      reviewId: run.reviewId,
      installationId,
      state: "leased",
      leasedUntilSql: "now() + interval '1 hour'",
    });

    try {
      // First sweep: the live job shields the run → it stays RUNNING (NOT reaped) and emits NO audit row.
      await reviewRunReaperActivity({ dsn: INTEGRATION_DSN!, staleAfterSeconds: 3600 });

      const shielded = await runRow(run.runId);
      expect(shielded.lifecycle_state).toBe("RUNNING");
      expect(shielded.cancel_reason).toBeNull();
      expect(shielded.cancelled_at).toBeNull();
      expect((await reapedAuditRows(installationId, run.runId)).length).toBe(0);

      // Dead-letter the job (state='dead' falls OUT of the NOT EXISTS predicate's ('ready','leased') set), so the
      // run is no longer shielded.
      // tenant:exempt reason=test-dead-letter-job-by-pk follow_up=FOLLOW-UP-gf3-error-mode
      await pool.query(`UPDATE core.review_jobs SET state = 'dead' WHERE job_id = $1`, [jobId]);

      // Second sweep: no live job → the stale RUNNING run is now reaped to CANCELLED/timeout + audited once.
      await reviewRunReaperActivity({ dsn: INTEGRATION_DSN!, staleAfterSeconds: 3600 });

      const reaped = await runRow(run.runId);
      expect(reaped.lifecycle_state).toBe("CANCELLED");
      expect(reaped.cancel_reason).toBe("timeout");
      expect(reaped.cancelled_at).not.toBeNull();
      expect(reaped.completed_at).toBeNull();
      expect((await reapedAuditRows(installationId, run.runId)).length).toBe(1);
    } finally {
      await cleanup(installationId, [run]);
    }
  });

  it("releases the PR mutex held by a reaped run's job, in lockstep (W3.3/OH9 — invariant: dead/cancelled ⇒ no live mutex)", async () => {
    const installationId = newUuid();
    await seedInstallation(installationId);
    // A stale RUNNING run whose driving job has already gone DEAD (so the gate-④ NOT-EXISTS shield lets the
    // reaper cancel the run) but whose PR mutex is STILL live (released_at IS NULL).
    const run = await seedRun({
      installationId,
      lifecycleState: "RUNNING",
      startedAtSql: "now() - interval '2 hours'",
      linkRepo: true,
    });
    // The mutex.repository_id FK → core.repositories.repository_id (uuid PK), so use the repositories row
    // seedRun(linkRepo:true) created for this run's github_repo_id.
    const repoRow = await pool.query<{ repository_id: string }>(
      `SELECT repository_id FROM core.repositories WHERE github_repo_id = $1`,
      [run.repoIdRef],
    );
    const repositoryId = repoRow.rows[0]!.repository_id;
    const mutexId = newUuid();
    await pool.query(
      `INSERT INTO core.pr_review_mutex
         (mutex_id, installation_id, repository_id, pr_number, holder_workflow_id, acquired_at, lease_expires_at)
       VALUES ($1, $2, $3, $4, $5, now(), now() + interval '30 minutes')`,
      [mutexId, installationId, repositoryId, (uniqueBigint() % 9999) + 1, run.runId],
    );
    const jobId = newUuid();
    await pool.query(
      `INSERT INTO core.review_jobs
         (job_id, run_id, review_id, installation_id, state, mutex_id, dead_reason, finished_at, payload, payload_sha256)
       VALUES ($1, $2, $3, $4, 'dead', $5, 'exhausted', now(), '{}'::jsonb, repeat('0', 64))`,
      [jobId, run.runId, run.reviewId, installationId, mutexId],
    );
    try {
      // BEFORE the fix: the reaper cancels the run but leaves the mutex released_at IS NULL → the invariant
      // "dead/cancelled ⇒ no live mutex" is violated (the PR's mutex stays live until lease-expiry reclaim).
      await reviewRunReaperActivity({ dsn: INTEGRATION_DSN!, staleAfterSeconds: 3600 });

      expect((await runRow(run.runId)).lifecycle_state).toBe("CANCELLED");
      const mtx = await pool.query<{ released_at: Date | null }>(
        `SELECT released_at FROM core.pr_review_mutex WHERE mutex_id = $1`,
        [mutexId],
      );
      expect(mtx.rows[0]?.released_at).not.toBeNull(); // released in lockstep with the reap
    } finally {
      await pool.query(`DELETE FROM core.review_jobs WHERE job_id = $1`, [jobId]);
      await pool.query(`DELETE FROM core.pr_review_mutex WHERE mutex_id = $1`, [mutexId]);
      await cleanup(installationId, [run]);
    }
  });
});
