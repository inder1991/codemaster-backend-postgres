// test/integration/runner/review_job_shell.integration.test.ts
//
// W5.2 Step 3 (HAPPY PATH): runReviewJob — the non-Temporal review-job shell composes end-to-end.
//
// Enqueue a real payload fixture → run `runOneJob` with `runReviewJob` wired and ALL orchestrate ports +
// the GitHub/LLM/workspace-touching lifecycle activities stubbed at the IN-PROCESS BUNDLE level (counting
// stubs) against :5434 → assert: outcome 'done'; the run lifecycle transitioned (real finalizeReviewRun:
// RUNNING → COMPLETED); the PR mutex acquired by the shell was RELEASED (real releasePrReviewMutexActivity);
// the orchestrate pipeline actually ran (the stub ports were called).
//
// The reusable seed/payload/stub-port/stub-lifecycle/cleanup helpers live in ./_fixtures.ts (the Phase-2
// gate harness) so BOTH this happy path and the G1 abort gates share ONE definition.
//
// DB-gated (describeDb) against the DISPOSABLE Postgres only — NEVER the cluster. The suite-wide beforeEach
// DELETE on core.review_jobs handles the cross-tenant claim() scan (vitest --no-file-parallelism).

import { afterAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { runOneJob } from "#backend/runner/review_job_runner.js";
import { runReviewJob } from "#backend/runner/review_job_shell.js";
import { WallClock } from "#platform/clock.js";

import { seedTenant, payloadFor, cleanup, makeStubPorts, makeStubLifecycle } from "./_fixtures.js";

const clock = new WallClock();

let db: Kysely<unknown>;
let pool: Pool;
if (INTEGRATION_DSN) {
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 6 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
}
afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  if (INTEGRATION_DSN) await sql`DELETE FROM core.review_jobs`.execute(db);
});

describeDb("runReviewJob — happy path (W5.2 Step 3)", () => {
  it("composes end-to-end → outcome 'done'; run → COMPLETED; mutex released; pipeline ran", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant(db, 101);
    try {
      await repo.enqueue({
        runId: seed.runId,
        reviewId: seed.reviewId,
        installationId: seed.installationId,
        payload: payloadFor(seed),
      });

      const calls: Array<string> = [];
      const handler = runReviewJob({
        repo,
        pool,
        dsn: INTEGRATION_DSN!,
        clock,
        // a long renew interval so the loop never fires within the test (the job lease is the clock).
        mutexRenewIntervalS: 999,
        ports: makeStubPorts(calls),
        lifecycle: makeStubLifecycle(calls),
      });

      const res = await runOneJob({
        repo, clock, owner: "shell-w1", leaseS: 5, heartbeatS: 1, maxRuntimeS: 60, handler,
      });

      // (1) the job settled DONE.
      expect(res.outcome).toBe("done");
      const job = await repo.getById(res.jobId!);
      expect(job!.state).toBe("done");

      // (2) the shell acquired + persisted the PR mutex, then RELEASED it in the finally (real release).
      expect(job!.mutex_id).toBeTruthy();
      const mutexRow = await sql<{ released_at: string | null }>`
        SELECT released_at FROM core.pr_review_mutex WHERE mutex_id = ${job!.mutex_id!}`.execute(db);
      expect(mutexRow.rows[0]!.released_at).not.toBeNull();

      // (3) the run lifecycle TRANSITIONED RUNNING → COMPLETED (real finalizeReviewRun).
      const run = await sql<{ lifecycle_state: string }>`
        SELECT lifecycle_state FROM core.review_runs WHERE run_id = ${seed.runId}`.execute(db);
      expect(run.rows[0]!.lifecycle_state).toBe("COMPLETED");

      // (4) the orchestrate pipeline actually ran over the in-process stub ports (clone..post..cleanup) and
      // the shell dispatched the lifecycle activities (allocate → finalize → release).
      expect(calls).toContain("clone");
      expect(calls).toContain("postReview");
      expect(calls).toContain("cleanup");
      expect(calls).toContain("allocateWorkspace");
      expect(calls).toContain("finalizeReviewRun");
      expect(calls).toContain("releaseMutex");
      expect(calls).toContain("releaseWorkspace");
    } finally {
      await cleanup(db, seed);
    }
  });
});

// ─── CS8 (C4/L12): structured degradation logging — a degraded review is VISIBLE in logs ─────────
// Pre-CS8 the shell hardcoded a discard StageLogger (`void msg`), and recordStage no-ops outside a
// Temporal workflow context — so in the Postgres runner a degraded stage emitted NOTHING anywhere.
// The shell must bind the job's correlation context (run_id / installation_id / head_sha / repo /
// trace_id) into a structured logger whose SINK is injectable (production default: pino), and the
// degradation WARN must arrive as a structured record, not a string to be regex-mined.
describeDb("runReviewJob — structured degradation logging (CS8)", () => {
  it("a degraded stage emits ONE structured record on the injected logSink with the full correlation context", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant(db, 117);
    try {
      await repo.enqueue({
        runId: seed.runId,
        reviewId: seed.reviewId,
        installationId: seed.installationId,
        payload: payloadFor(seed),
      });

      const calls: Array<string> = [];
      const records: Array<Record<string, unknown>> = [];
      const handler = runReviewJob({
        repo,
        pool,
        dsn: INTEGRATION_DSN!,
        clock,
        mutexRenewIntervalS: 999,
        ports: makeStubPorts(calls, {
          persistReviewFindings: async () => {
            throw new Error("persist blew up (CS8 fail-soft fixture)");
          },
        }),
        lifecycle: makeStubLifecycle(calls),
        logSink: (record) => {
          records.push(record as unknown as Record<string, unknown>);
        },
      });

      const res = await runOneJob({
        repo, clock, owner: "cs8-w1", leaseS: 5, heartbeatS: 1, maxRuntimeS: 60, handler,
      });

      // Fail-soft unchanged: the degraded stage does NOT fail the review.
      expect(res.outcome).toBe("done");

      // The degradation is no longer silently discarded: ONE structured record for the stage,
      // carrying every correlation key an operator pivots on.
      const degraded = records.filter((r) => r.stage === "persist_findings");
      expect(degraded).toHaveLength(1);
      const rec = degraded[0]!;
      expect(rec.event).toBe("review.stage_degraded");
      expect(rec.outcome).toBe("degraded");
      expect(rec.run_id).toBe(seed.runId);
      expect(rec.installation_id).toBe(seed.installationId);
      expect(rec.head_sha).toBe("0".repeat(40));
      expect(rec.repo).toBe("acme/widgets");
      expect(rec.trace_id).toBeNull(); // OTel trace capture is deferred — the field is carried, null
      expect(rec.error_class).toBe("Error");
      expect(String(rec.msg)).toContain("persist_findings failed");
    } finally {
      await cleanup(db, seed);
    }
  });
});
