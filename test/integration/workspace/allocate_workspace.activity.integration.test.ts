/**
 * Integration test for `allocateWorkspace` (the REAL de-stubbed activity), against a DISPOSABLE
 * Postgres (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs
 * ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so validate-fast stays
 * green without a DB. The suite runs SERIALLY (--no-file-parallelism); every test uses a UNIQUE
 * installation_id / run_id / review_id (newUuid) so tenant-scoped rows never collide.
 *
 * `core.workspace_leases` ALREADY EXISTS in the squashed baseline (no migration). The lease's FK chain
 * (review_id → core.pull_request_reviews, run_id → core.review_runs) is seeded per test and torn down
 * in `finally`. The workspace root is an os.tmpdir scratch dir, removed in `finally`.
 *
 * Coverage:
 *   - allocate creates an ALLOCATED lease row + returns a WorkspaceHandle carrying the derived path,
 *     and the on-disk workspace directory exists afterward.
 *   - allocate is idempotent under Temporal retry: a second call for the same run_id reuses the
 *     existing active lease (ON CONFLICT → findActiveByRun) and returns the SAME workspace_id.
 */

import { createHash, randomInt } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { allocateWorkspace } from "#backend/activities/allocate_workspace.activity.js";
import { LeaseRepo } from "#backend/workspace/lease_repo.js";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";
import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// 2099 routes every emitted event into the audit.workflow_events_default partition (no 2099 range).
const FIXED_CLOCK = new FakeClock({ now: new Date("2099-07-08T09:10:11.000Z") });

const IDENTITY = {
  podName: "worker-pod-0",
  podNamespace: "codemaster",
  nodeName: "node-a",
  workerId: "worker-0",
};

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
};

/** Seed the FK chain a lease requires: a core.pull_request_reviews row → a core.review_runs row. */
async function seedTenant(): Promise<Seed> {
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
  return { installationId, reviewId, runId };
}

/** Delete the seeded chain (events + leases first — their FKs to review_runs/pull_request_reviews are RESTRICT). */
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

describeDb("allocateWorkspace (integration, disposable PG)", () => {
  it("creates an ALLOCATED lease + returns a handle with the derived path + makes the dir", async () => {
    const seed = await seedTenant();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cm-ws-alloc-"));
    try {
      const handle = await allocateWorkspace(
        {
          schema_version: 1,
          run_id: seed.runId,
          review_id: seed.reviewId,
          installation_id: seed.installationId,
          repo_id: 4242,
          workflow_id: "review-pr-acme-widget-42",
        },
        { db: injectedDb(), clock: FIXED_CLOCK, workspaceRoot: root, identity: IDENTITY },
      );

      // The handle carries the lease identity + the resolved on-disk path + ALLOCATED state.
      expect(handle.run_id).toBe(seed.runId);
      expect(handle.installation_id).toBe(seed.installationId);
      expect(handle.state).toBe("ALLOCATED");

      const expectedDir = path.join(root, "installations", seed.installationId, "runs", seed.runId);
      // derived_path is the realpath of the workspace dir (tmpdir may be a symlink, e.g. macOS /var → /private/var).
      expect(handle.derived_path).toBe(await fs.realpath(expectedDir));
      // The on-disk directory exists.
      const stat = await fs.stat(handle.derived_path);
      expect(stat.isDirectory()).toBe(true);

      // The lease row exists, is ALLOCATED, and matches the returned workspace_id.
      const repo = new LeaseRepo({ db: injectedDb() });
      const row = await repo.getById(handle.workspace_id);
      expect(row).toBeDefined();
      expect(row!.workspace_id).toBe(handle.workspace_id);
      expect(row!.run_id).toBe(seed.runId);
      expect(row!.review_id).toBe(seed.reviewId);
      expect(row!.installation_id).toBe(seed.installationId);
      expect(row!.state).toBe("ALLOCATED");
      expect(row!.pod_name).toBe(IDENTITY.podName);
      expect(row!.pod_namespace).toBe(IDENTITY.podNamespace);
      expect(row!.node_name).toBe(IDENTITY.nodeName);
      expect(row!.worker_id).toBe(IDENTITY.workerId);
      // orphan_check_after = clock.now() + 30min (inlined WorkspaceConfig default).
      expect(new Date(row!.orphan_check_after).toISOString()).toBe("2099-07-08T09:40:11.000Z");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await cleanupTenant(seed);
    }
  });

  it("is idempotent under retry: a second call reuses the active lease + returns the same workspace_id", async () => {
    const seed = await seedTenant();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cm-ws-alloc-"));
    try {
      const input = {
        schema_version: 1 as const,
        run_id: seed.runId,
        review_id: seed.reviewId,
        installation_id: seed.installationId,
        repo_id: null,
        workflow_id: "review-pr-acme-widget-7",
      };
      const first = await allocateWorkspace(input, {
        db: injectedDb(),
        clock: FIXED_CLOCK,
        workspaceRoot: root,
        identity: IDENTITY,
      });
      const second = await allocateWorkspace(input, {
        db: injectedDb(),
        clock: FIXED_CLOCK,
        workspaceRoot: root,
        identity: IDENTITY,
      });

      // The ON CONFLICT DO NOTHING + findActiveByRun resolution returns the SAME canonical workspace_id.
      expect(second.workspace_id).toBe(first.workspace_id);

      // Exactly ONE active lease exists for the run (the second INSERT was a no-op).
      const count = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM core.workspace_leases WHERE run_id = $1`,
        [seed.runId],
      );
      expect(Number(count.rows[0]?.n)).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await cleanupTenant(seed);
    }
  });
});
