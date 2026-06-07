// Integration test for the 3 auto-registration activities against the DISPOSABLE Postgres
// (CODEMASTER_PG_CORE_DSN at a throwaway DB with migrations applied — NEVER the cluster; SKIPs
// otherwise). Proves each activity COMPOSES its upsert helpers end-to-end against real rows:
//
//   - reconcileInstallation  (name "reconcile_installation_activity") — validates the payload, upserts
//     core.installations + core.users/core.ad_users, maps created→updated on re-apply.
//   - reconcileRepositories  (name "reconcile_repositories_activity") — validates, resolves the internal
//     installation_id, upserts added repos (auto-enable), soft-removes removed repos; out-of-order
//     (no installations row) THROWS so Temporal redrives; enabled-preservation on re-add.
//   - doHydrateInstallationRepositories — pure body with an injected FAKE GitHub client + the REAL
//     repair-state port over the disposable DB: success path upserts repos + clears repair_state;
//     terminal 404 → markBlocked(installation_not_found) + blocked result; terminal 403 →
//     app_unauthorized; the markBlocked tx is independent of the (deferred) audit tx.
//
// Each test uses UNIQUE github ids so rows are isolatable; teardown deletes them all.

import { randomInt } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { reconcileInstallation } from "#backend/activities/reconcile_installation.activity.js";
import { reconcileRepositories } from "#backend/activities/reconcile_repositories.activity.js";
import {
  type GitHubListReposPort,
  type RepairStatePort,
  doHydrateInstallationRepositories,
  hydrateDbPortFromKysely,
  repairStatePortFromModule,
} from "#backend/activities/hydrate_installation_repositories.activity.js";
import {
  GitHubForbiddenError,
  GitHubNotFoundError,
  type InstallationRepositoryV1,
} from "#backend/integrations/github/api_client.js";

import { WallClock } from "#platform/clock.js";
import { disposePool, getPool, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;
if (INTEGRATION_DSN) {
  pool = getPool(INTEGRATION_DSN);
}

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
  // The activities read the DSN from process.env; mirror it so the activity's pool + this reader pool
  // both point at the disposable DB. Set unconditionally inside the gated block.
  process.env.CODEMASTER_PG_CORE_DSN = INTEGRATION_DSN;
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
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
    await pool.query(`DELETE FROM core.installations WHERE github_installation_id = ANY($1::bigint[])`, [
      ghIids,
    ]);
    await pool.query(`DELETE FROM core.ad_users WHERE principal_name LIKE 'sender-%@acme.com'`);
  }
  await disposePool(INTEGRATION_DSN);
});

const clock = new WallClock();

/** Build a serialized GitHubInstallationPayloadV1 dict (the bare-dict activity input). */
function installationPayload(args: {
  action: "created" | "deleted" | "suspended" | "unsuspended";
  gid: number;
  login: string;
  senderLogin?: string;
  senderType?: string;
  accountType?: string;
}): Record<string, unknown> {
  return {
    action: args.action,
    installation: {
      id: args.gid,
      account: { id: args.gid, login: args.login, type: args.accountType ?? "Organization" },
    },
    sender: {
      id: args.gid + 1,
      login: args.senderLogin ?? args.login,
      type: args.senderType ?? "User",
    },
  };
}

describeDb("reconcile/hydrate activities (integration, disposable PG)", () => {
  it("reconcileInstallation INSERT → action 'created'; re-apply 'created' → 'updated' (prior row exists)", async () => {
    const gid = nextGhIid();
    const login = `sender-${gid}`;

    const r1 = await reconcileInstallation(
      installationPayload({ action: "created", gid, login, senderLogin: login }),
    );
    expect(r1.action).toBe("created");
    expect(r1.installation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r1.user_id).not.toBeNull();

    const r2 = await reconcileInstallation(
      installationPayload({ action: "created", gid, login, senderLogin: login }),
    );
    expect(r2.action).toBe("updated"); // prior installations row existed → created maps to updated
    expect(r2.installation_id).toBe(r1.installation_id);

    // a 'suspended' action passes through + stamps suspended_at.
    const r3 = await reconcileInstallation(
      installationPayload({ action: "suspended", gid, login, senderLogin: login }),
    );
    expect(r3.action).toBe("suspended");
    const susp = (
      await pool.query<{ suspended_at: Date | null }>(
        `SELECT suspended_at FROM core.installations WHERE github_installation_id = $1`,
        [gid],
      )
    ).rows[0]!;
    expect(susp.suspended_at).not.toBeNull();
  });

  it("reconcileRepositories: added auto-enables + counts; removed soft-disables; counts are faithful", async () => {
    const gid = nextGhIid();
    const login = `sender-${gid}`;
    await reconcileInstallation(
      installationPayload({ action: "created", gid, login, senderLogin: login }),
    );

    const repoA = nextGhRepoId();
    const repoB = nextGhRepoId();
    const addPayload = {
      action: "added",
      installation: { id: gid },
      sender: { id: gid + 1, login, type: "User" },
      repositories_added: [
        { id: repoA, full_name: "acme/a", owner: { id: 1, login, type: "Organization" } },
        { id: repoB, full_name: "acme/b", owner: { id: 1, login, type: "Organization" } },
      ],
    };
    const added = await reconcileRepositories(addPayload);
    expect(added.added).toBe(2);
    expect(added.removed).toBe(0);

    const enabledRows = await pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM core.repositories WHERE github_repo_id = ANY($1::bigint[])`,
      [[repoA, repoB]],
    );
    expect(enabledRows.rows.every((r) => r.enabled === true)).toBe(true); // auto-enable

    // Remove repoA (recorded) + a never-recorded repo → removed counts ONLY the recorded one.
    const unknownRepo = nextGhRepoId();
    const removed = await reconcileRepositories({
      action: "removed",
      installation: { id: gid },
      sender: { id: gid + 1, login, type: "User" },
      repositories_removed: [
        { id: repoA, full_name: "acme/a", owner: { id: 1, login, type: "Organization" } },
        { id: unknownRepo, full_name: "acme/ghost", owner: { id: 1, login, type: "Organization" } },
      ],
    });
    expect(removed.removed).toBe(1); // only repoA was recorded
    expect(removed.added).toBe(0);

    const aRow = (
      await pool.query<{ archived: boolean; enabled: boolean }>(
        `SELECT archived, enabled FROM core.repositories WHERE github_repo_id = $1`,
        [repoA],
      )
    ).rows[0]!;
    expect(aRow.archived).toBe(true);
    expect(aRow.enabled).toBe(false); // soft-disabled, row still present
  });

  it("reconcileRepositories THROWS (retryable) when the installation row is not yet recorded", async () => {
    const gid = nextGhIid(); // no installations row for this gid
    const login = `sender-${gid}`;
    await expect(
      reconcileRepositories({
        action: "added",
        installation: { id: gid },
        sender: { id: gid + 1, login, type: "User" },
        repositories_added: [
          { id: nextGhRepoId(), full_name: "acme/c", owner: { id: 1, login, type: "Organization" } },
        ],
      }),
    ).rejects.toThrow(/not yet recorded; retry/);
  });

  it("doHydrate success path: fake GitHub repos upserted (auto-enable) + repair_state cleared", async () => {
    const gid = nextGhIid();
    const login = `sender-${gid}`;
    await reconcileInstallation(
      installationPayload({ action: "created", gid, login, senderLogin: login }),
    );

    // Seed a repair_state row so we can assert clearOnSuccess removed it.
    await pool.query(
      `INSERT INTO cache.repository_repair_state (github_installation_id, last_attempt_at) VALUES ($1, now())`,
      [gid],
    );

    const repoA = nextGhRepoId();
    const fakeRepos: Array<InstallationRepositoryV1> = [
      { id: repoA, full_name: "acme/hydrated", default_branch: "trunk", archived: false },
    ];
    const github: GitHubListReposPort = {
      listInstallationRepositories: async () => fakeRepos,
    };
    const db = tenantKysely(INTEGRATION_DSN!);

    const res = await doHydrateInstallationRepositories(
      { schema_version: 1, github_installation_id: gid, trigger_source: "installation_created" },
      {
        github,
        db: hydrateDbPortFromKysely(db),
        repairState: repairStatePortFromModule(), // the REAL repair-state adapter over the disposable DB
        clock,
      },
    );
    expect(res.blocked).toBe(false);
    expect(res.newly_created).toBe(1);
    expect(res.refreshed).toBe(0);

    const row = (
      await pool.query<{ enabled: boolean; default_branch: string }>(
        `SELECT enabled, default_branch FROM core.repositories WHERE github_repo_id = $1`,
        [repoA],
      )
    ).rows[0]!;
    expect(row.enabled).toBe(true); // hydrate auto-enables
    expect(row.default_branch).toBe("trunk");

    const stateRows = await pool.query(
      `SELECT 1 FROM cache.repository_repair_state WHERE github_installation_id = $1`,
      [gid],
    );
    expect(stateRows.rowCount).toBe(0); // clearOnSuccess deleted it

    // Re-run with the same repo → refreshed (UPDATE path), newly_created=0.
    const res2 = await doHydrateInstallationRepositories(
      { schema_version: 1, github_installation_id: gid, trigger_source: "admin_manual" },
      { github, db: hydrateDbPortFromKysely(db), repairState: repairStatePortFromModule(), clock },
    );
    expect(res2.newly_created).toBe(0);
    expect(res2.refreshed).toBe(1);
  });

  it("doHydrate terminal 404 → markBlocked(installation_not_found) + blocked result (no re-throw)", async () => {
    const gid = nextGhIid();
    const github: GitHubListReposPort = {
      listInstallationRepositories: async () => {
        throw new GitHubNotFoundError("404 installation gone");
      },
    };
    const db = tenantKysely(INTEGRATION_DSN!);

    const res = await doHydrateInstallationRepositories(
      { schema_version: 1, github_installation_id: gid, trigger_source: "pr_webhook" },
      { github, db: hydrateDbPortFromKysely(db), repairState: repairStatePortFromModule(), clock },
    );
    expect(res.blocked).toBe(true);
    expect(res.blocked_reason).toBe("installation_not_found");

    const state = (
      await pool.query<{ blocked_reason: string | null; blocked_at: Date | null }>(
        `SELECT blocked_reason, blocked_at FROM cache.repository_repair_state WHERE github_installation_id = $1`,
        [gid],
      )
    ).rows[0]!;
    expect(state.blocked_reason).toBe("installation_not_found");
    expect(state.blocked_at).not.toBeNull(); // markBlocked committed in its OWN transaction
  });

  it("doHydrate terminal 403 → markBlocked(app_unauthorized) + blocked result", async () => {
    const gid = nextGhIid();
    const github: GitHubListReposPort = {
      listInstallationRepositories: async () => {
        throw new GitHubForbiddenError("403 forbidden");
      },
    };
    const db = tenantKysely(INTEGRATION_DSN!);

    const res = await doHydrateInstallationRepositories(
      { schema_version: 1, github_installation_id: gid, trigger_source: "pr_webhook" },
      { github, db: hydrateDbPortFromKysely(db), repairState: repairStatePortFromModule(), clock },
    );
    expect(res.blocked).toBe(true);
    expect(res.blocked_reason).toBe("app_unauthorized");

    const state = (
      await pool.query<{ blocked_reason: string | null }>(
        `SELECT blocked_reason FROM cache.repository_repair_state WHERE github_installation_id = $1`,
        [gid],
      )
    ).rows[0]!;
    expect(state.blocked_reason).toBe("app_unauthorized");
  });

  it("doHydrate re-throws a non-terminal error (5xx-class) so Temporal retries", async () => {
    const gid = nextGhIid();
    const github: GitHubListReposPort = {
      listInstallationRepositories: async () => {
        throw new Error("GitHub 503 after retries"); // not a terminal-classified type → propagates
      },
    };
    const repairState: RepairStatePort = {
      markBlocked: async () => {
        throw new Error("markBlocked must NOT be called on a non-terminal error");
      },
      clearOnSuccess: async () => {
        throw new Error("clearOnSuccess must NOT be called on a non-terminal error");
      },
    };
    const db = tenantKysely(INTEGRATION_DSN!);
    await expect(
      doHydrateInstallationRepositories(
        { schema_version: 1, github_installation_id: gid, trigger_source: "pr_webhook" },
        { github, db: hydrateDbPortFromKysely(db), repairState, clock },
      ),
    ).rejects.toThrow(/503/);
  });
});
