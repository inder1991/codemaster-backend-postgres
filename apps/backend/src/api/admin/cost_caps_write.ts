// Cost-cap write/governance — 1:1 port of cost_caps.py (request/approve/reject helpers +
// compute_applied_at) + postgres_cost_cap_repo.py write methods. Two-person approval against
// core.cost_cap_pending_changes; approve mirrors the new cap to core.cost_cap_settings (by scope) or
// core.cost_cap_overrides (upsert by installation_id) in the same transaction.
//
// Unlike members, REJECT is also two-person (a single-user reject of one's own request silently cancels a
// coworker's review — refused 403). The lowering-grace window (compute_applied_at) delays cap LOWERS so
// in-flight Bedrock reservations settle; raises take effect immediately.

import { type Kysely, sql } from "kysely";

import { CostCapSettingsMissingError } from "#backend/api/admin/cost_caps_read.js";
import {
  SelfApprovalError,
  checkSelfApproval,
} from "#backend/api/admin/two_person_approval.js";

import type { CostCapChangeRequestV1, CostCapPendingChangeV1 } from "#contracts/admin.v1.js";

// Re-export so the write surface stays cohesive; it's the SAME class the READ path throws (the Python has
// one CostCapSettingsMissingError used by both build_cost_caps_page and approve).
export { CostCapSettingsMissingError };

export const LOWERING_GRACE_MINUTES = 60;

/** Optional audit-emit seam (same structural shape as the other admin write flows; dormant no-op today). */
export type CostCapAuditEmitter = (e: {
  actorUserId: string;
  installationId: string;
  action: string;
  targetKind: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  now: Date;
}) => Promise<void>;

// ─── Errors ─────────────────────────────────────────────────────────────────────────────────────────
export class CostCapPendingChangeNotFoundError extends Error {
  public constructor(id: string) {
    super(`cost-cap pending change ${id} not found`);
    this.name = "CostCapPendingChangeNotFoundError";
  }
}
export class CostCapPendingChangeStaleError extends Error {
  public constructor(id: string) {
    super(`cost-cap pending change ${id} is no longer in 'pending' state`);
    this.name = "CostCapPendingChangeStaleError";
  }
}
export class CostCapSelfApprovalError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CostCapSelfApprovalError";
  }
}
export class CostCapConcurrentPendingChangeError extends Error {
  public readonly existingPendingChangeId: string;
  public constructor(existingPendingChangeId: string) {
    super(`a pending cost-cap change for the same scope already exists: ${existingPendingChangeId}`);
    this.name = "CostCapConcurrentPendingChangeError";
    this.existingPendingChangeId = existingPendingChangeId;
  }
}
export class CostCapInvalidRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CostCapInvalidRequestError";
  }
}
// (CostCapSettingsMissingError is imported from cost_caps_read + re-exported above — one shared class.)

// ─── Lowering-grace (pure) ──────────────────────────────────────────────────────────────────────────

/** The next 00:00:00.000 UTC strictly later than `after` (midnight inputs → 24h later). */
export function nextMidnightUtc(after: Date): Date {
  return new Date(
    Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate() + 1, 0, 0, 0, 0),
  );
}

/** Floor at which a change takes effect: raises (new ≥ current) → approvedAt; lowers → max(approvedAt +
 *  grace, next_midnight_utc). 1:1 with compute_applied_at. */
export function computeAppliedAt(args: {
  newCapCents: number;
  currentCapCents: number;
  approvedAt: Date;
  graceMinutes?: number;
}): Date {
  if (args.newCapCents >= args.currentCapCents) {
    return args.approvedAt;
  }
  const grace = args.graceMinutes ?? LOWERING_GRACE_MINUTES;
  const graceFloor = new Date(args.approvedAt.getTime() + grace * 60 * 1000);
  const midnight = nextMidnightUtc(args.approvedAt);
  return graceFloor.getTime() >= midnight.getTime() ? graceFloor : midnight;
}

// ─── Repo (raw rows) ────────────────────────────────────────────────────────────────────────────────

type PendingSqlRow = {
  pending_change_id: string;
  target_kind: string;
  target_id: string | null;
  new_cap_cents: string | number;
  expires_at: Date | null;
  requested_at: Date;
  requested_by_user_id: string;
  approved_at: Date | null;
  approved_by_user_id: string | null;
  applied_at: Date | null;
  state: string;
};

const PENDING_COLS = sql`
  pending_change_id, target_kind, target_id, new_cap_cents, expires_at, requested_at,
  requested_by_user_id, approved_at, approved_by_user_id, applied_at, state
`;

function toPendingWire(r: PendingSqlRow): CostCapPendingChangeV1 {
  return {
    schema_version: 1,
    pending_change_id: r.pending_change_id,
    target_kind: r.target_kind as CostCapPendingChangeV1["target_kind"],
    target_id: r.target_id === null ? null : String(r.target_id),
    new_cap_cents: Number(r.new_cap_cents),
    expires_at: r.expires_at === null ? null : r.expires_at.toISOString(),
    requested_at: r.requested_at.toISOString(),
    requested_by_user_id: String(r.requested_by_user_id),
    approved_at: r.approved_at === null ? null : r.approved_at.toISOString(),
    approved_by_user_id: r.approved_by_user_id === null ? null : String(r.approved_by_user_id),
    applied_at: r.applied_at === null ? null : r.applied_at.toISOString(),
    state: r.state as CostCapPendingChangeV1["state"],
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "23505"
  );
}

export async function getPendingChange(
  db: Kysely<unknown>,
  pendingChangeId: string,
): Promise<PendingSqlRow | null> {
  const r = await sql<PendingSqlRow>`
    SELECT ${PENDING_COLS} FROM core.cost_cap_pending_changes WHERE pending_change_id = ${pendingChangeId}
  `.execute(db);
  return r.rows[0] ?? null;
}

async function insertPendingChange(
  db: Kysely<unknown>,
  args: {
    targetKind: string;
    targetId: string | null;
    newCapCents: number;
    expiresAt: Date | null;
    requestedAt: Date;
    requestedByUserId: string;
  },
): Promise<PendingSqlRow> {
  try {
    const r = await sql<PendingSqlRow>`
      INSERT INTO core.cost_cap_pending_changes
        (target_kind, target_id, new_cap_cents, expires_at, requested_at, requested_by_user_id, state)
      VALUES (${args.targetKind}, ${args.targetId}, ${args.newCapCents}, ${args.expiresAt},
              ${args.requestedAt}, ${args.requestedByUserId}, 'pending')
      RETURNING ${PENDING_COLS}
    `.execute(db);
    return r.rows[0]!;
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }
    // The partial unique index is the only INSERT-violable constraint → a same-scope concurrent write.
    const lookup = await sql<{ pending_change_id: string }>`
      SELECT pending_change_id FROM core.cost_cap_pending_changes
      WHERE target_kind = ${args.targetKind} AND target_id IS NOT DISTINCT FROM ${args.targetId}
        AND state = 'pending' LIMIT 1
    `.execute(db);
    const existing = lookup.rows[0];
    if (existing === undefined) {
      throw err; // raced to a state change between INSERT and SELECT — surface the real error
    }
    throw new CostCapConcurrentPendingChangeError(existing.pending_change_id);
  }
}

/** Current caps for the lowering-grace comparison. global/perOrgDefault are null if their settings row is
 *  absent (→ CostCapSettingsMissingError at the approve helper). */
export async function getCurrentCaps(
  db: Kysely<unknown>,
): Promise<{ global: number | null; perOrgDefault: number | null; overrides: Map<string, number> }> {
  const s = await sql<{ scope: string; cap_cents: string | number }>`
    SELECT scope, cap_cents FROM core.cost_cap_settings WHERE scope IN ('global', 'per_org_default')
  `.execute(db);
  const o = await sql<{ installation_id: string; cap_cents: string | number }>`
    SELECT installation_id, cap_cents FROM core.cost_cap_overrides
  `.execute(db);
  const globalRow = s.rows.find((r) => r.scope === "global");
  const perOrgRow = s.rows.find((r) => r.scope === "per_org_default");
  return {
    global: globalRow === undefined ? null : Number(globalRow.cap_cents),
    perOrgDefault: perOrgRow === undefined ? null : Number(perOrgRow.cap_cents),
    overrides: new Map(o.rows.map((r) => [String(r.installation_id), Number(r.cap_cents)])),
  };
}

async function applyChange(
  db: Kysely<unknown>,
  args: { pendingChangeId: string; approvedByUserId: string; approvedAt: Date; appliedAt: Date },
): Promise<PendingSqlRow> {
  return db.transaction().execute(async (tx) => {
    const cas = await sql<PendingSqlRow>`
      UPDATE core.cost_cap_pending_changes
      SET state = 'applied', approved_at = ${args.approvedAt}, approved_by_user_id = ${args.approvedByUserId},
          applied_at = ${args.appliedAt}
      WHERE pending_change_id = ${args.pendingChangeId} AND state = 'pending'
      RETURNING ${PENDING_COLS}
    `.execute(tx);
    const row = cas.rows[0];
    if (row === undefined) {
      throw new CostCapPendingChangeStaleError(args.pendingChangeId);
    }
    // Mirror the new cap to settings / overrides in the same transaction.
    if (row.target_kind === "global" || row.target_kind === "per_org_default") {
      await sql`
        UPDATE core.cost_cap_settings
        SET cap_cents = ${row.new_cap_cents}, updated_at = ${args.approvedAt}, updated_by_user_id = ${args.approvedByUserId}
        WHERE scope = ${row.target_kind}
      `.execute(tx);
    } else {
      await sql`
        INSERT INTO core.cost_cap_overrides (installation_id, cap_cents, expires_at, updated_at, updated_by_user_id)
        VALUES (${row.target_id}, ${row.new_cap_cents}, ${row.expires_at}, ${args.approvedAt}, ${args.approvedByUserId})
        ON CONFLICT (installation_id) DO UPDATE SET
          cap_cents = EXCLUDED.cap_cents, expires_at = EXCLUDED.expires_at,
          updated_at = EXCLUDED.updated_at, updated_by_user_id = EXCLUDED.updated_by_user_id
      `.execute(tx);
    }
    return row;
  });
}

async function rejectChange(
  db: Kysely<unknown>,
  args: { pendingChangeId: string; approvedByUserId: string; approvedAt: Date },
): Promise<PendingSqlRow> {
  const r = await sql<PendingSqlRow>`
    UPDATE core.cost_cap_pending_changes
    SET state = 'rejected', approved_at = ${args.approvedAt}, approved_by_user_id = ${args.approvedByUserId}
    WHERE pending_change_id = ${args.pendingChangeId} AND state = 'pending'
    RETURNING ${PENDING_COLS}
  `.execute(db);
  const row = r.rows[0];
  if (row === undefined) {
    throw new CostCapPendingChangeStaleError(args.pendingChangeId);
  }
  return row;
}

// ─── Orchestration (request / approve / reject) ──────────────────────────────────────────────────────

const AUDIT_REQUEST = "cost_cap.change.requested";
const AUDIT_APPLY = "cost_cap.change.applied";
const AUDIT_REJECT = "cost_cap.change.rejected";
const AUDIT_TARGET_KIND = "cost_cap_pending_change";

export async function requestCostCapChange(args: {
  db: Kysely<unknown>;
  body: CostCapChangeRequestV1;
  installationId: string;
  requesterUserId: string;
  now: Date;
  audit?: CostCapAuditEmitter | undefined;
}): Promise<CostCapPendingChangeV1> {
  const b = args.body;
  if (b.target_kind === "per_org_override" && b.target_id === null) {
    throw new CostCapInvalidRequestError("target_kind='per_org_override' requires target_id");
  }
  if (b.target_kind !== "per_org_override" && b.target_id !== null) {
    throw new CostCapInvalidRequestError(`target_kind='${b.target_kind}' does not accept a target_id`);
  }
  const expiresAt = b.expires_at === null ? null : new Date(b.expires_at);
  if (expiresAt !== null && expiresAt.getTime() <= args.now.getTime()) {
    throw new CostCapInvalidRequestError("expires_at must be in the future");
  }
  const row = await insertPendingChange(args.db, {
    targetKind: b.target_kind,
    targetId: b.target_id,
    newCapCents: b.new_cap_cents,
    expiresAt,
    requestedAt: args.now,
    requestedByUserId: args.requesterUserId,
  });
  await args.audit?.({
    actorUserId: args.requesterUserId,
    installationId: args.installationId,
    action: AUDIT_REQUEST,
    targetKind: AUDIT_TARGET_KIND,
    targetId: row.pending_change_id,
    before: null,
    after: {
      target_kind: b.target_kind,
      target_id: b.target_id,
      new_cap_cents: b.new_cap_cents,
      expires_at: expiresAt === null ? null : expiresAt.toISOString(),
      state: "pending",
    },
    now: args.now,
  });
  return toPendingWire(row);
}

export async function approveCostCapChange(args: {
  db: Kysely<unknown>;
  pendingChangeId: string;
  installationId: string;
  approverUserId: string;
  now: Date;
  audit?: CostCapAuditEmitter | undefined;
}): Promise<CostCapPendingChangeV1> {
  const row = await getPendingChange(args.db, args.pendingChangeId);
  if (row === null) {
    throw new CostCapPendingChangeNotFoundError(args.pendingChangeId);
  }
  if (row.state !== "pending") {
    throw new CostCapPendingChangeStaleError(args.pendingChangeId);
  }
  try {
    checkSelfApproval({ requesterUserId: String(row.requested_by_user_id), approverUserId: args.approverUserId });
  } catch (e) {
    if (e instanceof SelfApprovalError) {
      throw new CostCapSelfApprovalError(
        "the approver must be a different user than the requester (two-person rule)",
      );
    }
    throw e;
  }
  const caps = await getCurrentCaps(args.db);
  if (caps.global === null || caps.perOrgDefault === null) {
    throw new CostCapSettingsMissingError();
  }
  let currentCap: number;
  if (row.target_kind === "global") {
    currentCap = caps.global;
  } else if (row.target_kind === "per_org_default") {
    currentCap = caps.perOrgDefault;
  } else {
    const override = row.target_id === null ? undefined : caps.overrides.get(String(row.target_id));
    currentCap = override ?? caps.perOrgDefault; // override may not exist yet → falls back to per-org default
  }
  const appliedAt = computeAppliedAt({
    newCapCents: Number(row.new_cap_cents),
    currentCapCents: currentCap,
    approvedAt: args.now,
  });
  const applied = await applyChange(args.db, {
    pendingChangeId: args.pendingChangeId,
    approvedByUserId: args.approverUserId,
    approvedAt: args.now,
    appliedAt,
  });
  await args.audit?.({
    actorUserId: args.approverUserId,
    installationId: args.installationId,
    action: AUDIT_APPLY,
    targetKind: AUDIT_TARGET_KIND,
    targetId: args.pendingChangeId,
    before: { current_cap_cents: currentCap, state: "pending" },
    after: {
      new_cap_cents: Number(row.new_cap_cents),
      applied_at: appliedAt.toISOString(),
      state: "applied",
      target_kind: row.target_kind,
      target_id: row.target_id,
    },
    now: args.now,
  });
  return toPendingWire(applied);
}

export async function rejectCostCapChange(args: {
  db: Kysely<unknown>;
  pendingChangeId: string;
  installationId: string;
  approverUserId: string;
  now: Date;
  audit?: CostCapAuditEmitter | undefined;
}): Promise<CostCapPendingChangeV1> {
  const row = await getPendingChange(args.db, args.pendingChangeId);
  if (row === null) {
    throw new CostCapPendingChangeNotFoundError(args.pendingChangeId);
  }
  if (row.state !== "pending") {
    throw new CostCapPendingChangeStaleError(args.pendingChangeId);
  }
  // Cost-cap reject IS two-person (unlike members): self-reject silently cancels a coworker's review.
  if (String(row.requested_by_user_id) === args.approverUserId) {
    throw new CostCapSelfApprovalError(
      "the rejector must be a different user than the requester (two-person rule)",
    );
  }
  const rejected = await rejectChange(args.db, {
    pendingChangeId: args.pendingChangeId,
    approvedByUserId: args.approverUserId,
    approvedAt: args.now,
  });
  await args.audit?.({
    actorUserId: args.approverUserId,
    installationId: args.installationId,
    action: AUDIT_REJECT,
    targetKind: AUDIT_TARGET_KIND,
    targetId: args.pendingChangeId,
    before: { state: "pending" },
    after: { state: "rejected" },
    now: args.now,
  });
  return toPendingWire(rejected);
}
