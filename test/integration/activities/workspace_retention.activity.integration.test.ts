/**
 * Integration test for the THREE pure-DB workspace-retention janitor activities — REAL de-stubbed ports
 * of the frozen Python `@activity.defn run_workspace_orphan_sweep_activity` /
 * `run_workspace_reap_activity` / `run_workspace_released_retention_activity`
 * (vendor/codemaster-py/codemaster/activities/workspace_retention.py), against a DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise. The suite runs SERIALLY
 * (--no-file-parallelism); every test scopes its seeded rows to UNIQUE ids and DELETEs them in a
 * `finally` (respecting FK order).
 *
 * `core.workspace_leases` + `core.worker_heartbeats` ALREADY EXIST in the squashed baseline (no migration).
 * The lease's FK chain (review_id → core.pull_request_reviews, run_id → core.review_runs) is seeded per
 * test and torn down in `finally`.
 *
 * ── worker_heartbeats / orphan-branch caveat (DOCUMENTED DEAD-SPOT) ──
 * The Python orphan sweep JOINs `core.worker_heartbeats` (the producer the live WorkspaceManager
 * heartbeat loop upserts/touches). That producer is UNPORTED in TS (no WorkspaceManager port exists, no
 * TS code writes `core.worker_heartbeats`), so in production the orphan branch is a structural no-op
 * (the JOIN matches zero rows). This SUITE proves the orphan sweep STILL works when the heartbeat
 * producer IS present, by seeding a `core.worker_heartbeats` row directly — i.e. the SQL is byte-faithful
 * and would fire once the producer is ported. The "no heartbeat row → zero orphaned" path is asserted
 * separately (the production reality today). See the activity module header for the full caveat.
 *
 * Coverage:
 *   runWorkspaceOrphanSweepActivity (ALLOCATED → ORPHANED when worker dead + grace elapsed):
 *     (O1) ALLOCATED + dead-worker heartbeat (last_seen 10m ago) + orphan_check_after in the past → ORPHANED.
 *     (O2) ALLOCATED + LIVE-worker heartbeat (last_seen now)                                       → PRESERVED.
 *     (O3) ALLOCATED + dead worker but orphan_check_after in the FUTURE                            → PRESERVED.
 *     (O4) ALLOCATED + worker has NO heartbeat row at all (production reality)                     → PRESERVED.
 *
 *   runWorkspaceReapActivity (returns the workspace_ids eligible for a release retry):
 *     (R1) ORPHANED lease                                                  → eligible (always).
 *     (R2) RELEASE_REQUESTED past release_grace (requested 10m ago)        → eligible.
 *     (R3) RELEASE_REQUESTED inside release_grace (requested now)          → NOT eligible.
 *     (R4) FAILED_CLEANUP, attempts < max, backoff elapsed (last attempt long ago) → eligible.
 *     (R5) FAILED_CLEANUP, attempts < max, last attempt just now (backoff NOT elapsed) → NOT eligible.
 *     (R6) FAILED_CLEANUP, attempts >= cleanup_max_attempts                → NOT eligible (exhausted).
 *     (R7) ALLOCATED                                                       → NOT eligible.
 *
 *   runWorkspaceReleasedRetentionActivity (hard-DELETE of RELEASED rows past released_lease_retention):
 *     (P1) RELEASED + released_at 10 days ago → DELETED.
 *     (P2) RELEASED + released_at now()       → PRESERVED (inside the 7-day retention window).
 *     (P3) ORPHANED row (any age)             → PRESERVED (only RELEASED rows are purged).
 *
 * NOTE: all three sweeps are CROSS-TENANT (no installation_id filter — Python @privileged_path), so the
 * absolute orphaned/eligible/deleted totals may include other tenants' aged rows. This suite asserts
 * PER-ROW on-disk state for its own seeded rows + the invariants, rather than exact global totals.
 */

import { createHash, randomInt } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  runWorkspaceOrphanSweepActivity,
  runWorkspaceReapActivity,
  runWorkspaceReleasedRetentionActivity,
} from "#backend/activities/workspace_retention.activity.js";

import { disposePool, getPool } from "#platform/db/database.js";
import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// A fixed clock so cutoffs are deterministic. 2099 keeps every emitted workflow_event in the
// audit.workflow_events_default partition (no 2099 range), matching the release-workspace suite.
const NOW = new Date("2099-07-08T09:10:11.000Z");
const FIXED_CLOCK = new FakeClock({ now: NOW });

let pool: Pool;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  pool = getPool(INTEGRATION_DSN);
});

afterAll(async () => {
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

/** A small unique bigint so unique columns never collide across tests. */
function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = {
  installationId: string;
  reviewId: string;
  runId: string;
  workspaceId: string;
};

/** Seed the FK chain a lease + its events require: a pull_request_reviews row → a review_runs row. */
async function seedTenant(): Promise<Seed> {
  const installationId = newUuid();
  const reviewId = newUuid();
  const runId = newUuid();
  const workspaceId = newUuid();
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
  return { installationId, reviewId, runId, workspaceId };
}

/**
 * Compute an instant offset from the FAKE-clock instant `NOW`, so every seeded timestamp is anchored to
 * the SAME clock the activity reads its cutoffs from (the injected FakeClock), NOT the DB wall clock.
 * This makes the suite fully deterministic + independent of real time (the activity's cutoff is
 * `FIXED_CLOCK.now() - threshold`, so a fixture seeded relative to `NOW` lands on the intended side of
 * the cutoff every run).
 */
function offsetFromNow(opts: { minutes?: number; days?: number }): Date {
  const ms = (opts.minutes ?? 0) * 60 * 1000 + (opts.days ?? 0) * 24 * 60 * 60 * 1000;
  return new Date(NOW.getTime() + ms);
}

/**
 * Insert a workspace_lease row directly via raw SQL (NOT the allocate activity) so the test can place the
 * row in any lease state with arbitrary timestamps. Every state-dependent timestamp column the
 * biconditional CHECKs require is supplied by the caller as a bound `Date` (anchored to the FakeClock via
 * {@link offsetFromNow}), so the row lands on the intended side of the activity's clock-derived cutoff.
 */
async function insertLease(
  seed: Seed,
  args: {
    state: string;
    workerId: string;
    orphanCheckAfter: Date;
    releaseRequestedAt?: Date | null;
    releasedAt?: Date | null;
    cleanupFailedAt?: Date | null;
    lastCleanupAttemptAt?: Date | null;
    cleanupAttempts?: number;
  },
): Promise<void> {
  const releaseRequestedAt = args.releaseRequestedAt ?? null;
  await pool.query(
    `INSERT INTO core.workspace_leases
       (workspace_id, run_id, review_id, installation_id, state,
        pod_name, pod_namespace, node_name, worker_id,
        orphan_check_after, release_requested_at, release_requested_by, released_at,
        cleanup_failed_at, last_cleanup_attempt_at, cleanup_attempts)
     VALUES ($1, $2, $3, $4, $5::core.workspace_lease_state,
             'worker-pod-0', 'codemaster', 'node-a', $6,
             $7, $8, $9, $10, $11, $12, $13)`,
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
      args.cleanupFailedAt ?? null,
      args.lastCleanupAttemptAt ?? null,
      args.cleanupAttempts ?? 0,
    ],
  );
}

/** Insert a core.worker_heartbeats row with a given last_seen_at (bound `Date`, anchored to NOW). */
async function insertHeartbeat(workerId: string, lastSeenAt: Date): Promise<void> {
  await pool.query(
    `INSERT INTO core.worker_heartbeats
       (worker_id, pod_name, pod_namespace, pod_uid, node_name, process_uuid, started_at, last_seen_at)
     VALUES ($1, 'worker-pod-0', 'codemaster', $2, 'node-a', $3, $4, $5)`,
    [workerId, newUuid(), newUuid(), offsetFromNow({ minutes: -60 }), lastSeenAt],
  );
}

type LeaseRow = { state: string; released_at: Date | null };

async function leaseRow(workspaceId: string): Promise<LeaseRow | undefined> {
  const r = await pool.query<LeaseRow>(
    `SELECT state, released_at FROM core.workspace_leases WHERE workspace_id = $1`,
    [workspaceId],
  );
  return r.rows[0];
}

/** Tear down a tenant's seeded rows in FK order (events + lease + heartbeat first). */
async function cleanupTenant(seed: Seed, workerIds: ReadonlyArray<string>): Promise<void> {
  await pool.query(`DELETE FROM audit.workflow_events WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.workspace_leases WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [seed.reviewId]);
  for (const wid of workerIds) {
    await pool.query(`DELETE FROM core.worker_heartbeats WHERE worker_id = $1`, [wid]);
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
//  Activity 1 — orphan sweep
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describeDb("runWorkspaceOrphanSweepActivity (integration, disposable PG)", () => {
  it("flips ALLOCATED→ORPHANED for a dead worker past the grace window; preserves the others", async () => {
    // (O1) dead worker + orphan_check_after past → ORPHANED.
    const o1 = await seedTenant();
    const o1Worker = `dead-${newUuid()}`;
    // (O2) live worker → preserved.
    const o2 = await seedTenant();
    const o2Worker = `live-${newUuid()}`;
    // (O3) dead worker but orphan_check_after in the future → preserved.
    const o3 = await seedTenant();
    const o3Worker = `dead-future-${newUuid()}`;
    // (O4) NO heartbeat row at all (production reality today) → preserved.
    const o4 = await seedTenant();
    const o4Worker = `no-hb-${newUuid()}`;

    try {
      // Heartbeats: o1/o3 dead (10m ago > worker_dead_after=5m); o2 live (now). o4: none.
      await insertHeartbeat(o1Worker, offsetFromNow({ minutes: -10 }));
      await insertHeartbeat(o2Worker, offsetFromNow({ minutes: 0 }));
      await insertHeartbeat(o3Worker, offsetFromNow({ minutes: -10 }));

      await insertLease(o1, {
        state: "ALLOCATED",
        workerId: o1Worker,
        orphanCheckAfter: offsetFromNow({ minutes: -60 }), // already past
      });
      await insertLease(o2, {
        state: "ALLOCATED",
        workerId: o2Worker,
        orphanCheckAfter: offsetFromNow({ minutes: -60 }),
      });
      await insertLease(o3, {
        state: "ALLOCATED",
        workerId: o3Worker,
        orphanCheckAfter: offsetFromNow({ minutes: 60 }), // not yet eligible
      });
      await insertLease(o4, {
        state: "ALLOCATED",
        workerId: o4Worker,
        orphanCheckAfter: offsetFromNow({ minutes: -60 }),
      });

      const result = await runWorkspaceOrphanSweepActivity({ dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK });

      expect(result.schema_version).toBe(1);
      // Cross-tenant — absolute total may include other tenants; assert ≥ our 1 orphaned row.
      expect(result.orphaned_count).toBeGreaterThanOrEqual(1);

      expect((await leaseRow(o1.workspaceId))!.state).toBe("ORPHANED");
      expect((await leaseRow(o2.workspaceId))!.state).toBe("ALLOCATED"); // live worker
      expect((await leaseRow(o3.workspaceId))!.state).toBe("ALLOCATED"); // future grace
      expect((await leaseRow(o4.workspaceId))!.state).toBe("ALLOCATED"); // no heartbeat row

      // The ORPHANED transition emitted a WORKSPACE_ORPHANED audit event.
      const events = await pool.query<{ event_type: string }>(
        `SELECT event_type FROM audit.workflow_events WHERE run_id = $1 ORDER BY sequence_no`,
        [o1.runId],
      );
      expect(events.rows.map((r) => r.event_type)).toEqual(["WORKSPACE_ORPHANED"]);
    } finally {
      await cleanupTenant(o1, [o1Worker]);
      await cleanupTenant(o2, [o2Worker]);
      await cleanupTenant(o3, [o3Worker]);
      await cleanupTenant(o4, [o4Worker]);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
//  Activity 2 — reap-eligible
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describeDb("runWorkspaceReapActivity (integration, disposable PG)", () => {
  it("returns ONLY the eligible workspace_ids (ORPHANED, aged RELEASE_REQUESTED, backed-off FAILED_CLEANUP)", async () => {
    const worker = `reap-${newUuid()}`;
    const r1 = await seedTenant(); // ORPHANED → eligible
    const r2 = await seedTenant(); // RELEASE_REQUESTED past grace → eligible
    const r3 = await seedTenant(); // RELEASE_REQUESTED inside grace → NOT
    const r4 = await seedTenant(); // FAILED_CLEANUP backoff elapsed → eligible
    const r5 = await seedTenant(); // FAILED_CLEANUP backoff NOT elapsed → NOT
    const r6 = await seedTenant(); // FAILED_CLEANUP attempts exhausted → NOT
    const r7 = await seedTenant(); // ALLOCATED → NOT

    try {
      await insertLease(r1, { state: "ORPHANED", workerId: worker, orphanCheckAfter: offsetFromNow({ minutes: -60 }) });
      await insertLease(r2, {
        state: "RELEASE_REQUESTED",
        workerId: worker,
        orphanCheckAfter: offsetFromNow({ minutes: -60 }),
        releaseRequestedAt: offsetFromNow({ minutes: -10 }), // > release_grace=5m → eligible
      });
      await insertLease(r3, {
        state: "RELEASE_REQUESTED",
        workerId: worker,
        orphanCheckAfter: offsetFromNow({ minutes: -60 }),
        releaseRequestedAt: offsetFromNow({ minutes: 0 }), // inside grace → NOT
      });
      await insertLease(r4, {
        state: "FAILED_CLEANUP",
        workerId: worker,
        orphanCheckAfter: offsetFromNow({ minutes: -60 }),
        releaseRequestedAt: offsetFromNow({ minutes: -60 }),
        cleanupFailedAt: offsetFromNow({ minutes: -60 }),
        lastCleanupAttemptAt: offsetFromNow({ minutes: -60 }), // backoff[0]=1m elapsed → eligible
        cleanupAttempts: 0,
      });
      await insertLease(r5, {
        state: "FAILED_CLEANUP",
        workerId: worker,
        orphanCheckAfter: offsetFromNow({ minutes: -60 }),
        releaseRequestedAt: offsetFromNow({ minutes: -60 }),
        cleanupFailedAt: offsetFromNow({ minutes: 0 }),
        lastCleanupAttemptAt: offsetFromNow({ minutes: 0 }), // backoff[0]=1m NOT elapsed → NOT
        cleanupAttempts: 0,
      });
      await insertLease(r6, {
        state: "FAILED_CLEANUP",
        workerId: worker,
        orphanCheckAfter: offsetFromNow({ minutes: -60 }),
        releaseRequestedAt: offsetFromNow({ days: -1 }),
        cleanupFailedAt: offsetFromNow({ days: -1 }),
        lastCleanupAttemptAt: offsetFromNow({ days: -1 }),
        cleanupAttempts: 5, // >= cleanup_max_attempts=5 → NOT (exhausted)
      });
      await insertLease(r7, { state: "ALLOCATED", workerId: worker, orphanCheckAfter: offsetFromNow({ minutes: -60 }) });

      const result = await runWorkspaceReapActivity({ dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK });
      const eligible = new Set(result.workspace_ids);

      expect(result.schema_version).toBe(1);
      // Eligible set CONTAINS our 3 eligible ids; EXCLUDES the 4 non-eligible.
      expect(eligible.has(r1.workspaceId)).toBe(true);
      expect(eligible.has(r2.workspaceId)).toBe(true);
      expect(eligible.has(r4.workspaceId)).toBe(true);
      expect(eligible.has(r3.workspaceId)).toBe(false);
      expect(eligible.has(r5.workspaceId)).toBe(false);
      expect(eligible.has(r6.workspaceId)).toBe(false);
      expect(eligible.has(r7.workspaceId)).toBe(false);

      // The result is sorted (deterministic) — assert the array is non-decreasing.
      const ids = result.workspace_ids;
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i - 1]! <= ids[i]!).toBe(true);
      }
      // The reap activity has NO side effects on the lease rows — every seeded row is unchanged.
      expect((await leaseRow(r1.workspaceId))!.state).toBe("ORPHANED");
      expect((await leaseRow(r7.workspaceId))!.state).toBe("ALLOCATED");
    } finally {
      await cleanupTenant(r1, []);
      await cleanupTenant(r2, []);
      await cleanupTenant(r3, []);
      await cleanupTenant(r4, []);
      await cleanupTenant(r5, []);
      await cleanupTenant(r6, []);
      await cleanupTenant(r7, [worker]);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
//  Activity 3 — released-row retention purge
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describeDb("runWorkspaceReleasedRetentionActivity (integration, disposable PG)", () => {
  it("hard-deletes RELEASED rows past the retention window; preserves recent + non-RELEASED rows", async () => {
    const worker = `purge-${newUuid()}`;
    const p1 = await seedTenant(); // RELEASED 10d ago → DELETED
    const p2 = await seedTenant(); // RELEASED now → PRESERVED (inside 7d window)
    const p3 = await seedTenant(); // ORPHANED → PRESERVED (not RELEASED)

    try {
      await insertLease(p1, {
        state: "RELEASED",
        workerId: worker,
        orphanCheckAfter: offsetFromNow({ minutes: -60 }),
        releaseRequestedAt: offsetFromNow({ days: -11 }),
        releasedAt: offsetFromNow({ days: -10 }), // > released_lease_retention=7d → DELETED
      });
      await insertLease(p2, {
        state: "RELEASED",
        workerId: worker,
        orphanCheckAfter: offsetFromNow({ minutes: -60 }),
        releaseRequestedAt: offsetFromNow({ minutes: 0 }),
        releasedAt: offsetFromNow({ minutes: 0 }), // inside window → PRESERVED
      });
      await insertLease(p3, {
        state: "ORPHANED",
        workerId: worker,
        orphanCheckAfter: offsetFromNow({ minutes: -60 }),
      });

      const result = await runWorkspaceReleasedRetentionActivity({ dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK });

      expect(result.schema_version).toBe(1);
      // Cross-tenant — assert ≥ our 1 deleted row.
      expect(result.deleted_count).toBeGreaterThanOrEqual(1);

      expect(await leaseRow(p1.workspaceId)).toBeUndefined(); // hard-deleted
      expect((await leaseRow(p2.workspaceId))!.state).toBe("RELEASED"); // preserved (recent)
      expect((await leaseRow(p3.workspaceId))!.state).toBe("ORPHANED"); // preserved (not RELEASED)
    } finally {
      await cleanupTenant(p1, []);
      await cleanupTenant(p2, []);
      await cleanupTenant(p3, [worker]);
    }
  });
});
