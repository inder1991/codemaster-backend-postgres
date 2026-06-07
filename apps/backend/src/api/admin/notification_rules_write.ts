// Notification-rules write repo — 1:1 port of postgres_notification_rules_repo.py write methods
// (create_rule, update_rule, delete_rule) + the _recipient_summary helper. Platform-scope (no
// installation_id column). Reuses the read repo's row mapper + column projection for the RETURNING shape.
//
// JSONB columns (filters, recipients) are bound via CAST(<json-text> AS jsonb) — the node-pg jsonb idiom
// (Python binds `:x::jsonb` with json.dumps). recipients is the validated RecipientV1[] (plain objects).

import { type Kysely, sql } from "kysely";

import {
  NOTIFICATION_RULE_COLUMNS,
  type NotificationRuleDbRow,
  mapNotificationRule,
} from "#backend/api/admin/admin_read_repo.js";

import type { RecipientV1 } from "#contracts/admin.v1.js";

/** No rule with the given rule_id (concurrent DELETE race / bad id). Route → 404. */
export class NotificationRuleNotFoundError extends Error {
  public constructor(ruleId: string) {
    super(`rule ${ruleId} not found`);
    this.name = "NotificationRuleNotFoundError";
  }
}

/** INSERT a new rule with state='active' (server-assigned). Returns the persisted (pre-parse) row. */
export async function createRule(
  db: Kysely<unknown>,
  args: {
    name: string;
    triggerEvent: string;
    filters: Record<string, unknown>;
    recipients: ReadonlyArray<RecipientV1>;
    scheduleCron: string | null;
    now: Date;
  },
): Promise<Record<string, unknown>> {
  const r = await sql<NotificationRuleDbRow>`
    INSERT INTO core.notification_rules
      (name, trigger_event, filters, recipients, schedule_cron, state, created_at, updated_at)
    VALUES (${args.name}, ${args.triggerEvent},
            CAST(${JSON.stringify(args.filters)} AS jsonb),
            CAST(${JSON.stringify(args.recipients)} AS jsonb),
            ${args.scheduleCron}, 'active', ${args.now}, ${args.now})
    RETURNING ${NOTIFICATION_RULE_COLUMNS}
  `.execute(db);
  // RETURNING on a successful INSERT always returns exactly one row.
  return mapNotificationRule(r.rows[0]!);
}

/** A partial-update patch — only the present keys are written (PATCH / exclude-unset semantics). */
export type NotificationRulePatch = {
  name?: string;
  trigger_event?: string;
  filters?: Record<string, unknown>;
  recipients?: ReadonlyArray<RecipientV1>;
  schedule_cron?: string | null;
  state?: "active" | "paused";
};

/** Apply `patch` (only present keys) to the rule. NotificationRuleNotFoundError if rule_id doesn't exist. */
export async function updateRule(
  db: Kysely<unknown>,
  ruleId: string,
  patch: NotificationRulePatch,
  now: Date,
): Promise<Record<string, unknown>> {
  const sets = [sql`updated_at = ${now}`];
  if ("name" in patch) sets.push(sql`name = ${patch.name}`);
  if ("trigger_event" in patch) sets.push(sql`trigger_event = ${patch.trigger_event}`);
  if ("filters" in patch) sets.push(sql`filters = CAST(${JSON.stringify(patch.filters)} AS jsonb)`);
  if ("recipients" in patch) {
    sets.push(sql`recipients = CAST(${JSON.stringify(patch.recipients)} AS jsonb)`);
  }
  if ("schedule_cron" in patch) sets.push(sql`schedule_cron = ${patch.schedule_cron ?? null}`);
  if ("state" in patch) sets.push(sql`state = ${patch.state}`);

  const r = await sql<NotificationRuleDbRow>`
    UPDATE core.notification_rules SET ${sql.join(sets, sql`, `)}
    WHERE rule_id = ${ruleId}
    RETURNING ${NOTIFICATION_RULE_COLUMNS}
  `.execute(db);
  const row = r.rows[0];
  if (row === undefined) {
    throw new NotificationRuleNotFoundError(ruleId);
  }
  return mapNotificationRule(row);
}

/** DELETE the rule by id. Returns true if a row was deleted, false if not found (route maps false→404). */
export async function deleteRule(db: Kysely<unknown>, ruleId: string): Promise<boolean> {
  const r = await sql<{ rule_id: string }>`
    DELETE FROM core.notification_rules WHERE rule_id = ${ruleId} RETURNING rule_id
  `.execute(db);
  return r.rows.length > 0;
}

/** Minimal type-discriminating recipient summary for dry-run + audit (drops sensitive fields like the
 *  webhook URL). 1:1 with _recipient_summary. */
export function recipientSummary(r: RecipientV1): Record<string, string> {
  switch (r.type) {
    case "slack":
      return { type: "slack", channel: r.channel };
    case "email":
      return { type: "email", address: r.address };
    case "webhook":
      return { type: "webhook", secret_vault_path: r.secret_vault_path };
    case "jira":
      return { type: "jira", project_key: r.project_key, issue_type: r.issue_type };
  }
}
