// Integration test for the cache.repository_repair_state helpers (F-5b) against the DISPOSABLE Postgres
// (set CODEMASTER_PG_CORE_DSN at a throwaway DB with migrations applied — NEVER the cluster; SKIPs
// otherwise). FAITHFUL-port verification of get_state_for_enqueue_decision / mark_attempted /
// clear_on_success / mark_blocked.
//
// Each test uses a UNIQUE github_installation_id so rows are isolatable; teardown deletes them all.

import { randomInt } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  clearOnSuccess,
  getStateForEnqueueDecision,
  markAttempted,
  markBlocked,
  REPAIR_BLOCKED_REASONS,
} from "#backend/ingest/_repair_state.js";

import { getPool, disposePool, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;
if (INTEGRATION_DSN) {
  pool = getPool(INTEGRATION_DSN);
}

// A pool of unique github_installation_id values for this run (bigint; large random to avoid collisions).
const ghIids: Array<number> = [];
function nextGhIid(): number {
  const v = randomInt(2_000_000_000, 2_100_000_000);
  ghIids.push(v);
  return v;
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  if (ghIids.length > 0) {
    await pool.query(
      `DELETE FROM cache.repository_repair_state WHERE github_installation_id = ANY($1::bigint[])`,
      [ghIids],
    );
  }
  await disposePool(INTEGRATION_DSN);
});

async function rowOf(
  gid: number,
): Promise<
  | { last_attempt_at: Date; blocked_reason: string | null; blocked_at: Date | null }
  | undefined
> {
  const res = await pool.query<{
    last_attempt_at: Date;
    blocked_reason: string | null;
    blocked_at: Date | null;
  }>(
    `SELECT last_attempt_at, blocked_reason, blocked_at FROM cache.repository_repair_state
       WHERE github_installation_id = $1`,
    [gid],
  );
  return res.rows[0];
}

describeDb("cache.repository_repair_state helpers (integration, disposable PG)", () => {
  it("getStateForEnqueueDecision on an unknown installation → allow (no row)", async () => {
    const db = tenantKysely(INTEGRATION_DSN!);
    const gid = nextGhIid();
    const d = await getStateForEnqueueDecision(db, { githubInstallationId: gid });
    expect(d).toEqual({
      allowEnqueue: true,
      cooldownActive: false,
      isBlocked: false,
      blockedReason: null,
    });
  });

  it("markAttempted upserts last_attempt_at; a fresh attempt is within the cooldown window → suppress", async () => {
    const db = tenantKysely(INTEGRATION_DSN!);
    const gid = nextGhIid();

    await markAttempted(db, { githubInstallationId: gid });
    const row = await rowOf(gid);
    expect(row).toBeDefined();
    expect(row!.blocked_reason).toBeNull();
    expect(row!.blocked_at).toBeNull();

    // last_attempt_at = now() → inside the default 300s cooldown → cooldown suppresses a second enqueue.
    const d = await getStateForEnqueueDecision(db, { githubInstallationId: gid });
    expect(d.cooldownActive).toBe(true);
    expect(d.isBlocked).toBe(false);
    expect(d.allowEnqueue).toBe(false);
  });

  it("an attempt OLDER than the cooldown window → allow again", async () => {
    const db = tenantKysely(INTEGRATION_DSN!);
    const gid = nextGhIid();
    await markAttempted(db, { githubInstallationId: gid });
    // Age the attempt past the default 300s window (push it 10 minutes into the past).
    await pool.query(
      `UPDATE cache.repository_repair_state SET last_attempt_at = now() - interval '600 seconds'
         WHERE github_installation_id = $1`,
      [gid],
    );
    const d = await getStateForEnqueueDecision(db, { githubInstallationId: gid });
    expect(d.cooldownActive).toBe(false);
    expect(d.allowEnqueue).toBe(true);
  });

  it("markBlocked sets blocked_reason + blocked_at; blocked_at suppresses (blocked supersedes cooldown)", async () => {
    const db = tenantKysely(INTEGRATION_DSN!);
    const gid = nextGhIid();
    await markBlocked(db, { githubInstallationId: gid, blockedReason: "installation_not_found" });

    const row = await rowOf(gid);
    expect(row!.blocked_reason).toBe("installation_not_found");
    expect(row!.blocked_at).not.toBeNull();

    const d = await getStateForEnqueueDecision(db, { githubInstallationId: gid });
    expect(d.isBlocked).toBe(true);
    expect(d.blockedReason).toBe("installation_not_found");
    expect(d.allowEnqueue).toBe(false);
  });

  it("markBlocked is an UPSERT — re-blocking with a new reason overwrites it", async () => {
    const db = tenantKysely(INTEGRATION_DSN!);
    const gid = nextGhIid();
    await markBlocked(db, { githubInstallationId: gid, blockedReason: "installation_not_found" });
    await markBlocked(db, { githubInstallationId: gid, blockedReason: "app_unauthorized" });
    const row = await rowOf(gid);
    expect(row!.blocked_reason).toBe("app_unauthorized");
  });

  it("every bounded blocked_reason value satisfies the SQL CHECK constraint", async () => {
    const db = tenantKysely(INTEGRATION_DSN!);
    for (const reason of REPAIR_BLOCKED_REASONS) {
      const gid = nextGhIid();
      await markBlocked(db, { githubInstallationId: gid, blockedReason: reason });
      const row = await rowOf(gid);
      expect(row!.blocked_reason).toBe(reason);
    }
  });

  it("clearOnSuccess DELETEs the row entirely (cooldown + block lifted)", async () => {
    const db = tenantKysely(INTEGRATION_DSN!);
    const gid = nextGhIid();
    await markBlocked(db, { githubInstallationId: gid, blockedReason: "app_uninstalled" });
    expect(await rowOf(gid)).toBeDefined();

    await clearOnSuccess(db, { githubInstallationId: gid });
    expect(await rowOf(gid)).toBeUndefined();

    // After clear, the next decision is a clean allow.
    const d = await getStateForEnqueueDecision(db, { githubInstallationId: gid });
    expect(d.allowEnqueue).toBe(true);
  });
});
