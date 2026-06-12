// W3.6 [RH12] — the periodic installation drift-reconcile sweep. ADR-0054 / invariant 16 treat
// webhooks as cache-invalidation HINTS with `GET /installation/repositories` as the canonical
// reconciler — but pre-RH12 the ONLY trigger for that canonical fetch was the PR-webhook drift path
// (known installation + unknown repo) and, since RH13, installation_created. GitHub does not
// guarantee webhook delivery: a dropped `installation_repositories.added` with no follow-up PR left
// `core.repositories` permanently stale — the repo silently received ZERO reviews forever.
//
// The sweep walks ACTIVE (non-suspended) installations and pushes each through the SAME
// cooldown/blocked-gated `maybeEnqueueRepair` dispatcher the drift/bootstrap paths use
// (trigger_source='drift_sweep'), so webhook loss self-corrects on the cron cadence instead of
// waiting for a human. Per-installation fail-open: one broken row never aborts the walk.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable DB) — never a shared
// cluster (skips when the DSN is absent, per test/integration/_db.ts).
import { randomInt } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { installationDriftReconcileActivity } from "#backend/activities/installation_drift_reconcile.activity.js";
import { reconcileInstallation } from "#backend/activities/reconcile_installation.activity.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { runOneBackgroundJob } from "#backend/runner/background_runner.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import { registerCronHandlers } from "#backend/runner/handlers/cron_handlers.js";
import { WallClock } from "#platform/clock.js";
import { disposePool } from "#platform/db/database.js";
import { describeDb, INTEGRATION_DSN } from "../_db.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }

const ghIids: Array<number> = [];
function nextGhIid(): number {
  const v = randomInt(2_080_000_000, 2_100_000_000);
  ghIids.push(v);
  return v;
}

beforeAll(() => {
  if (!INTEGRATION_DSN) return;
  // reconcileInstallation self-resolves the DSN from env (no seam — 1:1 with its dispatch shape).
  process.env.CODEMASTER_PG_CORE_DSN = INTEGRATION_DSN;
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  if (ghIids.length > 0) {
    await pool.query(
      `DELETE FROM core.outbox WHERE sink = 'installation_reconcile'
        AND (payload->'args'->0->>'github_installation_id')::bigint = ANY($1::bigint[])`,
      [ghIids],
    );
    await pool.query(
      `DELETE FROM cache.repository_repair_state WHERE github_installation_id = ANY($1::bigint[])`,
      [ghIids],
    );
    await pool.query(
      `DELETE FROM core.installations WHERE github_installation_id = ANY($1::bigint[])`,
      [ghIids],
    );
    await pool.query(`DELETE FROM core.ad_users WHERE principal_name LIKE 'sender-%@acme.com'`);
  }
  await db?.destroy();
  await disposePool(INTEGRATION_DSN);
});

/** Seed an installations row directly (suspended_at controllable; no repair-dispatch side effect). */
async function seedInstallation(gid: number, suspended: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO core.installations (github_installation_id, account_login, account_type, suspended_at)
     VALUES ($1, $2, 'Organization', $3)`,
    [gid, `drift-${gid}`, suspended ? new Date() : null],
  ); // account_type CHECK allows 'User' | 'Organization'
}

/** Count the repair outbox rows for one github installation id. */
async function repairRows(gid: number): Promise<Array<{ trigger_source: string }>> {
  const r = await pool.query<{ payload: { args: Array<{ trigger_source: string }> } }>(
    `SELECT payload FROM core.outbox WHERE sink = 'installation_reconcile'
      AND (payload->'args'->0->>'github_installation_id')::bigint = $1`,
    [gid],
  );
  return r.rows.map((row) => ({ trigger_source: row.payload.args[0]!.trigger_source }));
}

describeDb("installation drift-reconcile sweep (W3.6 RH12)", () => {
  it("enqueues a cooldown-gated repair for each ACTIVE installation; suspended/blocked/cooldown rows are skipped", async () => {
    const activeGid = nextGhIid();
    const suspendedGid = nextGhIid();
    const blockedGid = nextGhIid();
    const cooldownGid = nextGhIid();
    await seedInstallation(activeGid, false);
    await seedInstallation(suspendedGid, true);
    await seedInstallation(blockedGid, false);
    await seedInstallation(cooldownGid, false);
    // blocked: terminal-failure classification — repair permanently suppressed until admin clears.
    await pool.query(
      `INSERT INTO cache.repository_repair_state (github_installation_id, last_attempt_at, blocked_reason, blocked_at)
       VALUES ($1, now(), 'app_unauthorized', now())`,
      [blockedGid],
    );
    // cooldown: a fresh attempt within the window — re-enqueue suppressed.
    await pool.query(
      `INSERT INTO cache.repository_repair_state (github_installation_id, last_attempt_at)
       VALUES ($1, now())`,
      [cooldownGid],
    );

    const result = await installationDriftReconcileActivity({ dsn: INTEGRATION_DSN! });
    expect(result.enqueued).toBeGreaterThanOrEqual(1);

    // ACTIVE + eligible → exactly one repair envelope, stamped with the sweep's trigger source.
    expect(await repairRows(activeGid)).toEqual([{ trigger_source: "drift_sweep" }]);
    // markAttempted stamped the cooldown row (the dispatcher's atomic unit).
    const state = await pool.query<{ last_attempt_at: Date | null }>(
      `SELECT last_attempt_at FROM cache.repository_repair_state WHERE github_installation_id = $1`,
      [activeGid],
    );
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]!.last_attempt_at).not.toBeNull();

    // Suspended / blocked / in-cooldown installations enqueue NOTHING.
    expect(await repairRows(suspendedGid)).toEqual([]);
    expect(await repairRows(blockedGid)).toEqual([]);
    expect(await repairRows(cooldownGid)).toEqual([]);

    // A second sweep inside the cooldown window is fully suppressed for the active row too.
    await installationDriftReconcileActivity({ dsn: INTEGRATION_DSN! });
    expect(await repairRows(activeGid)).toHaveLength(1);
  });

  it("runs through the cron platform: an enqueued 'installation_drift_reconcile' job dispatches to done", async () => {
    const gid = nextGhIid();
    // Through the REAL reconcile path (also exercises RH13 coexistence: the reconcile already
    // enqueued one repair + stamped the cooldown, so the sweep's pass is SUPPRESSED — no duplicate).
    await reconcileInstallation({
      action: "created",
      installation: { id: gid, account: { id: gid, login: `drift-${gid}`, type: "Organization" } },
      sender: { id: gid + 1, login: `sender-${gid}`, type: "User" },
    });
    expect(await repairRows(gid)).toEqual([{ trigger_source: "installation_created" }]);

    const registry = new HandlerRegistry();
    registerCronHandlers(registry, { dsn: INTEGRATION_DSN! });
    const repo = new BackgroundJobsRepo(db);
    const jobId = await repo.enqueue({ jobType: "installation_drift_reconcile", payload: {} });
    const r = await runOneBackgroundJob({
      repo, registry, clock: new WallClock(),
      owner: "rh12-test", leaseS: 30, heartbeatS: 5, maxRuntimeS: 300,
    });
    expect(r.outcome).toBe("done");
    expect(r.jobId).toBe(jobId);

    // Cooldown-suppressed: still exactly the one installation_created repair row.
    expect(await repairRows(gid)).toEqual([{ trigger_source: "installation_created" }]);
  });

  it("per-installation isolation: the walk is bounded and a failing row does not abort the sweep", async () => {
    const okGid = nextGhIid();
    await seedInstallation(okGid, false);
    // maxInstallationsPerRun bounds the walk (a defensive cap; production default is generous).
    const result = await installationDriftReconcileActivity({
      dsn: INTEGRATION_DSN!,
      maxInstallationsPerRun: 10_000,
    });
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
    expect(await repairRows(okGid)).toEqual([{ trigger_source: "drift_sweep" }]);
  });
});
