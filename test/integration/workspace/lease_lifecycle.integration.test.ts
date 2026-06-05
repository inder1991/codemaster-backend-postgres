/**
 * Integration test for the workspace LeaseRepo + transitionLease state machine, against a DISPOSABLE
 * Postgres (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs
 * ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so validate-fast stays
 * green without a DB. The suite runs SERIALLY (--no-file-parallelism); every test uses a UNIQUE
 * installation_id / run_id / review_id / workspace_id (newUuid) so tenant-scoped rows never collide.
 *
 * `core.workspace_leases` ALREADY EXISTS in the squashed baseline (introspected — no migration). Its FK
 * chain (review_id → core.pull_request_reviews, run_id → core.review_runs) is seeded per test and torn
 * down in `finally`. The emitted WORKSPACE_* events (audit.workflow_events) carry the same FK chain.
 *
 * Coverage:
 *   - insert (ALLOCATED) → getById returns the row.
 *   - touchHeartbeat bumps heartbeat_at on an ALLOCATED row; returns false for an absent row AND for a
 *     non-ALLOCATED (RELEASE_REQUESTED) row.
 *   - findActiveByRun returns the active row.
 *   - transitionLease(ALLOCATED → ALLOCATED) = ALREADY_APPLIED (NO event emitted).
 *   - transitionLease(ALLOCATED → RELEASE_REQUESTED) = APPLIED (sets release_requested_at +
 *     release_requested_by + emits WORKSPACE_RELEASE_REQUESTED; biconditional CHECKs satisfied).
 *   - transitionLease from a drifted state → StateDrift.
 *   - transitionLease on a missing row → StateDrift (actualState "<missing>").
 */

import { createHash, randomInt } from "node:crypto";

import { Kysely, PostgresDialect, type Transaction } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LeaseRepo } from "#backend/workspace/lease_repo.js";
import { LeaseTransitionOutcome, transitionLease } from "#backend/workspace/transition.js";
import { StateDrift } from "#backend/workspace/errors.js";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";
import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// 2099 routes every emitted event into the audit.workflow_events_default partition (no 2099 range).
const FIXED_CLOCK = new FakeClock({ now: new Date("2099-07-08T09:10:11.000Z") });

let pool: Pool;
let db: Kysely<Record<string, never>>;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 8 });
  db = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new TenancyPlugin()],
  });
});

afterAll(async () => {
  await db?.destroy();
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

/**
 * Seed the FK chain a lease + its emitted events require: a core.pull_request_reviews row → a
 * core.review_runs row. Returns a fresh workspace_id too (the lease PK). Does NOT insert the lease —
 * each test drives insert() itself.
 */
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

/** Delete the seeded chain (events + lease first — their FKs to review_runs/pull_request_reviews are RESTRICT). */
async function cleanupTenant(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM audit.workflow_events WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.workspace_leases WHERE workspace_id = $1`, [seed.workspaceId]);
  await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [seed.reviewId]);
}

/**
 * Build a {@link LeaseRepo} over the shared `db`. `Kysely<DB>` is invariant in `DB`, so the
 * `Kysely<Record<string, never>>` test engine is widened ONCE here to the schema-agnostic
 * `Kysely<unknown>` the repo accepts (the repo runs only raw `sql`, so the DB-schema generic is
 * irrelevant to it — the runtime object is the same engine).
 */
function leaseRepo(): LeaseRepo {
  return new LeaseRepo({ db: db as unknown as Kysely<unknown> });
}

/** Insert an ALLOCATED lease for `seed` via the repo, with sane non-null defaults. */
async function insertAllocatedLease(seed: Seed): Promise<void> {
  const repo = leaseRepo();
  await repo.insert({
    workspaceId: seed.workspaceId,
    runId: seed.runId,
    reviewId: seed.reviewId,
    installationId: seed.installationId,
    podName: "worker-pod-0",
    podNamespace: "codemaster",
    nodeName: "node-a",
    workerId: "worker-0",
    orphanCheckAfter: new Date("2099-07-08T10:00:00.000Z"),
  });
}

describeDb("workspace lease lifecycle (integration, disposable PG)", () => {
  it("insert (ALLOCATED) → getById returns the row with defaulted state/heartbeat", async () => {
    const seed = await seedTenant();
    try {
      await insertAllocatedLease(seed);
      const repo = leaseRepo();
      const row = await repo.getById(seed.workspaceId);
      expect(row).toBeDefined();
      expect(row!.workspace_id).toBe(seed.workspaceId);
      expect(row!.run_id).toBe(seed.runId);
      expect(row!.review_id).toBe(seed.reviewId);
      expect(row!.installation_id).toBe(seed.installationId);
      expect(row!.state).toBe("ALLOCATED"); // column DEFAULT
      expect(row!.pod_name).toBe("worker-pod-0");
      expect(row!.node_name).toBe("node-a");
      expect(row!.created_at).toBeInstanceOf(Date);
      expect(row!.heartbeat_at).toBeInstanceOf(Date);
      // Biconditional CHECKs: ALLOCATED ⇒ released_at / cleanup_failed_at / release_requested_at all NULL.
      expect(row!.released_at).toBeNull();
      expect(row!.cleanup_failed_at).toBeNull();
      expect(row!.release_requested_at).toBeNull();

      // getById on an absent workspace_id returns undefined.
      const absent = await repo.getById(newUuid());
      expect(absent).toBeUndefined();
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("findActiveByRun returns the active lease for a run", async () => {
    const seed = await seedTenant();
    try {
      await insertAllocatedLease(seed);
      const repo = leaseRepo();
      const row = await repo.findActiveByRun(seed.runId);
      expect(row).toBeDefined();
      expect(row!.workspace_id).toBe(seed.workspaceId);
      expect(row!.state).toBe("ALLOCATED");

      // A run with no active lease returns undefined.
      const none = await repo.findActiveByRun(newUuid());
      expect(none).toBeUndefined();
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("touchHeartbeat bumps heartbeat_at on an ALLOCATED row and returns true", async () => {
    const seed = await seedTenant();
    try {
      await insertAllocatedLease(seed);
      const repo = leaseRepo();
      const before = (await repo.getById(seed.workspaceId))!.heartbeat_at;

      // Force a measurable gap so clock_timestamp() strictly advances even on a fast machine.
      await new Promise((r) => setTimeout(r, 15));
      const ok = await repo.touchHeartbeat(seed.workspaceId);
      expect(ok).toBe(true);

      const after = (await repo.getById(seed.workspaceId))!.heartbeat_at;
      expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("touchHeartbeat returns false for an absent row and for a non-ALLOCATED row", async () => {
    const seed = await seedTenant();
    try {
      const repo = leaseRepo();
      // Absent row.
      expect(await repo.touchHeartbeat(newUuid())).toBe(false);

      // Insert + move off ALLOCATED, then touchHeartbeat must miss the WHERE state='ALLOCATED' guard.
      await insertAllocatedLease(seed);
      await db.transaction().execute((tx) =>
        transitionLease({
          tx: tx as unknown as Transaction<unknown>,
          workspaceId: seed.workspaceId,
          fromState: "ALLOCATED",
          toState: "RELEASE_REQUESTED",
          activity: "test_release",
          clock: FIXED_CLOCK,
        }),
      );
      const nonAllocated = await repo.touchHeartbeat(seed.workspaceId);
      expect(nonAllocated).toBe(false);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("transitionLease(ALLOCATED → ALLOCATED) = ALREADY_APPLIED and emits NO event", async () => {
    const seed = await seedTenant();
    try {
      await insertAllocatedLease(seed);
      const outcome = await db.transaction().execute((tx) =>
        transitionLease({
          tx: tx as unknown as Transaction<unknown>,
          workspaceId: seed.workspaceId,
          fromState: "ALLOCATED",
          toState: "ALLOCATED",
          activity: "noop_assert",
          clock: FIXED_CLOCK,
        }),
      );
      expect(outcome).toBe(LeaseTransitionOutcome.ALREADY_APPLIED);

      const events = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit.workflow_events WHERE run_id = $1`,
        [seed.runId],
      );
      expect(Number(events.rows[0]?.n)).toBe(0); // ALREADY_APPLIED emits no event
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("transitionLease(ALLOCATED → RELEASE_REQUESTED) = APPLIED, stamps timestamp + attribution + emits the event", async () => {
    const seed = await seedTenant();
    try {
      await insertAllocatedLease(seed);
      const outcome = await db.transaction().execute((tx) =>
        transitionLease({
          tx: tx as unknown as Transaction<unknown>,
          workspaceId: seed.workspaceId,
          fromState: "ALLOCATED",
          toState: "RELEASE_REQUESTED",
          activity: "release_workspace_activity",
          reason: "workflow_complete",
          clock: FIXED_CLOCK,
        }),
      );
      expect(outcome).toBe(LeaseTransitionOutcome.APPLIED);

      const repo = leaseRepo();
      const row = (await repo.getById(seed.workspaceId))!;
      expect(row.state).toBe("RELEASE_REQUESTED");
      // Biconditional CHECK ck_workspace_leases_release_requested: release_requested_at NOT NULL now.
      expect(row.release_requested_at).not.toBeNull();
      expect(new Date(row.release_requested_at!).toISOString()).toBe("2099-07-08T09:10:11.000Z");
      expect(row.release_requested_by).toBe("release_workspace_activity");
      // RELEASE_REQUESTED ⇒ released_at + cleanup_failed_at still NULL (biconditional CHECKs hold).
      expect(row.released_at).toBeNull();
      expect(row.cleanup_failed_at).toBeNull();

      const events = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type, payload FROM audit.workflow_events WHERE run_id = $1`,
        [seed.runId],
      );
      expect(events.rows.length).toBe(1);
      expect(events.rows[0]!.event_type).toBe("WORKSPACE_RELEASE_REQUESTED");
      expect(events.rows[0]!.payload).toEqual({
        workspace_id: seed.workspaceId,
        from_state: "ALLOCATED",
        to_state: "RELEASE_REQUESTED",
        activity: "release_workspace_activity",
        reason: "workflow_complete",
      });
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("transitionLease from a DRIFTED state raises StateDrift", async () => {
    const seed = await seedTenant();
    try {
      await insertAllocatedLease(seed);
      // Move to RELEASE_REQUESTED first.
      await db.transaction().execute((tx) =>
        transitionLease({
          tx: tx as unknown as Transaction<unknown>,
          workspaceId: seed.workspaceId,
          fromState: "ALLOCATED",
          toState: "RELEASE_REQUESTED",
          activity: "release_workspace_activity",
          clock: FIXED_CLOCK,
        }),
      );
      // Now a caller that still believes it is ALLOCATED → RELEASED drifts (current is RELEASE_REQUESTED,
      // which is neither ALLOCATED nor RELEASED).
      await expect(
        db.transaction().execute((tx) =>
          transitionLease({
            tx: tx as unknown as Transaction<unknown>,
            workspaceId: seed.workspaceId,
            fromState: "ALLOCATED",
            toState: "RELEASED",
            activity: "stale_caller",
            clock: FIXED_CLOCK,
          }),
        ),
      ).rejects.toBeInstanceOf(StateDrift);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("transitionLease on a MISSING row raises StateDrift with actualState '<missing>'", async () => {
    const seed = await seedTenant();
    try {
      // No lease inserted; the workspace_id does not exist.
      await expect(
        db.transaction().execute((tx) =>
          transitionLease({
            tx: tx as unknown as Transaction<unknown>,
            workspaceId: seed.workspaceId,
            fromState: "ALLOCATED",
            toState: "RELEASE_REQUESTED",
            activity: "release_workspace_activity",
            clock: FIXED_CLOCK,
          }),
        ),
      ).rejects.toMatchObject({ name: "StateDrift", actualState: "<missing>" });
    } finally {
      await cleanupTenant(seed);
    }
  });
});

// Pure (no-DB) contract checks: the vocabulary + timestamp-column map + event-type mapping.
describe("workspace transition pure contract", () => {
  it("LEASE_STATES carries the exact frozen 5-state vocabulary", async () => {
    const { LEASE_STATES, STATE_TIMESTAMP_COLUMNS, eventTypeFor } = await import(
      "#backend/workspace/transition.js"
    );
    // JS default (codepoint) sort: "RELEASED" precedes "RELEASE_REQUESTED" — shared prefix "RELEASE",
    // then 'D' (0x44) < '_' (0x5F).
    expect([...LEASE_STATES].sort()).toEqual([
      "ALLOCATED",
      "FAILED_CLEANUP",
      "ORPHANED",
      "RELEASED",
      "RELEASE_REQUESTED",
    ]);
    expect(STATE_TIMESTAMP_COLUMNS.get("RELEASE_REQUESTED")).toBe("release_requested_at");
    expect(STATE_TIMESTAMP_COLUMNS.get("RELEASED")).toBe("released_at");
    expect(STATE_TIMESTAMP_COLUMNS.get("FAILED_CLEANUP")).toBe("cleanup_failed_at");
    expect(STATE_TIMESTAMP_COLUMNS.has("ORPHANED")).toBe(false);
    expect(STATE_TIMESTAMP_COLUMNS.has("ALLOCATED")).toBe(false);
    // FAILED_CLEANUP lease-state maps to the WORKSPACE_CLEANUP_FAILED event-type (spec §5.3).
    expect(eventTypeFor("FAILED_CLEANUP")).toBe("WORKSPACE_CLEANUP_FAILED");
    expect(eventTypeFor("RELEASE_REQUESTED")).toBe("WORKSPACE_RELEASE_REQUESTED");
    expect(eventTypeFor("RELEASED")).toBe("WORKSPACE_RELEASED");
    expect(eventTypeFor("ORPHANED")).toBe("WORKSPACE_ORPHANED");
    expect(eventTypeFor("ALLOCATED")).toBe("WORKSPACE_ALLOCATED");
  });
});
