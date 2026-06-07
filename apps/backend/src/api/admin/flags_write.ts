// Flags write — 1:1 port of flags.py put_flag + postgres_flags_repo.py (stage_first_approval /
// commit_second_approval). Two-person kill-switch flip with optimistic concurrency + typed-confirm gate.
//
// State machine (core.flags pending_* columns):
//   * First PUT (owner A): CAS-stage the change — set pending_second_approver=true, pending_value_json,
//     pending_first_approver_user_id, pending_set_at. The LIVE value_json is deliberately UNTOUCHED (the
//     kill switch is not flipped until a second approval lands). CAS on last_changed_at = If-Match; a miss
//     means a concurrent edit invalidated the client's token → FlagStaleWriteError (carries current state).
//     No audit row — a first approval is a "request to change", not a "change".
//   * Second PUT (owner B ≠ A): commit — move pending_value_json → value_json, bump last_changed_*, clear
//     pending_*. Self-second-approval (B == A) → SelfSecondApproverError. A differing second value →
//     FlagStaleWriteError. Audit fires here (flag.put).
//
// Tenant-wide (scope='global') flags additionally require a typed-confirmation phrase ("flip <name>") on
// BOTH approvals (defence in depth). The repository-scope branch present in the Python repo is consistently
// omitted across the TS read+write paths (no repository-scoped flags exist in the seeded set; see listFlags).

import { type Kysely, sql } from "kysely";

import {
  FLAG_SELECT_COLUMNS,
  type FlagDbRow,
  mapFlagRow,
} from "#backend/api/admin/admin_read_repo.js";

import type { FlagDetailV1 } from "#contracts/admin.v1.js";

// ───────────── Errors ─────────────

/** The flag_name does not resolve to a row visible to the session → route 404. */
export class FlagNotFoundError extends Error {}

/** Optimistic concurrency: the client's If-Match (or a differing second value) no longer matches server
 *  state → route 409 {code: stale_write, current_value_json, current_changed_at}. */
export class FlagStaleWriteError extends Error {
  constructor(
    readonly currentValueJson: string,
    readonly currentChangedAt: Date,
  ) {
    super("stale write");
  }
}

/** A tenant-wide flag was flipped without the matching X-Typed-Confirm-Phrase header → route 400. */
export class TypedConfirmRequiredError extends Error {}

/** The same user attempted both first and second approval → route 409 {code: self_second_approver}. */
export class SelfSecondApproverError extends Error {}

/** Optional audit-emit seam (structurally identical to the other admin write flows / AdminRoutesOptions.audit). */
export type FlagAuditEmitter = (e: {
  actorUserId: string;
  installationId: string;
  action: string;
  targetKind: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  now: Date;
}) => Promise<void>;

// ───────────── Pure helpers ─────────────

/** Locked typed-confirmation phrase, matched against X-Typed-Confirm-Phrase on every tenant-wide flag PUT.
 *  1:1 with flags.py `_typed_confirm_phrase_for`. */
export function typedConfirmPhraseFor(flagName: string): string {
  return `flip ${flagName}`;
}

/** core.flags visibility predicate shared by read + the two write UPDATEs (1:1 with the postgres repo, minus
 *  the unused repository branch). */
const flagVisible = (installationId: string) =>
  sql`(scope = 'global' OR (scope = 'installation' AND scope_id = ${installationId}))`;

async function selectFlag(
  db: Kysely<unknown>,
  flagName: string,
  installationId: string,
): Promise<FlagDbRow | null> {
  const r = await sql<FlagDbRow>`
    SELECT ${FLAG_SELECT_COLUMNS}
    FROM core.flags
    WHERE flag_name = ${flagName} AND ${flagVisible(installationId)}
    LIMIT 1
  `.execute(db);
  return r.rows[0] ?? null;
}

// ───────────── Orchestration ─────────────

/** Two-step flip with optimistic concurrency + typed confirm. Returns the post-write flag + the path taken
 *  ("staged_first" | "committed"). Throws FlagNotFoundError / FlagStaleWriteError / TypedConfirmRequiredError
 *  / SelfSecondApproverError for the route to map. 1:1 with flags.py put_flag. */
export async function putFlag(
  db: Kysely<unknown>,
  args: {
    flagName: string;
    installationId: string;
    newValueJson: string;
    ifMatchChangedAt: Date;
    actorUserId: string;
    typedConfirmPhrase: string | null;
    now: Date;
    audit?: FlagAuditEmitter | undefined;
  },
): Promise<{ flag: FlagDetailV1; path: "staged_first" | "committed" }> {
  const outcome = await db.transaction().execute(async (tx) => {
    const existing = await selectFlag(tx, args.flagName, args.installationId);
    if (existing === null) {
      throw new FlagNotFoundError();
    }

    // Typed-confirmation gate — tenant-wide flags require it on BOTH first and second approval.
    if (existing.scope === "global") {
      const expected = typedConfirmPhraseFor(args.flagName);
      if (args.typedConfirmPhrase === null || args.typedConfirmPhrase.trim() !== expected) {
        throw new TypedConfirmRequiredError();
      }
    }

    if (!existing.pending_second_approver) {
      // First-approval path: CAS-stage the change. Live value_json deliberately NOT touched.
      const staged = await sql<FlagDbRow>`
        UPDATE core.flags SET
          pending_second_approver = true,
          pending_first_approver_user_id = ${args.actorUserId},
          pending_value_json = ${args.newValueJson},
          pending_set_at = ${args.now}
        WHERE flag_name = ${args.flagName}
          AND last_changed_at = ${args.ifMatchChangedAt}
          AND ${flagVisible(args.installationId)}
        RETURNING ${FLAG_SELECT_COLUMNS}
      `.execute(tx);
      if (staged.rows.length === 0) {
        // CAS miss — read current live state so the error payload drives the collision-diff modal.
        const current = await selectFlag(tx, args.flagName, args.installationId);
        const live = current ?? existing;
        throw new FlagStaleWriteError(live.value_json, live.last_changed_at);
      }
      return { flag: mapFlagRow(staged.rows[0]!), path: "staged_first" as const, audit: null };
    }

    // Second-approval path. Self-second-approval refused; a differing second value is a stale write.
    if (existing.pending_first_approver_user_id === args.actorUserId) {
      throw new SelfSecondApproverError();
    }
    if (existing.pending_value_json !== args.newValueJson) {
      throw new FlagStaleWriteError(
        existing.pending_value_json ?? existing.value_json,
        existing.pending_set_at ?? existing.last_changed_at,
      );
    }
    const committed = await sql<FlagDbRow>`
      UPDATE core.flags SET
        value_json = pending_value_json,
        last_changed_at = ${args.now},
        last_changed_by_user_id = ${args.actorUserId},
        pending_second_approver = false,
        pending_first_approver_user_id = NULL,
        pending_value_json = NULL,
        pending_set_at = NULL
      WHERE flag_name = ${args.flagName} AND ${flagVisible(args.installationId)}
      RETURNING ${FLAG_SELECT_COLUMNS}
    `.execute(tx);
    const row = committed.rows[0]!;
    return {
      flag: mapFlagRow(row),
      path: "committed" as const,
      audit: {
        beforeValue: existing.value_json,
        afterValue: row.value_json,
        firstApprover: existing.pending_first_approver_user_id,
      },
    };
  });

  // Audit fires only on commit, AFTER the DB transaction (1:1 with put_flag's post-commit emit).
  if (outcome.audit !== null) {
    await args.audit?.({
      actorUserId: args.actorUserId,
      installationId: args.installationId,
      action: "flag.put",
      targetKind: "flag",
      targetId: args.flagName,
      before: { value_json: outcome.audit.beforeValue },
      after: {
        value_json: outcome.audit.afterValue,
        first_approver_user_id: outcome.audit.firstApprover,
        second_approver_user_id: args.actorUserId,
      },
      now: args.now,
    });
  }
  return { flag: outcome.flag, path: outcome.path };
}
