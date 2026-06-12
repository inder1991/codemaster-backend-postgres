// Login audit emission — port of codemaster/api/auth/audit.py (W4.7 / EH7 closed the deferred
// FOLLOW-UP-login-audit-emit-wiring).
//
// Emits `login.success` / `login.failure` rows to audit.audit_events via the canonical
// emitAuditEvent helper. Payload shape (LOCKED, 1:1 with the Python):
//   action      — "login.success" for outcome='ok', else "login.failure" (rate_limited included)
//   actor_kind  — "user"; actor_id — the user UUID when known, null otherwise
//   target_kind — "session"; target_id — null; before — null
//   after       — {auth_source, outcome, client_ip_hashed}  (IP sha256-hex truncated to 32 chars —
//                 raw IP is PII and never enters the audit table in plaintext)
//
// Fail-safe contract (LOCKED): with strict=false (default) ANY failure in the bind/encrypt/INSERT
// chain is logged and swallowed — authentication must work even when audit storage is degraded.
// strict=true re-raises after logging: used INSIDE recordLoginAttempt's open transaction (the R8
// same-TX callback) so a failed audit INSERT rolls the user-state UPDATE back with it.

import { createHash } from "node:crypto";

import { CompiledQuery, type Kysely, type Transaction } from "kysely";

import type { Clock } from "#platform/clock.js";

import { type AuditQueryClient, bindAuditContext, emitAuditEvent } from "#backend/audit/emit.js";
import type { LoginOutcome } from "#backend/api/auth/login.js";
import type { AuthSource } from "#backend/api/auth/session.js";

/** LoginOutcome plus the pre-dispatch rate-limit rejection (auth_source unknown there). */
export type LoginAuditOutcome = LoginOutcome | "rate_limited";

/** SHA-256 hex of the client IP, truncated to 32 chars (128 bits — enough for ops correlation,
 *  compact, not reversible to the raw IP). 1:1 with the Python _hash_ip. */
export function hashClientIp(clientIp: string): string {
  return createHash("sha256").update(clientIp, "utf-8").digest("hex").slice(0, 32);
}

/** Adapt a Kysely executor (root db OR an open transaction) to the minimal pg-client surface the
 *  canonical emitAuditEvent helper writes through. Each call returns a FRESH object, so the
 *  bindAuditContext WeakMap binding is per-emit and never leaks across tenants. */
export function kyselyAuditClient(executor: Kysely<unknown> | Transaction<unknown>): AuditQueryClient {
  return {
    async query(text: string, params?: ReadonlyArray<unknown>) {
      const result = await executor.executeQuery(CompiledQuery.raw(text, [...(params ?? [])]));
      return { rows: result.rows as ReadonlyArray<unknown> };
    },
  };
}

export type EmitLoginEventArgs = {
  /** The executor to write through — recordLoginAttempt's open transaction on the same-TX path, or
   *  the audit pool (auditDb) on the fallback/rate-limited paths. */
  executor: Kysely<unknown> | Transaction<unknown>;
  outcome: LoginAuditOutcome;
  authSource: AuthSource | null;
  /** Actor UUID when the identity is proven/known; null otherwise (unrecognized username, pre-dispatch
   *  rate-limit rejection). */
  userId: string | null;
  installationId: string;
  clientIp: string;
  clock: Clock;
  /** true → re-raise on failure (same-TX R8 contract); false/absent → log + swallow (fail-safe). */
  strict?: boolean;
};

/** Emit one login audit row. See the module header for the locked payload + fail-safe contract. */
export async function emitLoginEvent(args: EmitLoginEventArgs): Promise<void> {
  try {
    const client = kyselyAuditClient(args.executor);
    bindAuditContext(client, { installationId: args.installationId });
    await emitAuditEvent({
      client,
      actorKind: "user",
      actorId: args.userId,
      action: args.outcome === "ok" ? "login.success" : "login.failure",
      targetKind: "session",
      targetId: null,
      before: null,
      after: {
        auth_source: args.authSource,
        outcome: args.outcome,
        client_ip_hashed: hashClientIp(args.clientIp),
      },
      clock: args.clock,
    });
  } catch (exc) {
    console.error(
      JSON.stringify({
        event: "audit_login_emit_failed",
        outcome: args.outcome,
        auth_source: args.authSource,
        error_class: exc instanceof Error ? exc.constructor.name : typeof exc,
        strict: args.strict === true,
      }),
    );
    if (args.strict === true) {
      throw exc;
    }
  }
}
