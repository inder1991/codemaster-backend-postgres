/**
 * `reconcileInstallation` activity — registered Temporal activity name `reconcile_installation_activity`.
 *
 * FAITHFUL 1:1 port of the frozen Python `@activity.defn("reconcile_installation_activity")`
 * (vendor/codemaster-py/codemaster/activities/reconcile_installation.py). Idempotent upsert into
 * `core.installations` + companion `core.users` / `core.ad_users` rows from a GitHub `installation`
 * event. Replaying the same event yields the same end state (INSERT … ON CONFLICT (github_installation_id)
 * DO UPDATE handles re-installs — a previously deleted/suspended row's `suspended_at` flips back to NULL).
 *
 * ## Runtime context
 *
 * Activities run in the NORMAL Node runtime (NOT the workflow V8-isolate sandbox), so real I/O is fine.
 * The activity input is the bare JSON dict = the serialized `GitHubInstallationPayloadV1`; the workflow
 * does NOT validate — this activity re-validates via the Zod contract at the boundary (1:1 with the
 * Python `GitHubInstallationPayloadV1.model_validate`).
 *
 * ## DSN + transaction
 *
 * Reads `CODEMASTER_PG_CORE_DSN`, routes through the ADR-0062 process-shared single pool
 * ({@link tenantKysely}), and runs ALL mutations in ONE transaction (1:1 with the Python
 * `async with factory() as session: async with session.begin():`). The reconcile queries are raw
 * `sql`...`` keyed on the GitHub surrogate, so they bypass the TenancyPlugin AST walk by construction.
 *
 * ## Deferred work (see // FOLLOW-UP markers)
 *
 *  - audit.audit_events emit (`installation.{action}` via emit_audit_event / bind_audit_context). The TS
 *    `audit/emit.ts` is built against an AuditQueryClient pg-client seam, not the Kysely tx this activity
 *    uses — the audit emit is DEFERRED in this port (already deferred in the TS port broadly). The audit
 *    `before` / `after` dicts ARE assembled (by the upsert helpers) so the wiring is a drop-in later.
 *  - maybe_enqueue_repair kickoff — the Python enqueues RepairInstallationRepositoriesWorkflow via the
 *    shared dispatcher (cooldown/blocked gate → outbox row) at the end of the activity, UNCONDITIONALLY
 *    (not gated on action), with trigger_source="installation_created". That dispatcher
 *    (ingest/_repair_dispatcher.ts) + the outbox sink wiring is the INTEGRATOR step — see // FOLLOW-UP below.
 */

import { tenantKysely } from "#platform/db/database.js";
import { WallClock } from "#platform/clock.js";

import { GitHubInstallationPayloadV1 } from "#contracts/github_installation_payload.v1.js";
import { ReconcileInstallationResultV1 } from "#contracts/reconcile_results.v1.js";

import {
  ensureSenderUser,
  resolveAccountType,
  upsertInstallation,
} from "#backend/ingest/_reconcile_persistence.js";

/**
 * The registered `reconcile_installation_activity` Temporal activity.
 *
 * 1:1 with reconcile_installation.py:190-263.
 */
export async function reconcileInstallation(
  payloadDict: unknown,
): Promise<ReconcileInstallationResultV1> {
  const payload = GitHubInstallationPayloadV1.parse(payloadDict);

  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set; cannot run reconcile_installation_activity",
    );
  }

  // The Python contract types `installation.account` as Optional, but the activity reads it
  // unconditionally (the installation-event producer path always supplies it; the PR-backfill path
  // synthesizes it). Faithful 1:1: read `.account` and fail loud if a payload reaches us without one.
  const account = payload.installation.account;
  if (account === undefined || account === null) {
    throw new Error(
      "reconcile_installation_activity: payload.installation.account is required (the producer " +
        "always supplies it; a missing account is an upstream contract violation)",
    );
  }

  const clock = new WallClock();
  const db = tenantKysely<unknown>(dsn);

  // new_suspended: deleted/suspended → now; unsuspended/created → null (reconcile_installation.py:74-80).
  const newSuspendedAt =
    payload.action === "deleted" || payload.action === "suspended" ? clock.now() : null;

  const { installationId, userId, before } = await db.transaction().execute(async (tx) => {
    const inst = await upsertInstallation(tx, {
      githubInstallationId: payload.installation.id,
      accountLogin: account.login,
      accountType: resolveAccountType(account.type),
      newSuspendedAt,
      clock,
    });

    const uid = await ensureSenderUser(tx, {
      installationId: inst.id,
      senderLogin: payload.sender.login,
      senderType: payload.sender.type,
      clock,
    });

    // FOLLOW-UP (DEFERRED): emit the `installation.${payload.action}` audit.audit_events row via
    // bind_audit_context(tx, installationId) + emitAuditEvent({ actorKind: sender.type !== "Bot" ?
    // "user" : "bot", actorId: uid, action: `installation.${payload.action}`, targetKind:
    // "installation", targetId: inst.id, before: inst.before || null, after: inst.after, clock }).
    // Deferred alongside the rest of the TS audit-emit port (audit/emit.ts uses an AuditQueryClient
    // pg-client seam, not this Kysely tx). The before/after dicts are already assembled in inst.

    // FOLLOW-UP (INTEGRATOR): enqueue RepairInstallationRepositoriesWorkflow via the shared dispatcher
    // maybeEnqueueRepair({ tx, githubInstallationId: payload.installation.id, triggerSource:
    // "installation_created", deliveryId: null }) — UNCONDITIONAL (Python does not gate on action),
    // in THIS same transaction (the outbox row commits with the installation/user upsert). The
    // dispatcher (ingest/_repair_dispatcher.ts) + the installation_reconcile outbox-sink wiring is
    // built/wired by the integrator (the other agent owns _repair_state.ts / _repair_dispatcher.ts).

    return { installationId: inst.id, userId: uid, before: inst.before };
  });

  // Result action (reconcile_installation.py:256-262): a re-applied "created" event onto an existing
  // installations row maps to "updated"; every other action passes through. (This is why the RESULT
  // enum carries "updated" although the INPUT enum does not.)
  const priorExisted = Object.keys(before).length > 0;
  const action: ReconcileInstallationResultV1["action"] =
    payload.action === "created" ? (priorExisted ? "updated" : "created") : payload.action;

  return ReconcileInstallationResultV1.parse({
    action,
    installation_id: installationId,
    user_id: userId,
  });
}
