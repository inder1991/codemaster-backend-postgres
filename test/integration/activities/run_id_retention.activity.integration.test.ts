/**
 * Integration test for the two PURE-DB run_id retention sweeps — REAL de-stubbed ports of the frozen
 * Python `@activity.defn run_id_retire_old_runs` + `@activity.defn run_id_delete_old_events`
 * (vendor/codemaster-py/codemaster/activities/run_id_retention.py), against a DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise. Every test scopes its seeded rows to
 * a UNIQUE random installation_id and DELETEs them in a `finally` (respecting FK order).
 *
 * The third activity (`run_id_close_stale_prs`) makes GitHub round-trips (list-PRs + PATCH-close) and is
 * covered by cassette-based tests, NOT this disposable-PG suite — so it is intentionally out of scope
 * here. The two activities exercised below are the pure-DB sweeps the disposable PG can fully verify.
 *
 * Coverage:
 *   runIdRetireOldRunsActivity — soft-delete (UPDATE … RETURNING) of terminal review_runs older than ttl:
 *     (A) COMPLETED run started 40d ago → RETIRED (retired_at set, retention_reason='ttl_expired').
 *     (B) FAILED run started 40d ago    → RETIRED.
 *     (C) COMPLETED run started now()   → PRESERVED (inside the retention window).
 *     (D) RUNNING run started 40d ago   → PRESERVED (non-terminal — the WHERE only matches COMPLETED/FAILED).
 *     (E) already-retired COMPLETED run → PRESERVED unchanged (retired_at IS NULL guard → idempotent).
 *     The result.retired counts ≥ this tenant's 2 retired runs; result.scanned === result.retired.
 *
 *   runIdDeleteOldEventsActivity — hard-DELETE of audit.workflow_events older than ttl:
 *     (F) workflow_event received 100d ago → DELETED.
 *     (G) workflow_event received now()    → PRESERVED.
 *     The result.deleted === result.scanned; result.batches ≥ 1 when work was done.
 *
 * NOTE: both sweeps are CROSS-TENANT (no installation_id filter — Python @privileged_path), so the
 * absolute scanned/deleted totals may include other tenants' aged rows under parallelism. This suite
 * runs with --no-file-parallelism and asserts PER-ROW on-disk state for its own seeded rows + the
 * scanned===retired / scanned===deleted invariants, rather than exact global totals.
 */

import { createHash, randomInt } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  runIdDeleteOldEventsActivity,
  runIdRetireOldRunsActivity,
} from "#backend/activities/run_id_retention.activity.js";

import {
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";

import { getPool, disposePool } from "#platform/db/database.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;

if (INTEGRATION_DSN) {
  pool = getPool(INTEGRATION_DSN);
}

/** Install a deterministic dev key registry so any audit before/after encryption has a key (no Vault). */
beforeAll(() => {
  const reg = new KeyRegistry();
  reg.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(0x42)]]) }));
  setAuditKeyRegistry(reg);
});

afterAll(async () => {
  resetAuditKeyRegistryForTesting();
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

function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

/** Seed the installation row the FK / tenancy needs. */
async function seedInstallation(installationId: string): Promise<void> {
  await pool.query(
    `INSERT INTO core.installations
       (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, uniqueBigint(), `acct-${installationId.slice(0, 8)}`],
  );
}

type RunSeed = { reviewId: string; runId: string; repoIdRef: number };

/**
 * Seed a review_run chain (repositories + pull_request_reviews + review_runs) under a shared
 * installation. Terminal states stamp the matching biconditional terminal timestamp so the AD-7 CHECKs
 * pass (ck_review_runs_completed_at_present / ck_review_runs_failed_at_present). `retiredAt=true` marks
 * the run already-retired (the idempotency fixture).
 */
async function seedRun(args: {
  installationId: string;
  lifecycleState: string;
  startedAtSql: string;
  alreadyRetired?: boolean;
}): Promise<RunSeed> {
  const reviewId = newUuid();
  const runId = newUuid();
  const repoIdRef = uniqueBigint();
  const prNumber = (uniqueBigint() % 9999) + 1;

  await pool.query(
    `INSERT INTO core.repositories
       (installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, 'main', true)`,
    [args.installationId, repoIdRef, `octo/repo-${repoIdRef}`],
  );
  await pool.query(
    `INSERT INTO core.pull_request_reviews
       (review_id, provider, repo_id, pr_number, provider_pr_id, status, current_run_id)
     VALUES ($1, 'github', $2, $3, $4, 'open', NULL)`,
    [reviewId, repoIdRef, prNumber, `pr-${repoIdRef}-${prNumber}`],
  );

  const terminalCol =
    args.lifecycleState === "COMPLETED"
      ? ", completed_at"
      : args.lifecycleState === "FAILED"
        ? ", failed_at"
        : "";
  const terminalVal =
    args.lifecycleState === "COMPLETED" || args.lifecycleState === "FAILED" ? ", now()" : "";
  const retiredCol = args.alreadyRetired ? ", retired_at, retention_reason" : "";
  const retiredVal = args.alreadyRetired ? ", now(), 'manual_cleanup'" : "";

  await pool.query(
    `INSERT INTO core.review_runs
       (run_id, review_id, trigger_type, lifecycle_state, started_at${terminalCol}${retiredCol})
     VALUES ($1, $2, 'pr_opened', $3, ${args.startedAtSql}${terminalVal}${retiredVal})`,
    [runId, reviewId, args.lifecycleState],
  );
  return { reviewId, runId, repoIdRef };
}

/** Tear down a tenant's seeded review_run rows in FK order. */
async function cleanupRuns(installationId: string, runs: ReadonlyArray<RunSeed>): Promise<void> {
  for (const r of runs) {
    await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [r.runId]);
  }
  for (const r of runs) {
    await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [r.reviewId]);
    await pool.query(`DELETE FROM core.repositories WHERE github_repo_id = $1`, [r.repoIdRef]);
  }
  await pool.query(`DELETE FROM audit.audit_events WHERE installation_id = $1`, [installationId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [installationId]);
}

type RetiredRow = { lifecycle_state: string; retired_at: Date | null; retention_reason: string | null };

async function runRow(runId: string): Promise<RetiredRow> {
  const r = await pool.query<RetiredRow>(
    `SELECT lifecycle_state, retired_at, retention_reason FROM core.review_runs WHERE run_id = $1`,
    [runId],
  );
  return r.rows[0]!;
}

describeDb("runIdRetireOldRunsActivity (integration, disposable PG)", () => {
  it("soft-deletes terminal runs past ttl, preserves recent/non-terminal/already-retired runs", async () => {
    const installationId = newUuid();
    await seedInstallation(installationId);

    const a = await seedRun({
      installationId,
      lifecycleState: "COMPLETED",
      startedAtSql: "now() - interval '40 days'",
    });
    const b = await seedRun({
      installationId,
      lifecycleState: "FAILED",
      startedAtSql: "now() - interval '40 days'",
    });
    const c = await seedRun({
      installationId,
      lifecycleState: "COMPLETED",
      startedAtSql: "now()",
    });
    const d = await seedRun({
      installationId,
      lifecycleState: "RUNNING",
      startedAtSql: "now() - interval '40 days'",
    });
    const e = await seedRun({
      installationId,
      lifecycleState: "COMPLETED",
      startedAtSql: "now() - interval '40 days'",
      alreadyRetired: true,
    });

    try {
      const result = await runIdRetireOldRunsActivity({
        dsn: INTEGRATION_DSN!,
        ttlDays: 30,
      });

      expect(result.schema_version).toBe(1);
      // scanned === retired (the Python returns scanned=retired=total_retired). Cross-tenant, so the
      // absolute total may include other tenants' aged rows; assert the invariant + ≥ this tenant's 2.
      expect(result.scanned).toBe(result.retired);
      expect(result.retired).toBeGreaterThanOrEqual(2);

      // (A) COMPLETED 40d → retired.
      const ra = await runRow(a.runId);
      expect(ra.retired_at).not.toBeNull();
      expect(ra.retention_reason).toBe("ttl_expired");

      // (B) FAILED 40d → retired.
      const rb = await runRow(b.runId);
      expect(rb.retired_at).not.toBeNull();
      expect(rb.retention_reason).toBe("ttl_expired");

      // (C) COMPLETED recent → preserved (inside window).
      const rc = await runRow(c.runId);
      expect(rc.retired_at).toBeNull();

      // (D) RUNNING 40d → preserved (non-terminal).
      const rd = await runRow(d.runId);
      expect(rd.retired_at).toBeNull();
      expect(rd.lifecycle_state).toBe("RUNNING");

      // (E) already-retired → preserved unchanged (retention_reason NOT overwritten to ttl_expired).
      const re = await runRow(e.runId);
      expect(re.retired_at).not.toBeNull();
      expect(re.retention_reason).toBe("manual_cleanup");
    } finally {
      await cleanupRuns(installationId, [a, b, c, d, e]);
    }
  });
});

// ─── run_id_delete_old_events ──────────────────────────────────────────────────────────────────────

type EventSeed = { eventId: string; runId: string; reviewId: string; repoIdRef: number };

/**
 * Seed a workflow_events row at a given received_at, with its FK chain (a review_run + review). The
 * run is COMPLETED + already-retired so the run-retire sweep never touches it (keeps the two activities'
 * fixtures isolated). Returns the seed handle for assertion + cleanup.
 */
async function seedEvent(args: {
  installationId: string;
  receivedAtSql: string;
}): Promise<EventSeed> {
  const run = await seedRun({
    installationId: args.installationId,
    lifecycleState: "COMPLETED",
    startedAtSql: "now()",
    alreadyRetired: true,
  });
  const eventId = newUuid();
  await pool.query(
    `INSERT INTO audit.workflow_events
       (event_id, provider, delivery_id, run_id, review_id, sequence_no, event_type, payload,
        received_at, installation_id)
     VALUES ($1, 'github', NULL, $2, $3, 1, 'lifecycle_transition', '{}'::jsonb, ${args.receivedAtSql}, $4)`,
    [eventId, run.runId, run.reviewId, args.installationId],
  );
  return { eventId, runId: run.runId, reviewId: run.reviewId, repoIdRef: run.repoIdRef };
}

async function eventExists(eventId: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM audit.workflow_events WHERE event_id = $1`, [eventId]);
  return r.rows.length > 0;
}

async function cleanupEvents(installationId: string, events: ReadonlyArray<EventSeed>): Promise<void> {
  for (const e of events) {
    await pool.query(`DELETE FROM audit.workflow_events WHERE event_id = $1`, [e.eventId]);
  }
  await cleanupRuns(
    installationId,
    events.map((e) => ({ reviewId: e.reviewId, runId: e.runId, repoIdRef: e.repoIdRef })),
  );
}

describeDb("runIdDeleteOldEventsActivity (integration, disposable PG)", () => {
  it("hard-deletes workflow_events past ttl, preserves recent events", async () => {
    const installationId = newUuid();
    await seedInstallation(installationId);

    const aged = await seedEvent({ installationId, receivedAtSql: "now() - interval '100 days'" });
    const fresh = await seedEvent({ installationId, receivedAtSql: "now()" });

    try {
      const result = await runIdDeleteOldEventsActivity({
        dsn: INTEGRATION_DSN!,
        ttlDays: 90,
      });

      expect(result.schema_version).toBe(1);
      // scanned === deleted (fused candidate-selection + mutation in one DELETE).
      expect(result.scanned).toBe(result.deleted);
      expect(result.deleted).toBeGreaterThanOrEqual(1);
      expect(result.batches).toBeGreaterThanOrEqual(1);

      // Aged event deleted; fresh event preserved.
      expect(await eventExists(aged.eventId)).toBe(false);
      expect(await eventExists(fresh.eventId)).toBe(true);
    } finally {
      // aged event already deleted by the sweep; cleanup is idempotent (DELETE WHERE no-op).
      await cleanupEvents(installationId, [aged, fresh]);
    }
  });
});
