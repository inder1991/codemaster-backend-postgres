// Integration test for PostgresOutboxRepo (the producer write-surface) — runs against the DISPOSABLE
// Postgres (CODEMASTER_PG_CORE_DSN — localhost:5434 ONLY, NEVER the cluster). Verifies the three append
// methods insert valid core.outbox rows: the sink value, JSONB payload round-trip, installation_id /
// run_id handling, and the ck_outbox_installation_id_required exemption for the reconcile sink.

import { randomInt, randomUUID } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresOutboxRepo } from "#backend/domain/repos/outbox_repo.js";

import { getPool, disposePool, tenantKysely } from "#platform/db/database.js";
import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;
if (INTEGRATION_DSN) {
  pool = getPool(INTEGRATION_DSN);
}

const repo = new PostgresOutboxRepo();
// A unique tag so each run's rows are isolatable for assertion + cleanup.
const RUN_TAG = `outbox-it-${randomUUID()}`;
const installationId = randomUUID();
const reviewId = randomUUID();
const runId = randomUUID();
const ghRepo = randomInt(1, 2_000_000_000);

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  await pool.query(
    `INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, ghRepo, `acct-${ghRepo}`],
  );
  await pool.query(
    `INSERT INTO core.pull_request_reviews (review_id, provider, repo_id, pr_number, provider_pr_id, current_run_id)
     VALUES ($1, 'github', $2, 1, $3, NULL)`,
    [reviewId, ghRepo, `pr-${ghRepo}`],
  );
  await pool.query(
    `INSERT INTO core.review_runs (run_id, review_id, trigger_type) VALUES ($1, $2, 'pr_opened')`,
    [runId, reviewId],
  );
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  // Order matters: outbox.run_id → review_runs is ON DELETE RESTRICT, so drop outbox rows first.
  await pool.query(`DELETE FROM core.outbox WHERE delivery_id LIKE $1`, [`${RUN_TAG}%`]);
  await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [runId]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [reviewId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [installationId]);
  await disposePool(INTEGRATION_DSN);
});

async function fetchByDelivery(delivery: string): Promise<Record<string, unknown> | undefined> {
  const res = await pool.query<Record<string, unknown>>(
    `SELECT sink, payload, schema_version, run_id, installation_id, state, attempts, delivery_id
       FROM core.outbox WHERE delivery_id = $1`,
    [delivery],
  );
  return res.rows[0];
}

describeDb("PostgresOutboxRepo (integration, disposable PG)", () => {
  describe("the three typed producer methods", () => {
    it("appendReconcile → installation_reconcile sink, NULL installation_id (the schema exemption)", async () => {
      const db = tenantKysely(INTEGRATION_DSN!);
      const delivery = `${RUN_TAG}-reconcile`;
      await repo.appendReconcile({ db, payload: { account: "octo" }, schemaVersion: 1, deliveryId: delivery });
      const row = await fetchByDelivery(delivery);
      expect(row).toBeDefined();
      expect(row!["sink"]).toBe("installation_reconcile");
      expect(row!["installation_id"]).toBeNull();
      expect(row!["run_id"]).toBeNull();
      expect(row!["state"]).toBe("pending");
      expect(Number(row!["attempts"])).toBe(0);
      expect(row!["payload"]).toEqual({ account: "octo" });
    });

    it("appendNonReviewDispatch → temporal_workflow_start sink, installation_id set, NULL run_id", async () => {
      const db = tenantKysely(INTEGRATION_DSN!);
      const delivery = `${RUN_TAG}-nonreview`;
      await repo.appendNonReviewDispatch({
        db,
        workflowType: "syncCodeOwners",
        payload: { workflow_type: "syncCodeOwners", args: [] },
        schemaVersion: 2,
        installationId,
        deliveryId: delivery,
      });
      const row = await fetchByDelivery(delivery);
      expect(row!["sink"]).toBe("temporal_workflow_start");
      expect(row!["installation_id"]).toBe(installationId);
      expect(row!["run_id"]).toBeNull();
    });

    it("appendReviewDispatch → temporal_workflow_start sink, run_id + installation_id both set", async () => {
      const db = tenantKysely(INTEGRATION_DSN!);
      const delivery = `${RUN_TAG}-review`;
      await repo.appendReviewDispatch({
        db,
        runId,
        payload: { workflow_type: "reviewPullRequest", args: [{ pr_id: "x" }] },
        schemaVersion: 2,
        installationId,
        deliveryId: delivery,
      });
      const row = await fetchByDelivery(delivery);
      expect(row!["sink"]).toBe("temporal_workflow_start");
      expect(row!["run_id"]).toBe(runId);
      expect(row!["installation_id"]).toBe(installationId);
      expect(row!["schema_version"]).toBe(2);
    });
  });

  describe("the consumer methods (claim lease + mark transitions)", () => {
    const fakeClock = new FakeClock({ now: new Date("2026-06-06T12:00:00.000Z") });
    const cRepo = new PostgresOutboxRepo({ clock: fakeClock });

    async function seedPending(tag: string): Promise<string> {
      const db = tenantKysely(INTEGRATION_DSN!);
      await cRepo.appendNonReviewDispatch({
        db,
        workflowType: "syncCodeOwners",
        payload: {},
        schemaVersion: 2,
        installationId,
        deliveryId: `${RUN_TAG}-${tag}`,
      });
      const res = await pool.query<{ id: string }>(`SELECT id FROM core.outbox WHERE delivery_id = $1`, [
        `${RUN_TAG}-${tag}`,
      ]);
      return res.rows[0]!.id;
    }
    async function rowOf(
      id: string,
    ): Promise<{ state: string; attempts: number; leasedUntil: Date | null }> {
      const res = await pool.query<{ state: string; attempts: number; leased_until: Date | null }>(
        `SELECT state, attempts, leased_until FROM core.outbox WHERE id = $1`,
        [id],
      );
      const r = res.rows[0]!;
      return { state: r.state, attempts: Number(r.attempts), leasedUntil: r.leased_until };
    }

    it("W3.1 dead-letter: listDead surfaces dead rows (no payload); replayDead resets fences + returns prior", async () => {
      const db = tenantKysely(INTEGRATION_DSN!);
      const id = await seedPending("dead-letter");
      await cRepo.markDead({ db, id, error: "boom: permanent sink failure" });
      await pool.query(`UPDATE core.outbox SET attempts = 3 WHERE id = $1`, [id]);

      const dead = await cRepo.listDead({ db, limit: 100 });
      const mine = dead.find((d) => d.id === id);
      expect(mine).toBeDefined();
      expect(mine!.last_error).toContain("boom");
      expect(mine!.attempts).toBe(3);
      expect(mine).not.toHaveProperty("payload"); // never surfaces the (possibly secret-bearing) payload

      const prior = await cRepo.replayDead({ db, id });
      expect(prior).toEqual({ priorAttempts: 3, priorError: "boom: permanent sink failure" });
      const after = await rowOf(id);
      expect(after.state).toBe("pending"); // re-claimable by the dispatcher
      expect(after.attempts).toBe(0); // fence cleared
      expect(after.leasedUntil).toBeNull();
    });

    it("W3.1 dead-letter: replayDead on a NON-dead row is a no-op → null (fenced to state='dead')", async () => {
      const db = tenantKysely(INTEGRATION_DSN!);
      const id = await seedPending("replay-noop"); // still 'pending'
      expect(await cRepo.replayDead({ db, id })).toBeNull();
      expect((await rowOf(id)).state).toBe("pending"); // untouched
    });

    it("claimPending claims a pending row, holds the lease, then re-claims after expiry", async () => {
      fakeClock.set({ now: new Date("2026-06-06T12:00:00.000Z") });
      const db = tenantKysely(INTEGRATION_DSN!);
      const id = await seedPending("claim");

      const claim1 = await cRepo.claimPending({ db, leaseSeconds: 60 });
      expect(claim1.some((r) => r.id === id)).toBe(true);

      const claim2 = await cRepo.claimPending({ db, leaseSeconds: 60 });
      expect(claim2.some((r) => r.id === id)).toBe(false); // leased — not re-claimed within the window

      fakeClock.advance({ seconds: 61 });
      const claim3 = await cRepo.claimPending({ db, leaseSeconds: 60 });
      expect(claim3.some((r) => r.id === id)).toBe(true); // lease expired → re-claimable

      await cRepo.markDispatched({ db, id, expectedAttempts: 0 });
    });

    it("markAttemptFailed below maxAttempts → stays pending, attempts+1, leased_until deferred by backoff, returns {state,sink}", async () => {
      fakeClock.set({ now: new Date("2026-06-06T12:00:00.000Z") });
      const db = tenantKysely(INTEGRATION_DSN!);
      const id = await seedPending("fail-retry");
      await cRepo.claimPending({ db, leaseSeconds: 60 }); // lease it

      const r = await cRepo.markAttemptFailed({ db, id, error: "boom", maxAttempts: 5, expectedAttempts: 0 });
      expect(r).toEqual({ state: "pending", sink: "temporal_workflow_start" });
      const row = await rowOf(id);
      expect(row.attempts).toBe(1);
      expect(row.state).toBe("pending");
      // NOT released (a NULL lease would make the row IMMEDIATELY re-claimable → busy-loop on a
      // persistently-failing sink). Deferred: leased_until = now + BASE(2s) * 2^0 prior attempts.
      expect(row.leasedUntil).not.toBeNull();
      expect(row.leasedUntil!.getTime()).toBe(new Date("2026-06-06T12:00:02.000Z").getTime());
    });

    it("markAttemptFailed backoff grows exponentially with prior attempts and caps at 300s", async () => {
      fakeClock.set({ now: new Date("2026-06-06T12:00:00.000Z") });
      const db = tenantKysely(INTEGRATION_DSN!);
      const id = await seedPending("fail-backoff-curve");

      // Second failure (prior attempts = 1) → 2 * 2^1 = 4s.
      await cRepo.markAttemptFailed({ db, id, error: "e1", maxAttempts: 50, expectedAttempts: 0 });
      await cRepo.markAttemptFailed({ db, id, error: "e2", maxAttempts: 50, expectedAttempts: 1 });
      expect((await rowOf(id)).leasedUntil!.getTime()).toBe(
        new Date("2026-06-06T12:00:04.000Z").getTime(),
      );

      // Deep-attempt failure (prior attempts = 20 → 2 * 2^20 s uncapped) → capped at 300s.
      await pool.query(`UPDATE core.outbox SET attempts = 20 WHERE id = $1`, [id]);
      await cRepo.markAttemptFailed({ db, id, error: "e21", maxAttempts: 50, expectedAttempts: 20 });
      expect((await rowOf(id)).leasedUntil!.getTime()).toBe(
        new Date("2026-06-06T12:05:00.000Z").getTime(),
      );
    });

    it("markAttemptFailed at maxAttempts → atomic dead-transition (leased_until NULL), returns {state:'dead',sink}", async () => {
      const db = tenantKysely(INTEGRATION_DSN!);
      const id = await seedPending("fail-dead");

      const r = await cRepo.markAttemptFailed({ db, id, error: "give up", maxAttempts: 1, expectedAttempts: 0 });
      expect(r?.state).toBe("dead");
      expect(r?.sink).toBe("temporal_workflow_start");
      const row = await rowOf(id);
      expect(row.state).toBe("dead");
      expect(row.leasedUntil).toBeNull(); // terminal — no backoff, never re-claimed
    });

    it("markAttemptFailed is a redrive no-op when expectedAttempts mismatches (R-6 idempotency)", async () => {
      const db = tenantKysely(INTEGRATION_DSN!);
      const id = await seedPending("fail-redrive");

      const first = await cRepo.markAttemptFailed({ db, id, error: "e", maxAttempts: 5, expectedAttempts: 0 });
      expect(first?.state).toBe("pending");
      expect((await rowOf(id)).attempts).toBe(1);
      // Redrive: same expectedAttempts:0 but attempts is now 1 → WHERE matches nothing → null, no double bump.
      const redrive = await cRepo.markAttemptFailed({ db, id, error: "e", maxAttempts: 5, expectedAttempts: 0 });
      expect(redrive).toBeNull();
      expect((await rowOf(id)).attempts).toBe(1);
    });

    it("markDispatched transitions pending→dispatched (returns timing); redrive on dispatched → null", async () => {
      const db = tenantKysely(INTEGRATION_DSN!);
      const id = await seedPending("dispatched");

      const r = await cRepo.markDispatched({ db, id, expectedAttempts: 0 });
      expect(r).not.toBeNull();
      expect(r).toHaveProperty("createdAt");
      expect((await rowOf(id)).state).toBe("dispatched");
      // Idempotent under redrive: a second markDispatched on a now-dispatched row updates nothing → null.
      expect(await cRepo.markDispatched({ db, id, expectedAttempts: 0 })).toBeNull();
    });

    it("markDispatched is FENCED on attempts (N2): a stale settle after another pod re-claimed+failed is a no-op", async () => {
      fakeClock.set({ now: new Date("2026-06-06T12:00:00.000Z") });
      const db = tenantKysely(INTEGRATION_DSN!);
      const id = await seedPending("fenced");
      // Pod A claims at attempts=0. Pod A stalls; lease expires; Pod B re-claims + FAILS → attempts=1, still pending.
      await cRepo.claimPending({ db, leaseSeconds: 60 });
      await cRepo.markAttemptFailed({ db, id, error: "pod-B transient", maxAttempts: 5, expectedAttempts: 0 });
      expect((await rowOf(id)).attempts).toBe(1);
      // Pod A wakes and tries to settle SUCCESS with its STALE claim snapshot (attempts=0) → fenced → no-op.
      expect(await cRepo.markDispatched({ db, id, expectedAttempts: 0 })).toBeNull();
      expect((await rowOf(id)).state).toBe("pending"); // NOT clobbered to dispatched
      // The pod that actually owns the row now (attempts=1) CAN settle it.
      expect(await cRepo.markDispatched({ db, id, expectedAttempts: 1 })).not.toBeNull();
      expect((await rowOf(id)).state).toBe("dispatched");
    });

    it("extendLease pushes leased_until forward from the injected clock", async () => {
      fakeClock.set({ now: new Date("2026-06-06T12:00:00.000Z") });
      const db = tenantKysely(INTEGRATION_DSN!);
      const id = await seedPending("extend");
      await cRepo.claimPending({ db, leaseSeconds: 60 }); // leased_until = 12:01:00

      await cRepo.extendLease({ db, id, leaseSeconds: 120 }); // leased_until = 12:02:00
      const leased = (await rowOf(id)).leasedUntil;
      expect(leased).not.toBeNull();
      expect(leased!.getTime()).toBe(new Date("2026-06-06T12:02:00.000Z").getTime());
    });

    it("markDead is terminal (ops-only manual path)", async () => {
      const db = tenantKysely(INTEGRATION_DSN!);
      const id = await seedPending("dead-ops");
      await cRepo.markDead({ db, id, error: "manual" });
      expect((await rowOf(id)).state).toBe("dead");
    });
  });
});
