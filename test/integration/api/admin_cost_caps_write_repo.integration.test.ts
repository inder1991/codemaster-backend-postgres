/**
 * Integration test for the cost-cap WRITE orchestration (request/approve/reject) against the DISPOSABLE
 * Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set.
 *
 * Isolation: exercises apply via per_org_override (its own cost_cap_overrides row) + a RAISE, so it never
 * mutates and never asserts the shared global/per_org_default settings singletons (which the cost-caps READ
 * test owns). It only ensures those rows EXIST (the approve guard), without deleting them.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  CostCapConcurrentPendingChangeError,
  CostCapInvalidRequestError,
  CostCapPendingChangeNotFoundError,
  CostCapPendingChangeStaleError,
  CostCapSelfApprovalError,
  approveCostCapChange,
  rejectCostCapChange,
  requestCostCapChange,
} from "#backend/api/admin/cost_caps_write.js";
import type { CostCapChangeRequestV1 } from "#contracts/admin.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const REQ = "ae000000-0000-0000-0000-000000000010";
const APP = "ae000000-0000-0000-0000-000000000011";
const OV_REQ = "ae000000-0000-0000-0000-00000000000a";
const OV_APP = "ae000000-0000-0000-0000-00000000000b";
const OV_REJ = "ae000000-0000-0000-0000-00000000000c";

let pool: Pool;
let db: Kysely<unknown>;

/** Ensure the global + per_org_default settings rows exist (the approve guard reads them). ON CONFLICT
 *  DO NOTHING so we never clobber the READ test's values; we never DELETE them. */
async function ensureSettings(): Promise<void> {
  await sql`INSERT INTO core.cost_cap_settings (scope, cap_cents, updated_at, updated_by_user_id)
            VALUES ('global', 1000000, ${NOW}, ${REQ}), ('per_org_default', 500000, ${NOW}, ${REQ})
            ON CONFLICT (scope) DO NOTHING`.execute(db);
}

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.cost_cap_pending_changes WHERE requested_by_user_id IN (${REQ}, ${APP})`.execute(db);
  await sql`DELETE FROM core.cost_cap_overrides WHERE installation_id IN (${OV_REQ}, ${OV_APP}, ${OV_REJ})`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id IN (${OV_REQ}, ${OV_APP}, ${OV_REJ})`.execute(db);
}

function overrideReq(targetId: string | null, newCap = 900000): CostCapChangeRequestV1 {
  return { schema_version: 1, target_kind: "per_org_override", target_id: targetId, new_cap_cents: newCap, expires_at: null };
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  for (const inst of [OV_REQ, OV_APP, OV_REJ]) {
    await sql`INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
              VALUES (${inst}, ${993000000 + Number.parseInt(inst.slice(-1), 16)}, ${"itest-cc-" + inst.slice(-1)}, 'Organization')`.execute(db);
  }
  await ensureSettings();
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

describeDb("cost-caps write orchestration (disposable :5434)", () => {
  it("request: stages a pending; a 2nd for the same scope → concurrent 409", async () => {
    const row = await requestCostCapChange({ db, body: overrideReq(OV_REQ), installationId: REQ, requesterUserId: REQ, now: NOW });
    expect(row.state).toBe("pending");
    expect(row.target_kind).toBe("per_org_override");
    expect(row.target_id).toBe(OV_REQ);
    expect(row.new_cap_cents).toBe(900000);

    await expect(
      requestCostCapChange({ db, body: overrideReq(OV_REQ), installationId: REQ, requesterUserId: REQ, now: NOW }),
    ).rejects.toBeInstanceOf(CostCapConcurrentPendingChangeError);
    try {
      await requestCostCapChange({ db, body: overrideReq(OV_REQ), installationId: REQ, requesterUserId: REQ, now: NOW });
    } catch (e) {
      expect((e as CostCapConcurrentPendingChangeError).existingPendingChangeId).toBe(row.pending_change_id);
    }
  });

  it("approve: self→403; by a 2nd user→applied + override written; re-approve→stale; missing→404", async () => {
    await ensureSettings();
    const pending = await requestCostCapChange({ db, body: overrideReq(OV_APP), installationId: APP, requesterUserId: REQ, now: NOW });
    await expect(
      approveCostCapChange({ db, pendingChangeId: pending.pending_change_id, installationId: APP, approverUserId: REQ, now: NOW }),
    ).rejects.toBeInstanceOf(CostCapSelfApprovalError);

    const applied = await approveCostCapChange({ db, pendingChangeId: pending.pending_change_id, installationId: APP, approverUserId: APP, now: NOW });
    expect(applied.state).toBe("applied");
    const override = await sql<{ cap_cents: string | number }>`SELECT cap_cents FROM core.cost_cap_overrides WHERE installation_id = ${OV_APP}`.execute(db);
    expect(Number(override.rows[0]!.cap_cents)).toBe(900000);

    await expect(
      approveCostCapChange({ db, pendingChangeId: pending.pending_change_id, installationId: APP, approverUserId: APP, now: NOW }),
    ).rejects.toBeInstanceOf(CostCapPendingChangeStaleError);
    await expect(
      approveCostCapChange({ db, pendingChangeId: "ae000000-0000-0000-0000-0000000000ff", installationId: APP, approverUserId: APP, now: NOW }),
    ).rejects.toBeInstanceOf(CostCapPendingChangeNotFoundError);
  });

  it("reject: self→403 (cost-cap reject IS two-person); by a 2nd user→rejected", async () => {
    const pending = await requestCostCapChange({ db, body: overrideReq(OV_REJ), installationId: REQ, requesterUserId: REQ, now: NOW });
    await expect(
      rejectCostCapChange({ db, pendingChangeId: pending.pending_change_id, installationId: REQ, approverUserId: REQ, now: NOW }),
    ).rejects.toBeInstanceOf(CostCapSelfApprovalError);
    const rejected = await rejectCostCapChange({ db, pendingChangeId: pending.pending_change_id, installationId: REQ, approverUserId: APP, now: NOW });
    expect(rejected.state).toBe("rejected");
    const grants = await sql`SELECT 1 FROM core.cost_cap_overrides WHERE installation_id = ${OV_REJ}`.execute(db);
    expect(grants.rows).toHaveLength(0); // reject never writes a cap
  });

  it("request validation: target_kind/target_id consistency + future expires_at", async () => {
    const base = { db, installationId: REQ, requesterUserId: REQ, now: NOW };
    await expect(
      requestCostCapChange({ ...base, body: overrideReq(null) }), // per_org_override needs target_id
    ).rejects.toBeInstanceOf(CostCapInvalidRequestError);
    await expect(
      requestCostCapChange({ ...base, body: { schema_version: 1, target_kind: "global", target_id: OV_REQ, new_cap_cents: 100, expires_at: null } }),
    ).rejects.toBeInstanceOf(CostCapInvalidRequestError); // global accepts no target_id
    await expect(
      requestCostCapChange({ ...base, body: { schema_version: 1, target_kind: "global", target_id: null, new_cap_cents: 100, expires_at: "2026-06-01T00:00:00Z" } }),
    ).rejects.toBeInstanceOf(CostCapInvalidRequestError); // expires_at in the past
  });
});
