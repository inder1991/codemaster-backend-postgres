// Integration test for maybeEnqueueRepair (F-5b) against the DISPOSABLE Postgres (set CODEMASTER_PG_CORE_DSN
// at a throwaway DB with migrations applied — NEVER the cluster; SKIPs otherwise). FAITHFUL-port
// verification of the gated repair-dispatch: enqueue writes the installation_reconcile outbox row + marks
// attempted; cooldown suppresses a second enqueue within the window; blocked_at suppresses.
//
// The metric emits route through the no-op OTel meter (no MeterProvider registered) — safe; we assert the
// observable DB effects (outbox row + repair_state row), not the counters.

import { randomInt, randomUUID } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { maybeEnqueueRepair } from "#backend/ingest/_repair_dispatcher.js";
import { markBlocked } from "#backend/ingest/_repair_state.js";

import { getPool, disposePool, tenantKysely } from "#platform/db/database.js";

import { TemporalWorkflowStartPayloadV1 } from "#contracts/outbox_payloads.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;
if (INTEGRATION_DSN) {
  pool = getPool(INTEGRATION_DSN);
}

const RUN_TAG = `repair-disp-it-${randomUUID()}`;
const ghIids: Array<number> = [];
function nextGhIid(): number {
  const v = randomInt(2_100_000_000, 2_200_000_000);
  ghIids.push(v);
  return v;
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  await pool.query(`DELETE FROM core.outbox WHERE delivery_id LIKE $1`, [`${RUN_TAG}%`]);
  if (ghIids.length > 0) {
    await pool.query(
      `DELETE FROM cache.repository_repair_state WHERE github_installation_id = ANY($1::bigint[])`,
      [ghIids],
    );
  }
  await disposePool(INTEGRATION_DSN);
});

async function outboxByDelivery(
  delivery: string,
): Promise<{ sink: string; payload: Record<string, unknown>; schema_version: number; installation_id: string | null } | undefined> {
  const res = await pool.query<{
    sink: string;
    payload: Record<string, unknown>;
    schema_version: number;
    installation_id: string | null;
  }>(
    `SELECT sink, payload, schema_version, installation_id FROM core.outbox WHERE delivery_id = $1`,
    [delivery],
  );
  return res.rows[0];
}

async function repairStateExists(gid: number): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM cache.repository_repair_state WHERE github_installation_id = $1`,
    [gid],
  );
  return res.rows.length > 0;
}

describeDb("maybeEnqueueRepair (integration, disposable PG)", () => {
  it("allow path → writes installation_reconcile outbox row (NULL installation_id) + marks attempted + returns true", async () => {
    const db = tenantKysely(INTEGRATION_DSN!);
    const gid = nextGhIid();
    const delivery = `${RUN_TAG}-allow`;

    const enqueued = await maybeEnqueueRepair(db, {
      githubInstallationId: gid,
      triggerSource: "pr_webhook",
      deliveryId: delivery,
    });
    expect(enqueued).toBe(true);

    const row = await outboxByDelivery(delivery);
    expect(row).toBeDefined();
    expect(row!.sink).toBe("installation_reconcile");
    expect(row!.installation_id).toBeNull(); // the reconcile-sink schema exemption
    expect(Number(row!.schema_version)).toBe(1); // RECONCILE_PAYLOAD_SCHEMA_VERSION

    // The outbox payload is the TemporalWorkflowStartPayloadV1 envelope; it parses + carries the repair shape.
    const env = TemporalWorkflowStartPayloadV1.parse(row!.payload);
    expect(env.workflow_type).toBe("RepairInstallationRepositoriesWorkflow");
    expect(env.workflow_id).toBe(`repair-installation-repositories/${gid}`);
    expect(env.task_queue).toBe("ingest");
    expect(env.id_reuse_policy).toBe("ALLOW_DUPLICATE");
    expect(env.id_conflict_policy).toBe("USE_EXISTING");
    expect(env.args).toHaveLength(1);
    const inner = env.args[0] as Record<string, unknown>;
    expect(inner["github_installation_id"]).toBe(gid);
    expect(inner["trigger_source"]).toBe("pr_webhook");
    expect(inner["schema_version"]).toBe(1);

    // mark_attempted side effect.
    expect(await repairStateExists(gid)).toBe(true);
  });

  it("cooldown suppresses a SECOND enqueue within the window → returns false, no second outbox row", async () => {
    const db = tenantKysely(INTEGRATION_DSN!);
    const gid = nextGhIid();

    const first = await maybeEnqueueRepair(db, {
      githubInstallationId: gid,
      triggerSource: "installation_created",
      deliveryId: `${RUN_TAG}-cooldown-1`,
    });
    expect(first).toBe(true);
    expect(await outboxByDelivery(`${RUN_TAG}-cooldown-1`)).toBeDefined();

    // Immediate re-enqueue: last_attempt_at = now() → inside the 300s cooldown → suppressed.
    const second = await maybeEnqueueRepair(db, {
      githubInstallationId: gid,
      triggerSource: "installation_created",
      deliveryId: `${RUN_TAG}-cooldown-2`,
    });
    expect(second).toBe(false);
    expect(await outboxByDelivery(`${RUN_TAG}-cooldown-2`)).toBeUndefined(); // no second row written
  });

  it("blocked_at suppresses the enqueue → returns false, no outbox row, no attempt overwrite", async () => {
    const db = tenantKysely(INTEGRATION_DSN!);
    const gid = nextGhIid();
    await markBlocked(db, { githubInstallationId: gid, blockedReason: "app_unauthorized" });

    const result = await maybeEnqueueRepair(db, {
      githubInstallationId: gid,
      triggerSource: "pr_webhook",
      deliveryId: `${RUN_TAG}-blocked`,
    });
    expect(result).toBe(false);
    expect(await outboxByDelivery(`${RUN_TAG}-blocked`)).toBeUndefined();

    // Still blocked (the suppression path does not clear/overwrite the block).
    const res = await pool.query<{ blocked_reason: string | null }>(
      `SELECT blocked_reason FROM cache.repository_repair_state WHERE github_installation_id = $1`,
      [gid],
    );
    expect(res.rows[0]!.blocked_reason).toBe("app_unauthorized");
  });
});
