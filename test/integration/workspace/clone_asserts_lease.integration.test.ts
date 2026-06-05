/**
 * Integration test for the REAL de-stubbed `cloneRepoIntoWorkspace` lease-assertion seam
 * ({@link defaultAssertLeaseAllocated}), against a DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so validate-fast stays green without a
 * DB. The suite runs SERIALLY (--no-file-parallelism); every test uses a UNIQUE installation_id / run_id
 * / review_id / workspace_id (newUuid) so tenant-scoped rows never collide.
 *
 * `core.workspace_leases` ALREADY EXISTS in the squashed baseline (no migration). The lease's FK chain
 * (review_id → core.pull_request_reviews, run_id → core.review_runs) is seeded per test and torn down in
 * `finally`. The git part is the deterministic StubCloner (writes a marker file — no real git round-trip);
 * only the lease-assertion seam is the REAL impl under test.
 *
 * The real `defaultAssertLeaseAllocated` resolves the shared ADR-0062 pool from CODEMASTER_PG_CORE_DSN —
 * so each test sets that env var to the disposable DSN, runs the activity with the REAL assert seam (and
 * an injected no-op `heartbeat` double, since there is no Temporal worker context here), and inspects the
 * lease row directly.
 *
 * Coverage:
 *   - an ALLOCATED lease: clone asserts ALREADY_APPLIED (no throw), bumps `heartbeat_at`, and the git
 *     stub clones successfully → ClonedRepoV1 returned.
 *   - a lease NOT in ALLOCATED (RELEASE_REQUESTED): clone's assert seam raises StateDrift and the cloner
 *     is NEVER invoked.
 */

import { createHash, randomInt } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  cloneRepoIntoWorkspace,
  StubCloner,
} from "#backend/activities/clone_repo_into_workspace.activity.js";
import { LeaseRepo } from "#backend/workspace/lease_repo.js";
import { StateDrift } from "#backend/workspace/errors.js";
import { transitionLease } from "#backend/workspace/transition.js";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";
import { FakeClock } from "#platform/clock.js";

import { CloneRepoIntoWorkspaceInput } from "#contracts/clone_repo_into_workspace_input.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const HEAD_SHA = "abcdef0123456789abcdef0123456789abcdef01"; // 40 hex chars
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

/** Widen the schema-typed test engine to the schema-agnostic `Kysely<unknown>` the repos/transition accept. */
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

/** Build the activity input nesting a WorkspaceHandle for `seed` rooted at the on-disk `workspacePath`. */
function input(seed: Seed, workspacePath: string): CloneRepoIntoWorkspaceInput {
  return CloneRepoIntoWorkspaceInput.parse({
    handle: {
      workspace_id: seed.workspaceId,
      installation_id: seed.installationId,
      run_id: seed.runId,
      derived_path: workspacePath,
      state: "ALLOCATED",
    },
    repo_url: "https://github.com/acme/widget",
    head_sha: HEAD_SHA,
    changed_paths: ["src/foo.ts"],
    pr_number: 42,
  });
}

describeDb("cloneRepoIntoWorkspace lease-assertion seam (integration, disposable PG)", () => {
  it("an ALLOCATED lease: asserts ALREADY_APPLIED (no throw), bumps heartbeat_at, clones", async () => {
    const seed = await seedTenant();
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "cm-clone-assert-"));
    // The REAL defaultAssertLeaseAllocated resolves the shared pool from this env var.
    const prior = process.env.CODEMASTER_PG_CORE_DSN;
    process.env.CODEMASTER_PG_CORE_DSN = INTEGRATION_DSN;
    try {
      await insertAllocatedLease(seed);
      const repo = new LeaseRepo({ db: injectedDb() });
      const before = (await repo.getById(seed.workspaceId))!.heartbeat_at;

      // No assertLeaseAllocated injected → the REAL default runs (DB assert + heartbeat bump). The
      // `heartbeat` seam IS injected as a no-op (no Temporal worker context here).
      const result = await cloneRepoIntoWorkspace(input(seed, ws), {
        cloner: new StubCloner({ markerBody: "twelve-bytes" }),
        heartbeat: () => {},
      });

      // The git stub cloned successfully and the contract envelope came back.
      expect(result.schema_version).toBe(2);
      expect(result.workspace_path).toBe(ws);
      expect(result.repo_path).toBe(`${ws}/repo`);
      expect(result.byte_size).toBe(12);

      // The lease is still ALLOCATED (the assertion is a no-op transition) and heartbeat_at advanced
      // (touchHeartbeat uses clock_timestamp() — a real wall-clock bump).
      const after = (await repo.getById(seed.workspaceId))!;
      expect(after.state).toBe("ALLOCATED");
      expect(new Date(after.heartbeat_at).getTime()).toBeGreaterThan(new Date(before).getTime());

      // No WORKSPACE_* event was emitted (an ALREADY_APPLIED transition emits nothing).
      const events = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit.workflow_events WHERE run_id = $1`,
        [seed.runId],
      );
      expect(Number(events.rows[0]?.n)).toBe(0);
    } finally {
      if (prior !== undefined) process.env.CODEMASTER_PG_CORE_DSN = prior;
      else delete process.env.CODEMASTER_PG_CORE_DSN;
      await fs.rm(ws, { recursive: true, force: true });
      await cleanupTenant(seed);
    }
  });

  it("a lease NOT in ALLOCATED (RELEASE_REQUESTED) → StateDrift; the cloner is never invoked", async () => {
    const seed = await seedTenant();
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "cm-clone-assert-"));
    const prior = process.env.CODEMASTER_PG_CORE_DSN;
    process.env.CODEMASTER_PG_CORE_DSN = INTEGRATION_DSN;
    try {
      await insertAllocatedLease(seed);
      // Move the lease off ALLOCATED (a concurrent cancellation flow) so the assert seam drifts.
      await injectedDb()
        .transaction()
        .execute(async (tx) => {
          await transitionLease({
            tx,
            workspaceId: seed.workspaceId,
            fromState: "ALLOCATED",
            toState: "RELEASE_REQUESTED",
            activity: "test_setup",
            reason: "drift the lease off ALLOCATED",
            clock: FIXED_CLOCK,
          });
        });

      // A cloner whose invocation would be observable — it must NOT run (assert fails first).
      let cloneInvoked = false;
      const cloner = {
        clone: async (): Promise<void> => {
          cloneInvoked = true;
        },
      };

      await expect(
        cloneRepoIntoWorkspace(input(seed, ws), { cloner, heartbeat: () => {} }),
      ).rejects.toBeInstanceOf(StateDrift);
      expect(cloneInvoked).toBe(false);

      // The lease is unchanged by the failed assertion (still RELEASE_REQUESTED).
      const row = (await new LeaseRepo({ db: injectedDb() }).getById(seed.workspaceId))!;
      expect(row.state).toBe("RELEASE_REQUESTED");
    } finally {
      if (prior !== undefined) process.env.CODEMASTER_PG_CORE_DSN = prior;
      else delete process.env.CODEMASTER_PG_CORE_DSN;
      await fs.rm(ws, { recursive: true, force: true });
      await cleanupTenant(seed);
    }
  });
});
