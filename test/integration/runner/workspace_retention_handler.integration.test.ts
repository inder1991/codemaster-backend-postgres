// Phase 3e W3e.1: workspace_retention — the FIRST MULTI-STEP Temporal workflow BODY re-implemented as
// an in-process JobHandler (the loop/fail-open orchestration of workspace_retention.workflow.ts; the
// three sweep activities + the release activity are REUSED, not rewritten). The Temporal workflow stays
// in place until Phase 4. Proves:
//   (1) CHAIN PARITY: an enqueued 'workspace_retention' job driven through ONE background cycle
//       composes the THREE steps IN ORDER exactly as the workflow body does — (step 1) the ALLOCATED
//       lease whose worker is dead (seeded core.worker_heartbeats row, last_seen 10m ago) flips
//       ORPHANED, (step 2) the reap loop releases EVERY eligible lease (including the JUST-orphaned
//       one — the within-one-pass orphan→reap→release chain, observable as the WORKSPACE_ORPHANED →
//       WORKSPACE_RELEASE_REQUESTED → WORKSPACE_RELEASED event sequence), and (step 3) the RELEASED
//       row past the 7d retention window is hard-deleted — while an ALLOCATED lease under a LIVE
//       worker is untouched.
//   (2) FAIL-OPEN (the whole point of the per-id reap loop): when ONE releaseWorkspace call fails —
//       a REAL failure, not a stub: a hostile symlink under the workspace root makes path validation
//       throw WorkspaceSecurityViolation, leaving that lease FAILED_CLEANUP — the OTHER eligible
//       leases are STILL released and the handler COMPLETES (the job settles 'done', last_error
//       NULL). The failing workspace_id is minted to sort FIRST in the reap activity's SORTED result,
//       so the released ids prove the loop CONTINUED past the failure (not that it failed after them).
//   (3) The CRON_SCHEDULES registry carries the 'codemaster-workspace-retention' interval entry
//       (every 300s — parity with the Temporal Schedule's ScheduleIntervalSpec(minutes=5);
//       overlap=SKIP falls out of dedup_key = schedule_id).
//
// Determinism note (the W4 suite's proven pattern): the runner cycle runs under a WallClock
// composition (runOneBackgroundJob's hard-timeout race is microtask-ordered under FakeClock); every
// seeded timestamp anchors to the SAME wall clock with margins (10 minutes / 10 days) that dwarf the
// test's runtime, so each fixture lands on the intended side of every sweep cutoff.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { createHash, randomInt, randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { WallClock } from "#platform/clock.js";
import { disposePool } from "#platform/db/database.js";
import {
  runWorkspaceDeadLetterSweepActivity,
  runWorkspaceOrphanSweepActivity,
} from "#backend/activities/workspace_retention.activity.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { runOneBackgroundJob } from "#backend/runner/background_runner.js";
import { CRON_SCHEDULES } from "#backend/runner/cron_schedules.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import { registerCronHandlers } from "#backend/runner/handlers/cron_handlers.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }

afterAll(async () => {
  await db?.destroy();                       // the test's OWN pool
  // The activities resolve getPool/tenantKysely(CODEMASTER_PG_CORE_DSN) — the shared platform pool;
  // dispose it too.
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

// AUTHORIZED DEVIATION (test isolation — same rationale as cron_handlers_daily.integration.test.ts):
// vitest.config.ts shuffles test order, and claim() is a cross-job_type scan over ALL
// core.background_jobs rows — the daily suite's startup test deliberately leaves undrained 'ready'
// rows behind, which this suite's single-cycle drives would otherwise claim instead of their own job.
// Safe because test:integration runs --no-file-parallelism (files never interleave) and the other
// writers clean their own rows.
beforeEach(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.background_jobs`.execute(db);
  }
});

/** Bounded runner args (the daily suite's proven shape): generous ceilings (second-scale sweeps never
 *  graze 300s), single-shot drive (never the infinite loop). */
const RUNNER_ARGS = { owner: "w3e1-cron-test", leaseS: 30, heartbeatS: 5, maxRuntimeS: 300 };

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

/** A v4-shaped UUID whose FIRST 8 hex chars are pinned — controls the lexicographic position in the
 *  reap activity's SORTED workspace_ids (the fail-open test needs the FAILING id to sort FIRST so the
 *  later releases prove the loop continued past the failure). Random tail avoids cross-run collisions. */
function sortableUuid(prefix8: string): string {
  return `${prefix8}-0000-4000-8000-${randomUUID().slice(24)}`;
}

/** A small unique bigint so unique columns never collide across tests. */
function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

/** An instant offset BACKWARD from wall-now (the clock the handler threads into every sweep cutoff). */
function ago(opts: { minutes?: number; days?: number }): Date {
  const ms = (opts.minutes ?? 0) * 60_000 + (opts.days ?? 0) * 86_400_000;
  return new Date(Date.now() - ms);
}

type Seed = {
  installationId: string;
  reviewId: string;
  runId: string;
  workspaceId: string;
};

/** Seed the FK chain a lease + its events require (pull_request_reviews → review_runs), with an
 *  optionally pinned workspace_id (the fail-open test controls reap sort order through it). */
async function seedTenant(workspaceId?: string): Promise<Seed> {
  const installationId = newUuid();
  const reviewId = newUuid();
  const runId = newUuid();
  const repoId = uniqueBigint();
  const prNumber = (uniqueBigint() % 9999) + 1;

  await pool.query(
    `INSERT INTO core.pull_request_reviews
       (review_id, provider, repo_id, pr_number, provider_pr_id, status, current_run_id)
     VALUES ($1, 'github', $2, $3, $4, 'open', NULL)`,
    [reviewId, repoId, prNumber, `pr-${repoId}-${prNumber}`],
  );
  await pool.query(
    `INSERT INTO core.review_runs
       (run_id, review_id, trigger_type, lifecycle_state)
     VALUES ($1, $2, 'pr_opened', 'PENDING')`,
    [runId, reviewId],
  );
  return { installationId, reviewId, runId, workspaceId: workspaceId ?? newUuid() };
}

/** Insert a workspace_lease row directly via raw SQL so the test can place it in any state with
 *  arbitrary (wall-anchored) timestamps — same idiom as the workspace_retention activity suite. */
async function insertLease(
  seed: Seed,
  args: {
    state: string;
    workerId: string;
    orphanCheckAfter: Date;
    releaseRequestedAt?: Date | null;
    releasedAt?: Date | null;
    cleanupAttempts?: number;
    createdAt?: Date;
  },
): Promise<void> {
  const releaseRequestedAt = args.releaseRequestedAt ?? null;
  await pool.query(
    `INSERT INTO core.workspace_leases
       (workspace_id, run_id, review_id, installation_id, state,
        pod_name, pod_namespace, node_name, worker_id,
        orphan_check_after, release_requested_at, release_requested_by, released_at,
        cleanup_attempts, created_at)
     VALUES ($1, $2, $3, $4, $5::core.workspace_lease_state,
             'worker-pod-0', 'codemaster', 'node-a', $6, $7, $8, $9, $10,
             $11, COALESCE($12, now()))`,
    [
      seed.workspaceId,
      seed.runId,
      seed.reviewId,
      seed.installationId,
      args.state,
      args.workerId,
      args.orphanCheckAfter,
      releaseRequestedAt,
      releaseRequestedAt ? "release_workspace_activity" : null,
      args.releasedAt ?? null,
      args.cleanupAttempts ?? 0,
      args.createdAt ?? null,
    ],
  );
}

/** Insert a core.worker_heartbeats row with a given last_seen_at (the orphan sweep's liveness JOIN). */
async function insertHeartbeat(workerId: string, lastSeenAt: Date): Promise<void> {
  await pool.query(
    `INSERT INTO core.worker_heartbeats
       (worker_id, pod_name, pod_namespace, pod_uid, node_name, process_uuid, started_at, last_seen_at)
     VALUES ($1, 'worker-pod-0', 'codemaster', $2, 'node-a', $3, $4, $5)`,
    [workerId, newUuid(), newUuid(), ago({ minutes: 60 }), lastSeenAt],
  );
}

type LeaseRow = {
  state: string;
  released_at: Date | null;
  cleanup_attempts: number;
  last_cleanup_error: string | null;
};

async function leaseRow(workspaceId: string): Promise<LeaseRow | undefined> {
  const r = await pool.query<LeaseRow>(
    `SELECT state, released_at, cleanup_attempts, last_cleanup_error
       FROM core.workspace_leases WHERE workspace_id = $1`,
    [workspaceId],
  );
  return r.rows[0];
}

/** Tear down a tenant's seeded rows in FK order (events + lease + heartbeat first). */
async function cleanupTenant(seed: Seed, workerIds: ReadonlyArray<string> = []): Promise<void> {
  await pool.query(`DELETE FROM audit.workflow_events WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.workspace_leases WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [seed.reviewId]);
  for (const wid of workerIds) {
    await pool.query(`DELETE FROM core.worker_heartbeats WHERE worker_id = $1`, [wid]);
  }
}

/** Build a registry with the cron handlers over the disposable DSN + a tmpdir workspace root (the
 *  release activity's path validation requires the root to EXIST — the env default does not on a dev
 *  box), then drive exactly ONE enqueued 'workspace_retention' job through the runner. */
async function runOneRetentionJob(workspaceRoot: string): Promise<{
  outcome: string;
  jobId: string | undefined;
  settledState: string;
  settledLastError: string | null;
}> {
  const registry = new HandlerRegistry();
  registerCronHandlers(registry, {
    dsn: INTEGRATION_DSN!,
    releaseWorkspaceDeps: { workspaceRoot },
  });
  const repo = new BackgroundJobsRepo(db);
  const jobId = await repo.enqueue({ jobType: "workspace_retention", payload: {} });
  const r = await runOneBackgroundJob({ repo, registry, clock: new WallClock(), ...RUNNER_ARGS });
  const settled = (await repo.getById(jobId))!;
  return { outcome: r.outcome, jobId: r.jobId, settledState: settled.state, settledLastError: settled.last_error };
}

describeDb("workspace_retention handler — multi-step cron on the background-jobs platform (Phase 3e W3e.1)", () => {
  it("(1) CHAIN PARITY: one cycle orphans the dead-worker lease, releases every reap-eligible lease, purges the aged RELEASED row — live-worker lease untouched", async () => {
    // (A) ALLOCATED + dead worker (last_seen 10m > worker_dead_after=5m) + grace elapsed → step 1
    //     flips ORPHANED → step 2 reaps + releases it WITHIN THE SAME PASS.
    const a = await seedTenant();
    const aWorker = `dead-${newUuid()}`;
    // (B) already-ORPHANED → step 2 releases it.
    const b = await seedTenant();
    // (C) RELEASED 10 days ago (> released_lease_retention=7d) → step 3 hard-deletes it.
    const c = await seedTenant();
    // (D) control: ALLOCATED + LIVE worker → untouched by every step.
    const d = await seedTenant();
    const dWorker = `live-${newUuid()}`;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cm-ws-cron-"));

    try {
      await insertHeartbeat(aWorker, ago({ minutes: 10 }));
      await insertHeartbeat(dWorker, ago({ minutes: 0 }));
      await insertLease(a, { state: "ALLOCATED", workerId: aWorker, orphanCheckAfter: ago({ minutes: 60 }) });
      await insertLease(b, { state: "ORPHANED", workerId: `gone-${newUuid()}`, orphanCheckAfter: ago({ minutes: 60 }) });
      await insertLease(c, {
        state: "RELEASED",
        workerId: `gone-${newUuid()}`,
        orphanCheckAfter: ago({ minutes: 60 }),
        releaseRequestedAt: ago({ days: 11 }),
        releasedAt: ago({ days: 10 }),
      });
      await insertLease(d, { state: "ALLOCATED", workerId: dWorker, orphanCheckAfter: ago({ minutes: 60 }) });

      const r = await runOneRetentionJob(root);
      expect(r.outcome).toBe("done");
      expect(r.settledState).toBe("done");
      expect(r.settledLastError).toBeNull();

      // (A) the full within-one-pass chain: ALLOCATED → ORPHANED (step 1) → RELEASED (step 2)…
      expect((await leaseRow(a.workspaceId))!.state).toBe("RELEASED");
      expect((await leaseRow(a.workspaceId))!.released_at).not.toBeNull();
      // …observable as the ordered WORKSPACE_* event sequence the two reused primitives emit.
      const aEvents = await pool.query<{ event_type: string }>(
        `SELECT event_type FROM audit.workflow_events WHERE run_id = $1 ORDER BY sequence_no`,
        [a.runId],
      );
      expect(aEvents.rows.map((e) => e.event_type)).toEqual([
        "WORKSPACE_ORPHANED",
        "WORKSPACE_RELEASE_REQUESTED",
        "WORKSPACE_RELEASED",
      ]);
      // (B) the already-ORPHANED lease was released too.
      expect((await leaseRow(b.workspaceId))!.state).toBe("RELEASED");
      // (C) the aged RELEASED row is GONE (step 3 hard-delete).
      expect(await leaseRow(c.workspaceId)).toBeUndefined();
      // (D) the live-worker ALLOCATED lease is untouched.
      expect((await leaseRow(d.workspaceId))!.state).toBe("ALLOCATED");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await cleanupTenant(a, [aWorker]);
      await cleanupTenant(b);
      await cleanupTenant(c);
      await cleanupTenant(d, [dWorker]);
    }
  });

  it("(2) FAIL-OPEN: ONE failing releaseWorkspace (hostile symlink → security violation, sorts FIRST) does NOT poison the sweep — the others release, the job settles 'done'", async () => {
    // The failing id sorts FIRST in the reap activity's sorted result; the good ids sort AFTER it, so
    // their RELEASED end-state proves the loop CONTINUED past the failure (per-id fail-open) rather
    // than failing after them.
    const bad = await seedTenant(sortableUuid("00000000"));
    const good1 = await seedTenant(sortableUuid("aaaaaaaa"));
    const good2 = await seedTenant(sortableUuid("ffffffff"));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cm-ws-cron-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cm-ws-outside-"));

    try {
      // Hostile symlink: <root>/installations/<bad.installationId> → a dir OUTSIDE the root. The bad
      // lease's cleanup path resolves through it, escapes the root, and releaseWorkspace throws a REAL
      // WorkspaceSecurityViolation after flipping the lease to FAILED_CLEANUP — no stubbing.
      await fs.mkdir(path.join(root, "installations"), { recursive: true });
      await fs.symlink(outside, path.join(root, "installations", bad.installationId));

      const gone = `gone-${newUuid()}`;
      await insertLease(bad, { state: "ORPHANED", workerId: gone, orphanCheckAfter: ago({ minutes: 60 }) });
      await insertLease(good1, { state: "ORPHANED", workerId: gone, orphanCheckAfter: ago({ minutes: 60 }) });
      await insertLease(good2, {
        state: "RELEASE_REQUESTED", // the other reap-eligibility branch: aged past release_grace=5m
        workerId: gone,
        orphanCheckAfter: ago({ minutes: 60 }),
        releaseRequestedAt: ago({ minutes: 10 }),
      });

      const r = await runOneRetentionJob(root);

      // The handler COMPLETED despite the failing release: the job settles 'done', not failed/dead.
      expect(r.outcome).toBe("done");
      expect(r.settledState).toBe("done");
      expect(r.settledLastError).toBeNull();

      // The failing lease is parked FAILED_CLEANUP for the next sweep's backoff window — exactly the
      // workflow body's invariant (releaseWorkspace is idempotent; the janitor re-picks it up).
      const badRow = (await leaseRow(bad.workspaceId))!;
      expect(badRow.state).toBe("FAILED_CLEANUP");
      expect(badRow.cleanup_attempts).toBe(1);
      expect(badRow.last_cleanup_error).toBe("security_violation");

      // The OTHER ids — both sorting AFTER the failed one — were still released.
      expect((await leaseRow(good1.workspaceId))!.state).toBe("RELEASED");
      expect((await leaseRow(good2.workspaceId))!.state).toBe("RELEASED");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
      await cleanupTenant(bad);
      await cleanupTenant(good1);
      await cleanupTenant(good2);
    }
  });

  it("(3) OH6/W3.5: the dead-letter sweep counts STUCK FAILED_CLEANUP + AGED ORPHANED leases (the rows the reap can never recover)", async () => {
    // Reap deliberately stops at cleanup_attempts >= 5 and a healthy cycle reaps ORPHANED rows
    // promptly — so a FAILED_CLEANUP row at the attempt ceiling and an ORPHANED row still sitting
    // there a day after allocation are BOTH dead-lettered disk leaks nothing re-drives. Pre-OH6 the
    // code comment promised an operator alert that never existed: the rows fell out of every sweep
    // silently. The sweep makes them countable + WARN-visible.
    const stuck = await seedTenant();
    const agedOrphan = await seedTenant();
    const freshFailed = await seedTenant();
    const freshOrphan = await seedTenant();
    try {
      await insertLease(stuck, {
        state: "FAILED_CLEANUP", workerId: `w-${stuck.workspaceId.slice(0, 8)}`,
        orphanCheckAfter: ago({ days: 2 }), cleanupAttempts: 5, createdAt: ago({ days: 2 }),
      });
      await insertLease(agedOrphan, {
        state: "ORPHANED", workerId: `w-${agedOrphan.workspaceId.slice(0, 8)}`,
        orphanCheckAfter: ago({ days: 2 }), createdAt: ago({ days: 2 }),
      });
      await insertLease(freshFailed, {
        state: "FAILED_CLEANUP", workerId: `w-${freshFailed.workspaceId.slice(0, 8)}`,
        orphanCheckAfter: ago({ minutes: 30 }), cleanupAttempts: 2, createdAt: ago({ minutes: 30 }),
      });
      await insertLease(freshOrphan, {
        state: "ORPHANED", workerId: `w-${freshOrphan.workspaceId.slice(0, 8)}`,
        orphanCheckAfter: ago({ minutes: 5 }), createdAt: ago({ minutes: 5 }),
      });

      const result = await runWorkspaceDeadLetterSweepActivity({ dsn: INTEGRATION_DSN! });
      // The fixtures are additive over whatever other suites left behind — assert at-least + exact
      // membership via a second scoped query.
      expect(result.failed_cleanup_stuck).toBeGreaterThanOrEqual(1);
      expect(result.orphaned_aged).toBeGreaterThanOrEqual(1);

      // Scoped truth: OUR stuck + aged rows are counted; the fresh ones are NOT.
      const scoped = await runWorkspaceDeadLetterSweepActivity({ dsn: INTEGRATION_DSN! });
      expect(scoped.failed_cleanup_stuck).toBe(result.failed_cleanup_stuck); // idempotent read
      const fresh = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM core.workspace_leases
          WHERE workspace_id = ANY($1::uuid[])
            AND ((state = 'FAILED_CLEANUP' AND cleanup_attempts >= 5)
              OR (state = 'ORPHANED' AND created_at < now() - interval '24 hours'))`,
        [[freshFailed.workspaceId, freshOrphan.workspaceId]],
      );
      expect(Number(fresh.rows[0]!.n)).toBe(0);
    } finally {
      await cleanupTenant(stuck);
      await cleanupTenant(agedOrphan);
      await cleanupTenant(freshFailed);
      await cleanupTenant(freshOrphan);
    }
  });

  it("(4) OH5/W3.5: the orphan sweep WARNs that dead-worker reclamation is OFFLINE when worker_heartbeats is empty", async () => {
    // The heartbeat PRODUCER is unported — in production the orphan sweep's JOIN matches zero rows
    // and reports a falsely-green orphaned_count=0 forever. Until the producer lands, the sweep must
    // SAY SO instead of silently no-opping (OH5's WARN-metric posture).
    // Deterministic empty-table precondition (worker_heartbeats has no FKs; other suites clean their
    // own rows — same authorized-deviation rationale as the beforeEach wipe).
    await pool.query(`DELETE FROM core.worker_heartbeats`);
    const warns: Array<string> = [];
    const origWarn = console.warn.bind(console);
    console.warn = (...args: Array<unknown>): void => {
      warns.push(args.map(String).join(" "));
      origWarn(...args);
    };
    try {
      const result = await runWorkspaceOrphanSweepActivity({ dsn: INTEGRATION_DSN! });
      expect(result.orphaned_count).toBe(0);
      expect(warns.some((w) => w.includes("workspace_orphan_sweep.no_heartbeat_producer"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });
});

// ─── CRON_SCHEDULES entry (pure — no DB) ───────────────────────────────────────────────────────────
describe("CRON_SCHEDULES (Phase 3e W3e.1 entry)", () => {
  it("carries the workspace_retention interval entry with the Temporal-parity cadence (every 5 minutes)", () => {
    // arrayContaining (not toEqual): this suite owns ONE entry; the FULL registry literal is pinned
    // by cron_handlers_daily.integration.test.ts.
    expect(CRON_SCHEDULES).toEqual(expect.arrayContaining([
      {
        schedule_id: "codemaster-workspace-retention",
        job_type: "workspace_retention",
        cadence_kind: "interval",
        cadence_spec: "300",
        input: {},
      },
    ]));
  });
});
