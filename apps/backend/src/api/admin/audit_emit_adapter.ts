// AuditEmitPort Postgres adapter — port of codemaster/api/admin/audit_emit_adapter.py (W4.7 / EH7).
//
// The CONCRETE MemberAuditEmitter the production server wires into registerAdminRoutes: bridges the
// router's audit-seam shape to the canonical emitAuditEvent helper (AAD-bound local AES-256-GCM for
// before/after) over the core pool — audit.audit_events shares the core DSN (the Python bootstrap's
// G7 note: same-TX audit runs on the repo's session, so audit must be reachable on that connection).
//
// Locked invariants (1:1 with the Python adapter):
//   * bindAuditContext runs BEFORE the helper (its tenancy gate raises AuditContextMissing otherwise).
//   * Helper exceptions are NOT swallowed — fail-closed; the router's EH6 scoped handler maps them to
//     a generic 500 (the write route fails loudly rather than mutating without a trail).
//
// Divergence: the seam allows installationId=null for platform-scope actions (integrations live on a
// platform-shared table). The Python schema made audit_events.installation_id nullable (migration
// 0062); the TS baseline keeps it NOT NULL, so null maps to the SEEDED platform sentinel installation
// (PLATFORM_SCOPE_AUDIT_INSTALLATION_ID, migration 0002) — the same identity members_write and
// platform_credentials_write already stamp on platform-scope audit rows.

import type { Kysely } from "kysely";

import type { Clock } from "#platform/clock.js";

import { bindAuditContext, emitAuditEvent } from "#backend/audit/emit.js";
import type { MemberAuditEmitter } from "#backend/api/admin/members_write.js";
import { kyselyAuditClient } from "#backend/api/auth/audit.js";
import { PLATFORM_SCOPE_AUDIT_INSTALLATION_ID } from "#backend/infra/sentinels.js";

/** A Clock pinned to the event's own `now` — emitAuditEvent only calls clock.now() (created_at).
 *  monotonic/sleep are implemented for interface conformance, never invoked (Python _FixedClock). */
function fixedClock(now: Date): Clock {
  return {
    now: () => now,
    monotonic: () => 0,
    sleep: async () => {},
  };
}

/** Build the production MemberAuditEmitter over the given (core) pool. */
export function makePgAuditEmitter(deps: { db: Kysely<unknown> }): MemberAuditEmitter {
  return async (e) => {
    const client = kyselyAuditClient(deps.db);
    bindAuditContext(client, {
      installationId: e.installationId ?? PLATFORM_SCOPE_AUDIT_INSTALLATION_ID,
    });
    await emitAuditEvent({
      client,
      actorKind: "user",
      actorId: e.actorUserId,
      action: e.action,
      targetKind: e.targetKind,
      targetId: e.targetId,
      before: e.before,
      after: e.after,
      clock: fixedClock(e.now),
    });
  };
}
