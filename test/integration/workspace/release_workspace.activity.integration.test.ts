/**
 * Integration test for `releaseWorkspace` (the REAL de-stubbed activity), against a DISPOSABLE
 * Postgres (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs
 * ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise. The suite runs SERIALLY
 * (--no-file-parallelism); every test uses a UNIQUE installation_id / run_id / review_id / workspace_id
 * (newUuid) so tenant-scoped rows never collide.
 *
 * `core.workspace_leases` ALREADY EXISTS in the squashed baseline (no migration). The lease's FK chain
 * (review_id → core.pull_request_reviews, run_id → core.review_runs) is seeded per test and torn down
 * in `finally`. The workspace root is an os.tmpdir scratch dir, removed in `finally`.
 *
 * Coverage:
 *   - release flips ALLOCATED → RELEASED (through RELEASE_REQUESTED), removes the on-disk dir, and
 *     emits WORKSPACE_RELEASE_REQUESTED + WORKSPACE_RELEASED audit events.
 *   - release on a MISSING lease is a no-op (no throw, no row).
 *   - release on an already-RELEASED lease is a no-op (terminal; no new events).
 *   - a path-traversal / hostile-symlink escape → WorkspaceSecurityViolation, leaving the lease in
 *     FAILED_CLEANUP (with cleanup_attempts bumped + last_cleanup_error stamped).
 */

import { createHash, randomInt } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { releaseWorkspace } from "#backend/activities/release_workspace.activity.js";
import { LeaseRepo } from "#backend/workspace/lease_repo.js";
import { WorkspaceSecurityViolation } from "#backend/workspace/errors.js";

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

/** Seed the FK chain a lease + its events require: a core.pull_request_reviews row → a core.review_runs row. */
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
  await pool.query(`DELETE FROM core.workspace_leases WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [seed.reviewId]);
}

/** Widen the schema-typed test engine to the schema-agnostic `Kysely<unknown>` the activity accepts. */
function injectedDb(): Kysely<unknown> {
  return db as unknown as Kysely<unknown>;
}

/** Insert an ALLOCATED lease for `seed` directly via the repo (no allocate activity round-trip). */
async function insertAllocatedLease(seed: Seed): Promise<void> {
  const repo = new LeaseRepo({ db: injectedDb() });
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

/** Create the on-disk workspace directory `<root>/installations/<iid>/runs/<run_id>` with a marker file. */
async function makeWorkspaceDir(root: string, seed: Seed): Promise<string> {
  const dir = path.join(root, "installations", seed.installationId, "runs", seed.runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "MARKER.txt"), "ws\n", { encoding: "utf8" });
  return dir;
}

describeDb("releaseWorkspace (integration, disposable PG)", () => {
  it("flips ALLOCATED → RELEASED (through RELEASE_REQUESTED), removes the dir, emits the events", async () => {
    const seed = await seedTenant();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cm-ws-rel-"));
    try {
      await insertAllocatedLease(seed);
      const dir = await makeWorkspaceDir(root, seed);
      expect((await fs.stat(dir)).isDirectory()).toBe(true);

      await releaseWorkspace(
        { schema_version: 1, workspace_id: seed.workspaceId },
        { db: injectedDb(), clock: FIXED_CLOCK, workspaceRoot: root },
      );

      // Lease is RELEASED; biconditional CHECKs satisfied (released_at stamped, cleanup_failed_at NULL).
      const repo = new LeaseRepo({ db: injectedDb() });
      const row = (await repo.getById(seed.workspaceId))!;
      expect(row.state).toBe("RELEASED");
      expect(row.release_requested_at).not.toBeNull();
      expect(row.released_at).not.toBeNull();
      expect(new Date(row.released_at!).toISOString()).toBe("2099-07-08T09:10:11.000Z");
      expect(row.cleanup_failed_at).toBeNull();

      // The on-disk directory is gone.
      await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });

      // Two events, in order: WORKSPACE_RELEASE_REQUESTED then WORKSPACE_RELEASED.
      const events = await pool.query<{ event_type: string; sequence_no: number }>(
        `SELECT event_type, sequence_no FROM audit.workflow_events WHERE run_id = $1 ORDER BY sequence_no`,
        [seed.runId],
      );
      expect(events.rows.map((r) => r.event_type)).toEqual([
        "WORKSPACE_RELEASE_REQUESTED",
        "WORKSPACE_RELEASED",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await cleanupTenant(seed);
    }
  });

  it("is a no-op on a MISSING lease (no throw, no row, no event)", async () => {
    const seed = await seedTenant();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cm-ws-rel-"));
    try {
      // No lease inserted; workspace_id does not exist → fully idempotent (already gone).
      await expect(
        releaseWorkspace(
          { schema_version: 1, workspace_id: seed.workspaceId },
          { db: injectedDb(), clock: FIXED_CLOCK, workspaceRoot: root },
        ),
      ).resolves.toBeUndefined();

      const repo = new LeaseRepo({ db: injectedDb() });
      expect(await repo.getById(seed.workspaceId)).toBeUndefined();
      const events = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit.workflow_events WHERE run_id = $1`,
        [seed.runId],
      );
      expect(Number(events.rows[0]?.n)).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await cleanupTenant(seed);
    }
  });

  it("is a no-op on an already-RELEASED lease (terminal; no new events)", async () => {
    const seed = await seedTenant();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cm-ws-rel-"));
    try {
      await insertAllocatedLease(seed);
      await makeWorkspaceDir(root, seed);

      // First release flips it to RELEASED (2 events).
      await releaseWorkspace(
        { schema_version: 1, workspace_id: seed.workspaceId },
        { db: injectedDb(), clock: FIXED_CLOCK, workspaceRoot: root },
      );
      // Second release is a terminal no-op — emits NO further events.
      await releaseWorkspace(
        { schema_version: 1, workspace_id: seed.workspaceId },
        { db: injectedDb(), clock: FIXED_CLOCK, workspaceRoot: root },
      );

      const events = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit.workflow_events WHERE run_id = $1`,
        [seed.runId],
      );
      expect(Number(events.rows[0]?.n)).toBe(2); // unchanged from the first release
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await cleanupTenant(seed);
    }
  });

  it("a hostile-symlink escape → WorkspaceSecurityViolation, leaving the lease in FAILED_CLEANUP", async () => {
    const seed = await seedTenant();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cm-ws-rel-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cm-ws-escape-"));
    try {
      await insertAllocatedLease(seed);

      // Make `<root>/installations/<iid>` a symlink to a directory OUTSIDE the root. The candidate
      // cleanup path `<root>/installations/<iid>/runs/<run_id>` then resolves outside the root.
      await fs.mkdir(path.join(root, "installations"), { recursive: true });
      await fs.symlink(outside, path.join(root, "installations", seed.installationId), "dir");
      // Materialize the escaped target so the symlinked ancestor realpaths cleanly outside the root.
      await fs.mkdir(path.join(outside, "runs", seed.runId), { recursive: true });

      await expect(
        releaseWorkspace(
          { schema_version: 1, workspace_id: seed.workspaceId },
          { db: injectedDb(), clock: FIXED_CLOCK, workspaceRoot: root },
        ),
      ).rejects.toBeInstanceOf(WorkspaceSecurityViolation);

      // The lease is parked in FAILED_CLEANUP with the backoff metadata bumped (1:1 with the Python).
      const repo = new LeaseRepo({ db: injectedDb() });
      const row = (await repo.getById(seed.workspaceId))!;
      expect(row.state).toBe("FAILED_CLEANUP");
      expect(row.cleanup_failed_at).not.toBeNull();
      expect(row.cleanup_attempts).toBe(1);
      expect(row.last_cleanup_attempt_at).not.toBeNull();
      expect(row.last_cleanup_error).toBe("security_violation");
      // The hop through RELEASE_REQUESTED stamped release_requested_at (CHECK invariant for FAILED_CLEANUP).
      expect(row.release_requested_at).not.toBeNull();

      // The escaped target was NOT removed (the violation aborted before rm).
      expect((await fs.stat(path.join(outside, "runs", seed.runId))).isDirectory()).toBe(true);

      // Events: WORKSPACE_RELEASE_REQUESTED (entry hop) then WORKSPACE_CLEANUP_FAILED.
      const events = await pool.query<{ event_type: string }>(
        `SELECT event_type FROM audit.workflow_events WHERE run_id = $1 ORDER BY sequence_no`,
        [seed.runId],
      );
      expect(events.rows.map((r) => r.event_type)).toEqual([
        "WORKSPACE_RELEASE_REQUESTED",
        "WORKSPACE_CLEANUP_FAILED",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
      await cleanupTenant(seed);
    }
  });
});
