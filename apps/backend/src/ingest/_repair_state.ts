// F-5b (bootstrap-state-coverage plan v5) — `cache.repository_repair_state` helpers.
//
// FAITHFUL 1:1 port of the frozen Python `vendor/codemaster-py/codemaster/ingest/_repair_state.py`.
// Four helpers — one PK lookup + three mutations for the table's lifecycle:
//
//   * getStateForEnqueueDecision — producer's pre-enqueue gate; returns a 3-state RepairStateDecision
//     (allow / cooldown / blocked).
//   * markAttempted            — UPSERT at repair-enqueue time; preserves any existing
//     blocked_reason/blocked_at (admin's clear OR activity's prior block stays intact).
//   * clearOnSuccess           — DELETEs the row on successful repair completion (v5: no outcome tracking).
//   * markBlocked              — UPSERT setting blocked_reason + blocked_at on terminal-failure
//     classification (404 / 403 / app-unauthorized).
//
// The table itself is created by the baseline migration (PK github_installation_id; CHECK on the
// blocked_reason vocabulary + a biconditional CHECK pairing blocked_reason ↔ blocked_at).
//
// All four helpers take a Kysely executor (a Kysely or an open Transaction) so the SQL joins the caller's
// transaction — the same `sql\`...\`.execute(db)` idiom as `_pr_persistence.ts` / `outbox_repo.ts`.

import { type Kysely, sql } from "kysely";

/** A Kysely instance or an open Transaction — the executor the raw `sql` runs on. */
type Executor = Kysely<unknown>;

// Cooldown TTL (seconds): how long after a repair attempt until the producer can re-enqueue. Default 5
// minutes; bounded 60-3600s for safety against operator misconfiguration. 1:1 with the Python
// _DEFAULT_COOLDOWN_SECONDS / _MIN_COOLDOWN_SECONDS / _MAX_COOLDOWN_SECONDS.
const DEFAULT_COOLDOWN_SECONDS = 300;
const MIN_COOLDOWN_SECONDS = 60;
const MAX_COOLDOWN_SECONDS = 3600;

/**
 * Read `CODEMASTER_REPAIR_COOLDOWN_SECONDS` from env; bound to [60, 3600]. Default 300s = 5 minutes.
 * 1:1 with the Python `_get_cooldown_seconds()` (a non-integer / unset value falls back to the default,
 * never throws).
 */
function getCooldownSeconds(): number {
  const raw = process.env["CODEMASTER_REPAIR_COOLDOWN_SECONDS"];
  if (raw === undefined) {
    return DEFAULT_COOLDOWN_SECONDS;
  }
  // Python `int(raw)` rejects non-integer strings (incl. floats like "1.5"); mirror with a strict parse.
  const value = /^[+-]?\d+$/.test(raw.trim()) ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isNaN(value)) {
    return DEFAULT_COOLDOWN_SECONDS;
  }
  return Math.max(MIN_COOLDOWN_SECONDS, Math.min(MAX_COOLDOWN_SECONDS, value));
}

/**
 * 3-state enqueue-eligibility decision from a single PK lookup (1:1 with the Python `RepairStateDecision`
 * frozen dataclass). Producer-side branching:
 *
 *   * `allowEnqueue=true`  → enqueue repair workflow
 *   * `cooldownActive=true` → skip + emit cooldown_skips_total metric
 *   * `isBlocked=true`     → skip + emit blocked_skips_total{blocked_reason}
 *
 * `cooldownActive` and `isBlocked` are mutually exclusive in practice (blocked supersedes cooldown), but
 * the producer should branch on `isBlocked` first since blocked is the more-severe state.
 */
export type RepairStateDecision = {
  allowEnqueue: boolean;
  cooldownActive: boolean;
  isBlocked: boolean;
  blockedReason: string | null;
};

/**
 * Single PK lookup. Returns the 3-state enqueue-eligibility decision the producer needs. O(1)
 * (`github_installation_id` is the primary key on `cache.repository_repair_state`).
 *
 * Verbatim SQL from the Python `get_state_for_enqueue_decision`: the cooldown window is computed in SQL
 * via `make_interval(secs => :secs)` from the server clock's `now()` (no client-side clock read — the
 * window comparison must use the DB clock so it is consistent with the `now()` writes in markAttempted /
 * markBlocked). A null row (installation never seen) → allow.
 */
export async function getStateForEnqueueDecision(
  db: Executor,
  args: { githubInstallationId: number },
): Promise<RepairStateDecision> {
  const cooldownSeconds = getCooldownSeconds();
  // tenant:exempt reason=cache-table-keyed-by-github-installation-id-PK follow_up=PERMANENT-EXEMPTION-platform-cache-tables
  const result = await sql<{
    cooldown_active: boolean | null;
    is_blocked: boolean | null;
    blocked_reason: string | null;
  }>`
    SELECT
      (last_attempt_at > now() - make_interval(secs => ${cooldownSeconds})) AS cooldown_active,
      (blocked_at IS NOT NULL) AS is_blocked,
      blocked_reason
    FROM cache.repository_repair_state
    WHERE github_installation_id = ${args.githubInstallationId}
  `.execute(db);

  const row = result.rows[0];
  if (row === undefined) {
    return {
      allowEnqueue: true,
      cooldownActive: false,
      isBlocked: false,
      blockedReason: null,
    };
  }
  const cooldownActive = Boolean(row.cooldown_active);
  const isBlocked = Boolean(row.is_blocked);
  return {
    allowEnqueue: !(cooldownActive || isBlocked),
    cooldownActive,
    isBlocked,
    blockedReason: row.blocked_reason,
  };
}

/**
 * UPSERT a repair_state row at repair-enqueue time. Refreshes `last_attempt_at`; does NOT touch
 * `blocked_reason`/`blocked_at` so admin's prior clear (or the activity's prior block) is preserved.
 *
 * v5 simplification: no `last_outcome` column. The `last_attempt_at` timestamp alone gates the cooldown
 * window. Verbatim SQL from the Python `mark_attempted` (`now()` is the server clock).
 */
export async function markAttempted(
  db: Executor,
  args: { githubInstallationId: number },
): Promise<void> {
  await sql`
    INSERT INTO cache.repository_repair_state
      (github_installation_id, last_attempt_at)
    VALUES (${args.githubInstallationId}, now())
    ON CONFLICT (github_installation_id) DO UPDATE
      SET last_attempt_at = EXCLUDED.last_attempt_at
  `.execute(db);
}

/**
 * Called by the hydrate activity on successful completion. DELETEs the row entirely — cooldown is lifted
 * immediately; next drift detection re-enqueues cleanly. v5 simplification (vs v4): no outcome column to
 * set; DELETE is the canonical signal for "this installation is healthy". Verbatim SQL from the Python
 * `clear_on_success`.
 */
export async function clearOnSuccess(
  db: Executor,
  args: { githubInstallationId: number },
): Promise<void> {
  await sql`
    DELETE FROM cache.repository_repair_state WHERE github_installation_id = ${args.githubInstallationId}
  `.execute(db);
}

/**
 * Called by the hydrate activity when classifying terminal failure (404 / 403 / GitHubAppUnauthorized).
 * UPSERTs `blocked_reason` + `blocked_at`; the producer's next enqueue check sees `isBlocked=true` and
 * permanently suppresses until admin clears the columns via the documented runbook SQL.
 *
 * `blockedReason` MUST be one of the bounded vocabulary values in the SQL CHECK constraint on
 * `cache.repository_repair_state` ({@link REPAIR_BLOCKED_REASONS}); a value outside it is rejected by the
 * DB CHECK at write time.
 *
 * NOTE (two-transaction split — DB write here only): the Python caller
 * (`hydrate_installation_repositories._persist_terminal_failure`) runs `mark_blocked` in ONE transaction
 * and the audit-event emit in a SECOND, independent best-effort transaction, so an audit-emit failure
 * (Vault/KMS transient) cannot roll back the block (which would re-poison the installation into an
 * infinite retry loop). This helper ports ONLY the `mark_blocked` DB write — the audit-emit half is
 * DEFERRED in the TS port (the encrypted audit.audit_events emit is not yet wired on this seam).
 *
 * Verbatim SQL from the Python `mark_blocked` (`now()` is the server clock; `blocked_at = now()` satisfies
 * the biconditional CHECK that pairs blocked_reason ↔ blocked_at).
 */
export async function markBlocked(
  db: Executor,
  args: { githubInstallationId: number; blockedReason: RepairBlockedReason },
): Promise<void> {
  // FOLLOW-UP (deferred, parity with the TS port): the second best-effort transaction that emits the
  // `repository.repair_blocked` encrypted audit event is NOT ported here — it needs the pg-client
  // AuditQueryClient seam that the rest of this Kysely-native path does not yet thread. The DB block
  // write below is the load-bearing half and stands alone in its own transaction.
  await sql`
    INSERT INTO cache.repository_repair_state
      (github_installation_id, last_attempt_at, blocked_reason, blocked_at)
    VALUES (${args.githubInstallationId}, now(), ${args.blockedReason}, now())
    ON CONFLICT (github_installation_id) DO UPDATE
      SET blocked_reason = EXCLUDED.blocked_reason,
          blocked_at = EXCLUDED.blocked_at,
          last_attempt_at = EXCLUDED.last_attempt_at
  `.execute(db);
}

/**
 * The bounded `blocked_reason` vocabulary — 1:1 with the SQL CHECK constraint `blocked_reason_vocabulary`
 * on `cache.repository_repair_state`. A write outside this set is rejected by the DB CHECK.
 */
export const REPAIR_BLOCKED_REASONS = [
  "installation_not_found",
  "installation_suspended",
  "app_unauthorized",
  "app_uninstalled",
] as const;

/** One of the bounded {@link REPAIR_BLOCKED_REASONS} values. */
export type RepairBlockedReason = (typeof REPAIR_BLOCKED_REASONS)[number];
