// Integration test for the shared reconcile/hydrate upsert helpers (ingest/_reconcile_persistence.ts)
// against the DISPOSABLE Postgres (set CODEMASTER_PG_CORE_DSN at a throwaway DB with migrations applied
// — NEVER the cluster; SKIPs otherwise). FAITHFUL-port verification of upsertInstallation /
// ensureSenderUser / upsertRepository / removeRepository.
//
// The LOAD-BEARING assertion is the default-deny / auto-enable interplay (CLAUDE.md invariant 10):
// upsertRepository sets `enabled` ONLY on INSERT (from enabledOnInsert) and OMITS it from the DO UPDATE
// SET clause, so an admin's later enable/disable choice is PRESERVED across a re-add cycle.
//
// Each test uses UNIQUE github_installation_id / github_repo_id values so rows are isolatable; teardown
// deletes them all.

import { randomInt } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  ensureSenderUser,
  removeRepository,
  resolveAccountType,
  upsertInstallation,
  upsertRepository,
} from "#backend/ingest/_reconcile_persistence.js";

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
  const v = randomInt(2_100_000_000, 2_140_000_000);
  ghIids.push(v);
  return v;
}
function nextGhRepoId(): number {
  const v = randomInt(2_140_000_000, 2_147_000_000);
  ghRepoIds.push(v);
  return v;
}

beforeAll(() => {
  if (!INTEGRATION_DSN) return;
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  if (ghRepoIds.length > 0) {
    await pool.query(`DELETE FROM core.repositories WHERE github_repo_id = ANY($1::bigint[])`, [
      ghRepoIds,
    ]);
  }
  if (ghIids.length > 0) {
    // CASCADE: users → ad_users(SET NULL); deleting installations cascades repositories/users.
    await pool.query(`DELETE FROM core.installations WHERE github_installation_id = ANY($1::bigint[])`, [
      ghIids,
    ]);
    // ad_users principal rows are not FK-bound to installation; clean any we created by login pattern.
    await pool.query(`DELETE FROM core.ad_users WHERE principal_name LIKE 'recon-%@acme.com'`);
  }
  await disposePool(INTEGRATION_DSN);
});

const clock = new WallClock();

describeDb("ingest/_reconcile_persistence helpers (integration, disposable PG)", () => {
  it("resolveAccountType collapses non-Organization (incl. Bot) → User", () => {
    expect(resolveAccountType("Organization")).toBe("Organization");
    expect(resolveAccountType("User")).toBe("User");
    expect(resolveAccountType("Bot")).toBe("User");
  });

  it("upsertInstallation INSERTs (before={}), then UPDATEs (before populated, created_at preserved)", async () => {
    const db = tenantKysely(INTEGRATION_DSN!);
    const gid = nextGhIid();

    const ins = await db
      .transaction()
      .execute(async (tx) =>
        upsertInstallation(tx, {
          githubInstallationId: gid,
          accountLogin: "acme-org",
          accountType: "Organization",
          newSuspendedAt: null,
          clock,
        }),
      );
    expect(ins.before).toEqual({});
    expect(ins.after.account_login).toBe("acme-org");
    expect(ins.after.suspended_at).toBeNull();

    const createdAt = (
      await pool.query<{ created_at: Date }>(
        `SELECT created_at FROM core.installations WHERE github_installation_id = $1`,
        [gid],
      )
    ).rows[0]!.created_at;

    // Re-apply with a suspend (deleted/suspended → newSuspendedAt = now). created_at must NOT move.
    const suspendAt = clock.now();
    const upd = await db
      .transaction()
      .execute(async (tx) =>
        upsertInstallation(tx, {
          githubInstallationId: gid,
          accountLogin: "acme-org-renamed",
          accountType: "Organization",
          newSuspendedAt: suspendAt,
          clock,
        }),
      );
    expect(upd.id).toBe(ins.id); // same row (ON CONFLICT keyed on github_installation_id)
    expect(upd.before).not.toEqual({});
    expect((upd.before as { account_login: string }).account_login).toBe("acme-org");
    expect(upd.after.account_login).toBe("acme-org-renamed");
    expect(upd.after.suspended_at).not.toBeNull();

    const row = (
      await pool.query<{ created_at: Date; account_login: string; suspended_at: Date | null }>(
        `SELECT created_at, account_login, suspended_at FROM core.installations
           WHERE github_installation_id = $1`,
        [gid],
      )
    ).rows[0]!;
    expect(row.created_at.getTime()).toBe(createdAt.getTime()); // insert-only
    expect(row.account_login).toBe("acme-org-renamed");
    expect(row.suspended_at).not.toBeNull();
  });

  it("ensureSenderUser: User sender seeds ad_users + users; Bot sender → ad_user_id NULL but user created", async () => {
    const db = tenantKysely(INTEGRATION_DSN!);
    const gid = nextGhIid();
    const login = `recon-${gid}`;

    const inst = await db
      .transaction()
      .execute(async (tx) =>
        upsertInstallation(tx, {
          githubInstallationId: gid,
          accountLogin: login,
          accountType: "Organization",
          newSuspendedAt: null,
          clock,
        }),
      );

    // User sender → ad_users row created, users.ad_user_id non-null.
    const userId = await db
      .transaction()
      .execute(async (tx) =>
        ensureSenderUser(tx, {
          installationId: inst.id,
          senderLogin: login,
          senderType: "User",
          clock,
        }),
      );
    const urow = (
      await pool.query<{ email: string; display_name: string; ad_user_id: string | null }>(
        `SELECT email, display_name, ad_user_id FROM core.users WHERE user_id = $1`,
        [userId],
      )
    ).rows[0]!;
    expect(urow.email).toBe(`${login}@acme.com`); // plaintext (faithful to the raw-SQL Python path)
    expect(urow.display_name).toBe(login);
    expect(urow.ad_user_id).not.toBeNull();

    // Bot sender → NO ad_users row created, users.ad_user_id NULL, but a user row IS created.
    const botLogin = `recon-${gid}-bot`;
    const botUserId = await db
      .transaction()
      .execute(async (tx) =>
        ensureSenderUser(tx, {
          installationId: inst.id,
          senderLogin: botLogin,
          senderType: "Bot",
          clock,
        }),
      );
    const brow = (
      await pool.query<{ ad_user_id: string | null }>(
        `SELECT ad_user_id FROM core.users WHERE user_id = $1`,
        [botUserId],
      )
    ).rows[0]!;
    expect(brow.ad_user_id).toBeNull();
    const botAd = await pool.query(`SELECT 1 FROM core.ad_users WHERE principal_name = $1`, [
      `${botLogin}@acme.com`,
    ]);
    expect(botAd.rowCount).toBe(0);
    // cleanup the bot-login ad principal pattern is covered by the recon-% LIKE teardown.
  });

  it("upsertRepository PRESERVES enabled on the UPDATE path (invariant 10 — the load-bearing assertion)", async () => {
    const db = tenantKysely(INTEGRATION_DSN!);
    const gid = nextGhIid();
    const repoId = nextGhRepoId();

    const inst = await db
      .transaction()
      .execute(async (tx) =>
        upsertInstallation(tx, {
          githubInstallationId: gid,
          accountLogin: `recon-${gid}`,
          accountType: "Organization",
          newSuspendedAt: null,
          clock,
        }),
      );

    // INSERT with enabledOnInsert=true → enabled=true.
    const ins = await db
      .transaction()
      .execute(async (tx) =>
        upsertRepository(tx, {
          installationId: inst.id,
          githubRepoId: repoId,
          fullName: "acme/widget",
          defaultBranch: "main",
          archived: false,
          enabledOnInsert: true,
          clock,
        }),
      );
    expect(ins.before).toEqual({});
    expect(ins.after.enabled).toBe(true);

    // Admin DISABLES the repo out-of-band (the admin enable/disable seam touches only `enabled`).
    await pool.query(`UPDATE core.repositories SET enabled = false WHERE github_repo_id = $1`, [
      repoId,
    ]);

    // Re-add the SAME repo with enabledOnInsert=true — the UPDATE path must NOT re-enable it.
    const upd = await db
      .transaction()
      .execute(async (tx) =>
        upsertRepository(tx, {
          installationId: inst.id,
          githubRepoId: repoId,
          fullName: "acme/widget-renamed",
          defaultBranch: "develop",
          archived: false,
          enabledOnInsert: true, // would re-enable IF the UPDATE touched `enabled` — it must NOT
          clock,
        }),
      );
    expect(upd.id).toBe(ins.id);
    expect(upd.before).not.toEqual({});
    // after.enabled reflects the PRESERVED prior value (false), NOT the insert literal (true).
    expect(upd.after.enabled).toBe(false);
    // metadata DID refresh.
    expect(upd.after.full_name).toBe("acme/widget-renamed");
    expect(upd.after.default_branch).toBe("develop");

    const row = (
      await pool.query<{ enabled: boolean; full_name: string; default_branch: string }>(
        `SELECT enabled, full_name, default_branch FROM core.repositories WHERE github_repo_id = $1`,
        [repoId],
      )
    ).rows[0]!;
    expect(row.enabled).toBe(false); // admin's disable survived the re-add (invariant 10)
    expect(row.full_name).toBe("acme/widget-renamed");
    expect(row.default_branch).toBe("develop");
  });

  it("removeRepository soft-disables (archived=true, enabled=false), NOT a DELETE; no-op when unknown", async () => {
    const db = tenantKysely(INTEGRATION_DSN!);
    const gid = nextGhIid();
    const repoId = nextGhRepoId();

    const inst = await db
      .transaction()
      .execute(async (tx) =>
        upsertInstallation(tx, {
          githubInstallationId: gid,
          accountLogin: `recon-${gid}`,
          accountType: "Organization",
          newSuspendedAt: null,
          clock,
        }),
      );
    await db
      .transaction()
      .execute(async (tx) =>
        upsertRepository(tx, {
          installationId: inst.id,
          githubRepoId: repoId,
          fullName: "acme/to-remove",
          enabledOnInsert: true,
          clock,
        }),
      );

    const rm = await db
      .transaction()
      .execute(async (tx) => removeRepository(tx, { githubRepoId: repoId, clock }));
    expect(rm.id).not.toBeNull();
    expect(rm.after).toEqual({ archived: true, enabled: false });

    const row = (
      await pool.query<{ archived: boolean; enabled: boolean }>(
        `SELECT archived, enabled FROM core.repositories WHERE github_repo_id = $1`,
        [repoId],
      )
    ).rows[0]!;
    expect(row.archived).toBe(true);
    expect(row.enabled).toBe(false); // soft-disable: row STILL EXISTS (not deleted)

    // Removing a never-recorded repo → (null, {}, {}) no-op.
    const unknown = await db
      .transaction()
      .execute(async (tx) => removeRepository(tx, { githubRepoId: nextGhRepoId(), clock }));
    expect(unknown.id).toBeNull();
    expect(unknown.before).toEqual({});
  });
});
