import { createHash, randomInt } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, expect, it } from "vitest";

import {
  acquirePrReviewMutex,
  advisoryKeys,
  releasePrReviewMutex,
  renewPrReviewMutexLease,
  withMutexTransaction,
} from "#backend/concurrency/pr_mutex.js";

import { getPool, disposePool } from "#platform/db/database.js";
import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// DB-gated integration test against a DISPOSABLE Postgres (migrations applied; core.pr_review_mutex
// present). Runs ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so
// validate-fast stays green without a DB. We NEVER touch any other DB. Every test uses a UNIQUE
// installation_id so per-tenant rows never collide, and cleans up its FK chain in `finally` blocks.
//
// Connection discipline: we use the SHARED ADR-0062 pool (getPool / disposePool) — NEVER a hand-rolled
// `new Pool(...)` (the pool-memoization guard would fail). The acquire critical section (advisory xact
// lock + FOR UPDATE + INSERT) runs on ONE checked-out client in ONE transaction via withMutexTransaction.

const FIXED_CLOCK = new FakeClock({ now: new Date("2099-03-04T05:06:07.000Z") });

let pool: Pool;

if (INTEGRATION_DSN) {
  // The shared pool is lazy (no socket until first query), so it is safe to obtain at module load
  // when the DSN is present; describeDb gates the actual queries.
  pool = getPool(INTEGRATION_DSN);
}

afterAll(async () => {
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

/** Deterministic-but-unique UUID for test fixtures (NOT security-sensitive; just unique-per-call). */
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

/** A small unique bigint so github_* unique columns never collide across tests. */
function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = {
  installationId: string;
  repositoryId: string;
};

/** Seed the FK chain (installation → repository) for one tenant — the parents the mutex FKs point at. */
async function seedTenant(): Promise<Seed> {
  const installationId = newUuid();
  const repositoryId = newUuid();
  const ghInstall = uniqueBigint();
  const ghRepo = uniqueBigint();

  await pool.query(
    `INSERT INTO core.installations
       (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, ghInstall, `acct-${ghInstall}`],
  );
  await pool.query(
    `INSERT INTO core.repositories
       (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, $4, 'main', true)`,
    [repositoryId, installationId, ghRepo, `org/repo-${ghRepo}`],
  );
  return { installationId, repositoryId };
}

/** Drop every mutex row + the FK parents for a tenant (ON DELETE CASCADE handles the mutex rows, but
 *  we delete explicitly first to keep the cleanup readable). */
async function cleanupTenant(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM core.pr_review_mutex WHERE installation_id = $1`, [
    seed.installationId,
  ]);
  await pool.query(`DELETE FROM core.repositories WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [
    seed.installationId,
  ]);
}

/** Count the LIVE (released_at IS NULL) mutex rows for a PR. */
async function liveRowCount(seed: Seed, prNumber: number): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM core.pr_review_mutex
       WHERE installation_id = $1 AND repository_id = $2 AND pr_number = $3 AND released_at IS NULL`,
    [seed.installationId, seed.repositoryId, prNumber],
  );
  return Number(r.rows[0]?.n ?? 0);
}

describeDb("acquirePrReviewMutex (integration, disposable PG)", () => {
  it("acquires on a fresh PR (acquired=true, mutex_id minted, one live row)", async () => {
    const seed = await seedTenant();
    try {
      const result = await withMutexTransaction(pool, (client) =>
        acquirePrReviewMutex({
          client,
          installationId: seed.installationId,
          repositoryId: seed.repositoryId,
          prNumber: 11,
          holderWorkflowId: "wf-A",
          clock: FIXED_CLOCK,
        }),
      );
      expect(result.acquired).toBe(true);
      expect(result.mutexId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(result.holderWorkflowId).toBe("wf-A");
      expect(await liveRowCount(seed, 11)).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("second acquire on the same PR while the lease is valid => acquired=false with prior holder", async () => {
    const seed = await seedTenant();
    try {
      const first = await withMutexTransaction(pool, (client) =>
        acquirePrReviewMutex({
          client,
          installationId: seed.installationId,
          repositoryId: seed.repositoryId,
          prNumber: 22,
          holderWorkflowId: "wf-holder",
          clock: FIXED_CLOCK,
        }),
      );
      expect(first.acquired).toBe(true);

      const second = await withMutexTransaction(pool, (client) =>
        acquirePrReviewMutex({
          client,
          installationId: seed.installationId,
          repositoryId: seed.repositoryId,
          prNumber: 22,
          holderWorkflowId: "wf-contender",
          clock: FIXED_CLOCK,
        }),
      );
      expect(second.acquired).toBe(false);
      expect(second.holderWorkflowId).toBe("wf-holder");
      expect(second.mutexId).toBeNull();
      // Still exactly one live row (the partial-unique index enforces it).
      expect(await liveRowCount(seed, 22)).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("a DIFFERENT PR acquires independently (no contention across PRs)", async () => {
    const seed = await seedTenant();
    try {
      const a = await withMutexTransaction(pool, (client) =>
        acquirePrReviewMutex({
          client,
          installationId: seed.installationId,
          repositoryId: seed.repositoryId,
          prNumber: 30,
          holderWorkflowId: "wf-30",
          clock: FIXED_CLOCK,
        }),
      );
      const b = await withMutexTransaction(pool, (client) =>
        acquirePrReviewMutex({
          client,
          installationId: seed.installationId,
          repositoryId: seed.repositoryId,
          prNumber: 31,
          holderWorkflowId: "wf-31",
          clock: FIXED_CLOCK,
        }),
      );
      expect(a.acquired).toBe(true);
      expect(b.acquired).toBe(true);
      expect(a.mutexId).not.toBe(b.mutexId);
      expect(await liveRowCount(seed, 30)).toBe(1);
      expect(await liveRowCount(seed, 31)).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("an EXPIRED lease is reclaimed: next acquire => acquired=true, old row marked released", async () => {
    const seed = await seedTenant();
    const prNumber = 40;
    try {
      // Insert a LIVE row whose lease is already in the PAST (a dead/wedged holder). The CHECK
      // `pr_review_mutex_live_has_lease` requires a non-NULL lease on a live row, so we use a past
      // timestamp (NOT NULL) to model expiry.
      const stale = await pool.query<{ mutex_id: string }>(
        `INSERT INTO core.pr_review_mutex
           (installation_id, repository_id, pr_number, holder_workflow_id,
            acquired_at, lease_expires_at, released_at)
         VALUES ($1, $2, $3, 'wf-dead', now() - interval '2 hours',
                 now() - interval '1 hour', NULL)
         RETURNING mutex_id`,
        [seed.installationId, seed.repositoryId, prNumber],
      );
      const staleMutexId = stale.rows[0]!.mutex_id;
      expect(await liveRowCount(seed, prNumber)).toBe(1);

      const reclaim = await withMutexTransaction(pool, (client) =>
        acquirePrReviewMutex({
          client,
          installationId: seed.installationId,
          repositoryId: seed.repositoryId,
          prNumber,
          holderWorkflowId: "wf-reclaimer",
          clock: FIXED_CLOCK,
        }),
      );
      expect(reclaim.acquired).toBe(true);
      expect(reclaim.mutexId).not.toBe(staleMutexId);
      expect(reclaim.holderWorkflowId).toBe("wf-reclaimer");

      // The old row is now released (audit preserved); exactly one live row remains (the fresh one).
      const oldRow = await pool.query<{ released_at: string | null }>(
        `SELECT released_at FROM core.pr_review_mutex WHERE mutex_id = $1`,
        [staleMutexId],
      );
      expect(oldRow.rows[0]?.released_at).not.toBeNull();
      expect(await liveRowCount(seed, prNumber)).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("the partial-unique index allows only ONE live row per (install, repo, pr)", async () => {
    const seed = await seedTenant();
    const prNumber = 50;
    try {
      await withMutexTransaction(pool, (client) =>
        acquirePrReviewMutex({
          client,
          installationId: seed.installationId,
          repositoryId: seed.repositoryId,
          prNumber,
          holderWorkflowId: "wf-first",
          clock: FIXED_CLOCK,
        }),
      );
      // A direct second INSERT of a live row must violate uq_pr_review_mutex_live_pr.
      await expect(
        pool.query(
          `INSERT INTO core.pr_review_mutex
             (installation_id, repository_id, pr_number, holder_workflow_id,
              acquired_at, lease_expires_at, released_at)
           VALUES ($1, $2, $3, 'wf-second', now(), now() + interval '30 min', NULL)`,
          [seed.installationId, seed.repositoryId, prNumber],
        ),
      ).rejects.toThrow(/uq_pr_review_mutex_live_pr|duplicate key/i);
      expect(await liveRowCount(seed, prNumber)).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("release marks released_at; a subsequent acquire then succeeds on the freed PR", async () => {
    const seed = await seedTenant();
    const prNumber = 60;
    try {
      const acquired = await withMutexTransaction(pool, (client) =>
        acquirePrReviewMutex({
          client,
          installationId: seed.installationId,
          repositoryId: seed.repositoryId,
          prNumber,
          holderWorkflowId: "wf-rel",
          clock: FIXED_CLOCK,
        }),
      );
      expect(acquired.acquired).toBe(true);
      const mutexId = acquired.mutexId!;

      await withMutexTransaction(pool, (client) =>
        releasePrReviewMutex({
          client,
          installationId: seed.installationId,
          mutexId,
          clock: FIXED_CLOCK,
        }),
      );

      const released = await pool.query<{ released_at: string | null }>(
        `SELECT released_at FROM core.pr_review_mutex WHERE mutex_id = $1`,
        [mutexId],
      );
      expect(released.rows[0]?.released_at).not.toBeNull();
      expect(await liveRowCount(seed, prNumber)).toBe(0);

      // The PR is free again — a brand-new acquire succeeds with a fresh mutex.
      const reAcquire = await withMutexTransaction(pool, (client) =>
        acquirePrReviewMutex({
          client,
          installationId: seed.installationId,
          repositoryId: seed.repositoryId,
          prNumber,
          holderWorkflowId: "wf-next",
          clock: FIXED_CLOCK,
        }),
      );
      expect(reAcquire.acquired).toBe(true);
      expect(reAcquire.mutexId).not.toBe(mutexId);
      expect(await liveRowCount(seed, prNumber)).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("renew extends a held lease (true); renew after release returns the lost-claim signal (false)", async () => {
    const seed = await seedTenant();
    const prNumber = 70;
    try {
      const acquired = await withMutexTransaction(pool, (client) =>
        acquirePrReviewMutex({
          client,
          installationId: seed.installationId,
          repositoryId: seed.repositoryId,
          prNumber,
          holderWorkflowId: "wf-renew",
          clock: FIXED_CLOCK,
        }),
      );
      const mutexId = acquired.mutexId!;

      const renewed = await withMutexTransaction(pool, (client) =>
        renewPrReviewMutexLease({
          client,
          installationId: seed.installationId,
          mutexId,
          leaseTtlSeconds: 60,
        }),
      );
      expect(renewed).toBe(true);

      // Release it, then renew again — the row is no longer live, so renew returns false (lost claim).
      await withMutexTransaction(pool, (client) =>
        releasePrReviewMutex({
          client,
          installationId: seed.installationId,
          mutexId,
          clock: FIXED_CLOCK,
        }),
      );
      const renewedAfterRelease = await withMutexTransaction(pool, (client) =>
        renewPrReviewMutexLease({
          client,
          installationId: seed.installationId,
          mutexId,
        }),
      );
      expect(renewedAfterRelease).toBe(false);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("derives advisory keys 1:1 with the frozen Python _advisory_keys", () => {
    // Known-answer vector confirmed against the frozen submodule's
    // `codemaster.concurrency.pr_mutex._advisory_keys` (positive int4 pair).
    const keys = advisoryKeys(
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      7,
    );
    expect(keys).toEqual([2041465061, 1578127812]);
  });
});
