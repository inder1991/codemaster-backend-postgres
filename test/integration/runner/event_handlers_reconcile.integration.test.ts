// Phase 3d W3d.1: the 3 reconcile EVENT-DRIVEN handlers — reconcile_installation /
// reconcile_repositories / repair_installation_repositories — adapted from the Temporal
// thin-proxy workflows (reconcile.workflow.ts: reconcileInstallation / reconcileRepositories /
// repairInstallationRepositories) onto the Postgres background-jobs platform. Proves:
//   (1) PARITY (reconcile_installation): an enqueued 'reconcile_installation' job driven through ONE
//       background cycle produces the SAME DB effect as calling reconcileInstallation directly — the
//       core.installations row is upserted (suspended_at NULL on 'created'); a follow-up 'suspended'
//       job stamps suspended_at. Driven via buildBackgroundRunner, so the test ALSO proves the
//       composition root registers the event handlers (registerEventHandlers wiring).
//   (2) PARITY (reconcile_repositories): added repos upsert + auto-enable; removed repos soft-disable
//       (archived = true, enabled = false) — the row survives (NOT a DELETE).
//   (3) RETRY SEMANTICS (out-of-order webhook): a reconcile_repositories job whose parent installation
//       is not yet recorded FAILS the attempt (the platform analogue of the Temporal redrive: the job
//       re-enqueues 'ready' with last_error persisted — NOT dead-lettered).
//   (4) PARITY (repair_installation_repositories): with an injected fake GitHub list-repos port the
//       handler drives the REAL doHydrateInstallationRepositories body — canonical repos upserted
//       (auto-enable) + the cache.repository_repair_state cooldown row cleared on success.
// Plus the pure (no-DB) checks: WORKFLOW_TYPE_TO_JOB_TYPE carries EXACTLY the 3 reconcile entries,
// keyed by the byte-exact Temporal workflow_type strings the producers stamp
// (github_webhook_persistence.ts / _repair_dispatcher.ts), and every mapped job_type has a registered
// handler (the next wave's outbox temporal_workflow_start cutover reads this map — an unmapped or
// unregistered value would dead-letter every dispatched row as `no handler for <job_type>`).
//
// Determinism note (the W4 suite's proven pattern): runner cycles run under a WallClock composition
// because runOneBackgroundJob's hard-timeout race is microtask-ordered under FakeClock — generous
// ceilings (300s vs ms-fast upserts) keep the outcome deterministic without timing sensitivity.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { randomInt } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { WallClock } from "#platform/clock.js";
import { disposePool } from "#platform/db/database.js";
import type {
  GitHubListReposPort,
} from "#backend/activities/hydrate_installation_repositories.activity.js";
import type { InstallationRepositoryV1 } from "#backend/integrations/github/api_client.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { runOneBackgroundJob } from "#backend/runner/background_runner.js";
import {
  buildBackgroundRunner,
  type BackgroundRunnerConfig,
} from "#backend/runner/background_runner_main.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import { registerCronHandlers } from "#backend/runner/handlers/cron_handlers.js";
import { registerEventHandlers } from "#backend/runner/handlers/event_handlers.js";
import { WORKFLOW_TYPE_TO_JOB_TYPE } from "#backend/runner/workflow_job_map.js";
import { describeDb, INTEGRATION_DSN } from "../_db.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }

/** Unique GitHub surrogate ids, tracked for teardown (same idiom as the reconcile activity suite). */
const ghIids: Array<number> = [];
const ghRepoIds: Array<number> = [];
function nextGhIid(): number {
  const v = randomInt(2_000_000_000, 2_040_000_000);
  ghIids.push(v);
  return v;
}
function nextGhRepoId(): number {
  const v = randomInt(2_040_000_000, 2_080_000_000);
  ghRepoIds.push(v);
  return v;
}

beforeAll(() => {
  if (!INTEGRATION_DSN) return;
  // The reconcile activities self-resolve the DSN from process.env (no injection seam — 1:1 with
  // their Temporal dispatch); mirror the test DSN so the activity pool hits the disposable DB.
  process.env.CODEMASTER_PG_CORE_DSN = INTEGRATION_DSN;
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  if (ghIids.length > 0) {
    // RH13: the reconcile_installation handler now appends repair outbox rows; clean ours up.
    await pool.query(
      `DELETE FROM core.outbox WHERE sink = 'installation_reconcile'
        AND (payload->'args'->0->>'github_installation_id')::bigint = ANY($1::bigint[])`,
      [ghIids],
    );
  }
  if (ghRepoIds.length > 0) {
    await pool.query(`DELETE FROM core.repositories WHERE github_repo_id = ANY($1::bigint[])`, [
      ghRepoIds,
    ]);
  }
  if (ghIids.length > 0) {
    await pool.query(
      `DELETE FROM cache.repository_repair_state WHERE github_installation_id = ANY($1::bigint[])`,
      [ghIids],
    );
    // core.users / core.repositories FK rows cascade with the installations DELETE (confdeltype 'c').
    await pool.query(`DELETE FROM core.installations WHERE github_installation_id = ANY($1::bigint[])`, [
      ghIids,
    ]);
    await pool.query(`DELETE FROM core.ad_users WHERE principal_name LIKE 'sender-%@acme.com'`);
  }
  await db?.destroy();                       // the test's OWN pool
  // The activities resolve the shared platform pool from CODEMASTER_PG_CORE_DSN; dispose it too.
  await disposePool(INTEGRATION_DSN);
});

// AUTHORIZED DEVIATION (test isolation — same rationale as cron_handlers_daily.integration.test.ts):
// vitest.config.ts shuffles test order, and claim() is a cross-job_type scan over ALL
// core.background_jobs rows; per-test wipes keep claim targets exact. Safe because test:integration
// runs --no-file-parallelism (files never interleave) and the other writers clean their own rows.
beforeEach(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.background_jobs`.execute(db);
  }
});

/** Bounded test config (the W4 suite's proven shape): generous ceilings (ms-fast upserts never graze
 *  them), huge sleeps (the single-shot drive seams never enter them). */
const TEST_CONFIG: BackgroundRunnerConfig = {
  owner: "w3d1-event-test", leaseS: 30, heartbeatS: 5, maxRuntimeS: 300, idleS: 30, pollIntervalS: 600,
  outboxIdleS: 600, outboxMaxAttempts: 5,
};

/** Serialized GitHubInstallationPayloadV1 dict (the bare-dict payload the producers enqueue). */
function installationPayload(args: {
  action: "created" | "deleted" | "suspended" | "unsuspended";
  gid: number;
  login: string;
}): Record<string, unknown> {
  return {
    action: args.action,
    installation: {
      id: args.gid,
      account: { id: args.gid, login: args.login, type: "Organization" },
    },
    sender: { id: args.gid + 1, login: args.login, type: "User" },
  };
}

describeDb("event_handlers — reconcile×3 on the background-jobs platform (Phase 3d W3d.1)", () => {
  it("(1) PARITY: 'reconcile_installation' jobs upsert core.installations through one cycle each (created → suspended)", async () => {
    const gid = nextGhIid();
    const login = `sender-${gid}`;
    const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
    const repo = new BackgroundJobsRepo(db);

    const createdId = await repo.enqueue({
      jobType: "reconcile_installation",
      payload: installationPayload({ action: "created", gid, login }),
    });
    const r1 = await handles.runOneCycle();
    expect(r1.outcome).toBe("done");
    expect(r1.jobId).toBe(createdId);
    expect((await repo.getById(createdId))!.state).toBe("done");

    // The Temporal-activity effect, reproduced through the handler path: the installations row exists.
    const created = await pool.query<{ account_login: string; suspended_at: Date | null }>(
      `SELECT account_login, suspended_at FROM core.installations WHERE github_installation_id = $1`,
      [gid],
    );
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0]!.account_login).toBe(login);
    expect(created.rows[0]!.suspended_at).toBeNull();

    // A follow-up 'suspended' event job stamps suspended_at on the SAME row (upsert, not duplicate).
    await repo.enqueue({
      jobType: "reconcile_installation",
      payload: installationPayload({ action: "suspended", gid, login }),
    });
    expect((await handles.runOneCycle()).outcome).toBe("done");
    const suspended = await pool.query<{ suspended_at: Date | null }>(
      `SELECT suspended_at FROM core.installations WHERE github_installation_id = $1`,
      [gid],
    );
    expect(suspended.rows).toHaveLength(1);
    expect(suspended.rows[0]!.suspended_at).not.toBeNull();
  });

  it("(1b) RH13/W3.6: 'reconcile_installation' proactively enqueues the cooldown-gated repair (installation_created)", async () => {
    // The frozen Python enqueues RepairInstallationRepositoriesWorkflow UNCONDITIONALLY at the end
    // of reconcile_installation (trigger_source='installation_created') so a fresh App install
    // hydrates its repos immediately — NOT lazily when the first PR webhook happens to hit an
    // unknown repo. Pre-RH13 the TS port carried only a FOLLOW-UP comment: a dropped/delayed
    // installation_repositories webhook left a 500-repo org with ZERO reviews indefinitely.
    const gid = nextGhIid();
    const login = `sender-${gid}`;
    const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
    const repo = new BackgroundJobsRepo(db);

    await repo.enqueue({
      jobType: "reconcile_installation",
      payload: installationPayload({ action: "created", gid, login }),
    });
    expect((await handles.runOneCycle()).outcome).toBe("done");

    // The repair dispatch landed as an installation_reconcile outbox row carrying the repair
    // envelope (the SAME cooldown-gated path the PR-webhook drift detection uses).
    const outboxRows = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM core.outbox WHERE sink = 'installation_reconcile'
        AND (payload->'args'->0->>'github_installation_id')::bigint = $1`,
      [gid],
    );
    expect(outboxRows.rows).toHaveLength(1);
    const envelope = outboxRows.rows[0]!.payload as {
      workflow_type: string;
      args: Array<{ trigger_source: string }>;
    };
    expect(envelope.workflow_type).toBe("repairInstallationRepositories");
    expect(envelope.args[0]!.trigger_source).toBe("installation_created");

    // markAttempted stamped the cooldown row in the SAME transaction.
    const stateRows = await pool.query<{ last_attempt_at: Date | null }>(
      `SELECT last_attempt_at FROM cache.repository_repair_state WHERE github_installation_id = $1`,
      [gid],
    );
    expect(stateRows.rows).toHaveLength(1);
    expect(stateRows.rows[0]!.last_attempt_at).not.toBeNull();

    // A SECOND reconcile inside the cooldown window is SUPPRESSED (no second outbox row) — the
    // repair-spam throttle the dispatcher owns.
    await repo.enqueue({
      jobType: "reconcile_installation",
      payload: installationPayload({ action: "unsuspended", gid, login }),
    });
    expect((await handles.runOneCycle()).outcome).toBe("done");
    const after = await pool.query(
      `SELECT 1 FROM core.outbox WHERE sink = 'installation_reconcile'
        AND (payload->'args'->0->>'github_installation_id')::bigint = $1`,
      [gid],
    );
    expect(after.rows).toHaveLength(1);
  });

  it("(2) PARITY: 'reconcile_repositories' jobs upsert added repos (auto-enable) + soft-disable removed repos", async () => {
    const gid = nextGhIid();
    const login = `sender-${gid}`;
    const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
    const repo = new BackgroundJobsRepo(db);

    // Parent installation first (through the platform — the same chain the webhook producers drive).
    await repo.enqueue({
      jobType: "reconcile_installation",
      payload: installationPayload({ action: "created", gid, login }),
    });
    expect((await handles.runOneCycle()).outcome).toBe("done");

    const repoA = nextGhRepoId();
    const repoB = nextGhRepoId();
    await repo.enqueue({
      jobType: "reconcile_repositories",
      payload: {
        action: "added",
        installation: { id: gid },
        sender: { id: gid + 1, login, type: "User" },
        repositories_added: [
          { id: repoA, full_name: "acme/a", owner: { id: 1, login, type: "Organization" } },
          { id: repoB, full_name: "acme/b", owner: { id: 1, login, type: "Organization" } },
        ],
      },
    });
    expect((await handles.runOneCycle()).outcome).toBe("done");
    const enabledRows = await pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM core.repositories WHERE github_repo_id = ANY($1::bigint[])`,
      [[repoA, repoB]],
    );
    expect(enabledRows.rows).toHaveLength(2);
    expect(enabledRows.rows.every((r) => r.enabled === true)).toBe(true); // auto-enable on add

    // Removed → SOFT-disable (archived + disabled), the row survives (FK/audit preservation).
    await repo.enqueue({
      jobType: "reconcile_repositories",
      payload: {
        action: "removed",
        installation: { id: gid },
        sender: { id: gid + 1, login, type: "User" },
        repositories_removed: [
          { id: repoA, full_name: "acme/a", owner: { id: 1, login, type: "Organization" } },
        ],
      },
    });
    expect((await handles.runOneCycle()).outcome).toBe("done");
    const aRow = await pool.query<{ archived: boolean; enabled: boolean }>(
      `SELECT archived, enabled FROM core.repositories WHERE github_repo_id = $1`,
      [repoA],
    );
    expect(aRow.rows).toHaveLength(1); // soft-disabled, NOT deleted
    expect(aRow.rows[0]!.archived).toBe(true);
    expect(aRow.rows[0]!.enabled).toBe(false);
  });

  it("(3) RETRY: out-of-order 'reconcile_repositories' (parent installation unknown) fails the attempt + re-enqueues 'ready'", async () => {
    const gid = nextGhIid(); // NO installations row for this gid
    const login = `sender-${gid}`;
    const handles = buildBackgroundRunner({ db, clock: new WallClock(), config: TEST_CONFIG });
    const repo = new BackgroundJobsRepo(db);

    const jobId = await repo.enqueue({
      jobType: "reconcile_repositories",
      payload: {
        action: "added",
        installation: { id: gid },
        sender: { id: gid + 1, login, type: "User" },
        repositories_added: [
          { id: nextGhRepoId(), full_name: "acme/c", owner: { id: 1, login, type: "Organization" } },
        ],
      },
    });
    const r = await handles.runOneCycle();
    expect(r.outcome).toBe("failed");
    expect(r.jobId).toBe(jobId);

    // The platform analogue of the Temporal redrive: markFailed re-enqueued 'ready' (attempts < max)
    // with the activity's retry-me error persisted — the installation webhook landing later lets the
    // next claim succeed. NOT dead-lettered (a plain Error is transient, unlike a ZodError payload).
    const settled = (await repo.getById(jobId))!;
    expect(settled.state).toBe("ready");
    expect(settled.last_error).toMatch(/not yet recorded/);
  });

  it("(4) PARITY: 'repair_installation_repositories' with an injected GitHub port hydrates repos + clears repair state", async () => {
    const gid = nextGhIid();
    const login = `sender-${gid}`;
    // Parent installation row (direct seed — the repair journey assumes the installation exists).
    await pool.query(
      `INSERT INTO core.installations (github_installation_id, account_login, account_type)
       VALUES ($1, $2, 'Organization')`,
      [gid, login],
    );
    // A cooldown row so clearOnSuccess has something to delete.
    await pool.query(
      `INSERT INTO cache.repository_repair_state (github_installation_id, last_attempt_at)
       VALUES ($1, now())`,
      [gid],
    );

    const repoA = nextGhRepoId();
    const fakeRepos: Array<InstallationRepositoryV1> = [
      { id: repoA, full_name: "acme/hydrated", default_branch: "trunk", archived: false },
    ];
    const listCalls: Array<number> = [];
    const github: GitHubListReposPort = {
      listInstallationRepositories: async ({ installationId }) => {
        listCalls.push(installationId);
        return fakeRepos;
      },
    };

    // OWN registry with the fake GitHub port injected (the composition-root seam registerEventHandlers
    // exposes — production omits it and the handler builds the deferred-Vault client instead).
    const registry = new HandlerRegistry();
    registerEventHandlers(registry, { dsn: INTEGRATION_DSN!, hydrateGithub: github });
    const repo = new BackgroundJobsRepo(db);
    const jobId = await repo.enqueue({
      jobType: "repair_installation_repositories",
      payload: { schema_version: 1, github_installation_id: gid, trigger_source: "pr_webhook" },
    });
    const r = await runOneBackgroundJob({
      repo, registry, clock: new WallClock(),
      owner: TEST_CONFIG.owner, leaseS: TEST_CONFIG.leaseS, heartbeatS: TEST_CONFIG.heartbeatS,
      maxRuntimeS: TEST_CONFIG.maxRuntimeS,
    });
    expect(r.outcome).toBe("done");
    expect(r.jobId).toBe(jobId);
    expect(listCalls).toEqual([gid]); // the canonical GitHub fetch ran, with the payload's numeric id

    // Canonical repo upserted (auto-enable) — the doHydrate success-path effect.
    const row = await pool.query<{ enabled: boolean; default_branch: string }>(
      `SELECT enabled, default_branch FROM core.repositories WHERE github_repo_id = $1`,
      [repoA],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.enabled).toBe(true);
    expect(row.rows[0]!.default_branch).toBe("trunk");

    // clearOnSuccess removed the cooldown row.
    const stateRows = await pool.query(
      `SELECT 1 FROM cache.repository_repair_state WHERE github_installation_id = $1`,
      [gid],
    );
    expect(stateRows.rowCount).toBe(0);
  });
});

// ─── WORKFLOW_TYPE_TO_JOB_TYPE (pure — no DB) ──────────────────────────────────────────────────────
describe("WORKFLOW_TYPE_TO_JOB_TYPE (Phase 3d W3d.1 registry start + W3d.2 widening)", () => {
  it("maps the 6 event-driven Temporal workflow_type strings to the registered job_types, byte-exact", () => {
    // Keys are the EXACT workflow_type strings the producers stamp on outbox rows:
    // github_webhook_persistence.ts (reconcileInstallation / reconcileRepositories),
    // _repair_dispatcher.ts (repairInstallationRepositories), and _push_emitters.ts
    // (syncCodeOwners / refreshSemanticDocs — W3d.2) — plus the Phase 3e.3
    // triggerPageResyncWorkflow, whose key is the REGISTERED workflow type (the exported function
    // name; the admin PageResyncDispatcherPort producer is unwired in production today, so the
    // registered type is the canonical identity a future dispatcher must stamp). The outbox
    // temporal_workflow_start cutover reads this map — a drifted key strands the outbox row.
    expect(WORKFLOW_TYPE_TO_JOB_TYPE).toEqual({
      reconcileInstallation: "reconcile_installation",
      reconcileRepositories: "reconcile_repositories",
      repairInstallationRepositories: "repair_installation_repositories",
      syncCodeOwners: "sync_code_owners",
      refreshSemanticDocs: "refresh_semantic_docs",
      triggerPageResyncWorkflow: "trigger_page_resync",
    });
  });

  it("every mapped job_type has a registered handler (an unmapped value would dead-letter at claim)", () => {
    const registry = new HandlerRegistry();
    registerCronHandlers(registry, {});
    registerEventHandlers(registry, {});
    for (const jobType of Object.values(WORKFLOW_TYPE_TO_JOB_TYPE)) {
      expect(registry.registeredTypes()).toContain(jobType);
    }
  });
});
