/**
 * Integration test for the notification-rules WRITE repo (create/update/delete) against the DISPOSABLE
 * Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set.
 * Plus a pure-function test for recipientSummary (always runs).
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getNotificationRule } from "#backend/api/admin/admin_read_repo.js";
import {
  NotificationRuleNotFoundError,
  createRule,
  deleteRule,
  recipientSummary,
  updateRule,
} from "#backend/api/admin/notification_rules_write.js";
import { NotificationRuleV1, type RecipientV1 } from "#contracts/admin.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const T0 = new Date("2026-06-07T12:00:00.000Z");
const T1 = new Date("2026-06-08T12:00:00.000Z");
const SLACK: RecipientV1 = { schema_version: 1, type: "slack", channel: "#alerts" };

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.notification_rules WHERE name LIKE 'itest-nr-%'`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

describe("recipientSummary (pure; drops sensitive fields)", () => {
  it("summarises each discriminated variant", () => {
    expect(recipientSummary({ schema_version: 1, type: "slack", channel: "#x" })).toEqual({ type: "slack", channel: "#x" });
    expect(recipientSummary({ schema_version: 1, type: "email", address: "a@b.com" })).toEqual({ type: "email", address: "a@b.com" });
    expect(
      recipientSummary({ schema_version: 1, type: "webhook", url: "https://h/x", secret_vault_path: "kv/p" }),
    ).toEqual({ type: "webhook", secret_vault_path: "kv/p" }); // url dropped
    expect(
      recipientSummary({ schema_version: 1, type: "jira", project_key: "ABC", issue_type: "Bug" }),
    ).toEqual({ type: "jira", project_key: "ABC", issue_type: "Bug" });
  });
});

describeDb("notification-rules write repo (disposable :5434)", () => {
  it("createRule: persists state='active' + JSONB filters/recipients; round-trips via NotificationRuleV1", async () => {
    const created = await createRule(db, {
      name: "itest-nr-create",
      triggerEvent: "pr.opened",
      filters: { repo: "org/x" },
      recipients: [SLACK],
      scheduleCron: "0 9 * * *",
      now: T0,
    });
    const parsed = NotificationRuleV1.parse(created);
    expect(parsed.state).toBe("active");
    expect(parsed.name).toBe("itest-nr-create");
    expect(parsed.trigger_event).toBe("pr.opened");
    expect(parsed.filters).toEqual({ repo: "org/x" });
    expect(parsed.recipients[0]).toEqual(SLACK);
    expect(parsed.schedule_cron).toBe("0 9 * * *");
  });

  it("updateRule: only present keys change; missing rule → NotificationRuleNotFoundError", async () => {
    const created = await createRule(db, {
      name: "itest-nr-update",
      triggerEvent: "pr.opened",
      filters: { a: 1 },
      recipients: [SLACK],
      scheduleCron: null,
      now: T0,
    });
    const ruleId = NotificationRuleV1.parse(created).rule_id;
    const updated = NotificationRuleV1.parse(await updateRule(db, ruleId, { name: "itest-nr-renamed", state: "paused" }, T1));
    expect(updated.name).toBe("itest-nr-renamed");
    expect(updated.state).toBe("paused");
    expect(updated.trigger_event).toBe("pr.opened"); // untouched
    expect(updated.filters).toEqual({ a: 1 }); // untouched

    const reFiltered = NotificationRuleV1.parse(await updateRule(db, ruleId, { filters: { b: 2 } }, T1));
    expect(reFiltered.filters).toEqual({ b: 2 });
    expect(reFiltered.name).toBe("itest-nr-renamed"); // still the renamed value

    await expect(
      updateRule(db, "bd000000-0000-0000-0000-0000000000ff", { name: "itest-nr-x" }, T1),
    ).rejects.toBeInstanceOf(NotificationRuleNotFoundError);
  });

  it("deleteRule: true then false (idempotent); row is gone", async () => {
    const created = await createRule(db, {
      name: "itest-nr-delete",
      triggerEvent: "pr.opened",
      filters: {},
      recipients: [],
      scheduleCron: null,
      now: T0,
    });
    const ruleId = NotificationRuleV1.parse(created).rule_id;
    expect(await deleteRule(db, ruleId)).toBe(true);
    expect(await getNotificationRule(db, ruleId)).toBeNull();
    expect(await deleteRule(db, ruleId)).toBe(false);
  });
});
