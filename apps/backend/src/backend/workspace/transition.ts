/**
 * `transitionLease` — atomic state-machine primitive for `core.workspace_leases`. 1:1 TypeScript/Kysely
 * port of the frozen Python spine primitive
 * `vendor/codemaster-py/codemaster/workspace/_transition.py` (Phase 6 / Task 7, AD-11).
 *
 * The single primitive every workspace caller uses to mutate `core.workspace_leases.state`. No version
 * column, no per-row attempt counter: the state machine excludes most race patterns (only one valid
 * transition from each state); `SELECT … FOR UPDATE` on the lease row + a `WHERE state` precondition
 * serializes the rest.
 *
 * ## Six-step protocol (1:1 with the Python)
 *
 *   1. Validate `fromState` / `toState` ∈ {@link LEASE_STATES} and `activity` non-empty — typed errors
 *      at the boundary, not Postgres CHECK violations.
 *   2. Assert an OPEN transaction. The TS analogue of the Python `session.in_transaction()`
 *      `RuntimeError`: reject a handle that is not an `instanceof Transaction` (a bare `Kysely` engine).
 *      Without a txn the `SELECT FOR UPDATE` releases its row lock immediately and the UPDATE + event
 *      emit chain degenerates to TOCTOU.
 *   3. `SELECT state, run_id, review_id, installation_id … WHERE workspace_id = :wid FOR UPDATE`.
 *   4. Branch:
 *        * row missing → {@link StateDrift} with `actualState = "<missing>"`.
 *        * (BF-9) `expectedInstallationId` mismatch → {@link CrossInstallationViolation} BEFORE any
 *          mutation; `undefined` (default) logs a structured WARN grace-period notice and proceeds.
 *        * `current === toState` → return {@link LeaseTransitionOutcome.ALREADY_APPLIED} (NO UPDATE,
 *          NO event — Temporal-retry idempotency).
 *        * `current !== fromState` → {@link StateDrift}.
 *        * else → ONE UPDATE: `state` + the toState timestamp column (+ `release_requested_by` when
 *          → RELEASE_REQUESTED, + clear `cleanup_failed_at` on a FAILED_CLEANUP → other retry).
 *   5. Emit ONE `WORKSPACE_<toState>` event via {@link emitWorkflowEvent} (payload `{workspace_id,
 *      from_state, to_state, activity, reason}`), in the SAME transaction.
 *   6. Return {@link LeaseTransitionOutcome.APPLIED}.
 *
 * The single UPDATE flips `state` AND stamps the required timestamp column AND (for RELEASE_REQUESTED)
 * the `release_requested_by` attribution together, so the migration-0076 biconditional CHECK
 * constraints never observe the row mid-transition. The caller owns the transaction boundary; this
 * function neither opens nor commits — the state flip, the timestamp stamp and the event emit share one
 * COMMIT and are atomic from any reader's perspective.
 */

import { type Kysely, type RawBuilder, sql, Transaction } from "kysely";

import { type Clock, WallClock } from "#platform/clock.js";

import { emitWorkflowEvent, EVENT_TYPES } from "../ingest/_workflow_events_repository.js";

import { CrossInstallationViolation, StateDrift } from "./errors.js";

// BF-9 Phase A — cross-installation safety identifiers (1:1 with the Python constants). They surface
// the offending primitive + key kind in CrossInstallationViolation payloads + structured WARN logs.
const BF9_PRIMITIVE_NAME = "transition_lease";
const BF9_KEY_KIND = "workspace_id";

/**
 * Outcome of a {@link transitionLease} call (1:1 with the Python `LeaseTransitionOutcome` enum, modeled
 * as a frozen `as const` object + derived union per the repo's no-TS-enum style rule — callers still
 * read `LeaseTransitionOutcome.APPLIED` and compare against the string value identically).
 *
 *   - `APPLIED` — the UPDATE advanced the row and the `WORKSPACE_*` audit event was emitted.
 *   - `ALREADY_APPLIED` — the current state already equalled `toState` (Temporal-retry safety; no
 *     UPDATE, no event).
 */
export const LeaseTransitionOutcome = {
  APPLIED: "APPLIED",
  ALREADY_APPLIED: "ALREADY_APPLIED",
} as const;

/** The outcome string union (`"APPLIED" | "ALREADY_APPLIED"`), the value type of {@link transitionLease}. */
export type LeaseTransitionOutcome =
  (typeof LeaseTransitionOutcome)[keyof typeof LeaseTransitionOutcome];

/**
 * Valid lease states (1:1 with the Python `LEASE_STATES` frozenset / the migration-0076
 * `core.workspace_lease_state` ENUM). Kept as a `Set` so validation rejects bad values before any SQL
 * round-trip — callers see a typed error, not a Postgres CHECK violation.
 */
export const LEASE_STATES: ReadonlySet<string> = new Set<string>([
  "ALLOCATED",
  "RELEASE_REQUESTED",
  "RELEASED",
  "ORPHANED",
  "FAILED_CLEANUP",
]);

/**
 * State → required timestamp column (1:1 with the Python `_STATE_TIMESTAMP_COLUMNS`). `ORPHANED` has no
 * required timestamp (its only invariant is the partial-index exclusion from the active set);
 * `ALLOCATED` (entry state) is stamped by the INSERT, not by a transition. The migration's biconditional
 * CHECKs require these timestamps present when the row is in the corresponding state, so the primitive
 * stamps them in lockstep with the state flip. Keys are validated `toState` values; never user input.
 */
export const STATE_TIMESTAMP_COLUMNS: ReadonlyMap<string, string> = new Map<string, string>([
  ["RELEASE_REQUESTED", "release_requested_at"],
  ["RELEASED", "released_at"],
  ["FAILED_CLEANUP", "cleanup_failed_at"],
]);

/**
 * Return the `WORKSPACE_<state>` audit-event type for a target state (1:1 with the Python
 * `_event_type_for`). All 5 lease states have a corresponding event_type (migration 0078). NOTE:
 * `FAILED_CLEANUP` lease state maps to the `WORKSPACE_CLEANUP_FAILED` event-type per the spec §5.3
 * naming convention.
 */
export function eventTypeFor(state: string): string {
  if (state === "FAILED_CLEANUP") {
    return "WORKSPACE_CLEANUP_FAILED";
  }
  return `WORKSPACE_${state}`;
}

/** The row the FOR-UPDATE SELECT returns: current state + the FK targets the event emit needs. */
type CurrentLeaseRow = {
  state: string;
  run_id: string;
  review_id: string;
  installation_id: string;
};

/** Arguments for {@link transitionLease}. 1:1 with the Python keyword-only signature. */
export type TransitionLeaseArgs = {
  /**
   * Open transaction handle. The caller owns the boundary; this neither opens nor commits. A bare
   * `Kysely` engine is rejected at runtime (the `session.in_transaction()` `RuntimeError` analogue).
   */
  tx: Transaction<unknown> | Kysely<unknown>;
  /** Primary key of the lease row to transition. */
  workspaceId: string;
  /** The state the caller expects the row to be in right now. Must be in {@link LEASE_STATES}. */
  fromState: string;
  /**
   * The target state. Must be in {@link LEASE_STATES}. When equal to the current observed state the
   * call is a no-op (idempotent — Temporal-retry safety).
   */
  toState: string;
  /**
   * Free-text owner of the transition (e.g. `"release_workspace_activity"`). Recorded in the event
   * payload AND on `release_requested_by` when transitioning to RELEASE_REQUESTED. Non-empty string.
   */
  activity: string;
  /** Optional free-text reason recorded in the event payload (e.g. `"workflow_complete"`). */
  reason?: string | null;
  /**
   * BF-9 Phase A cross-installation safety guard. When provided, the primitive validates the lease
   * row's actual `installation_id` equals this value and raises {@link CrossInstallationViolation} on
   * mismatch BEFORE any mutation. `undefined` (default) is the transitional Phase B grace period — a
   * structured WARN logs the gap; the clone activity passes none.
   */
  expectedInstallationId?: string | undefined;
  /**
   * Injected clock; defaults to {@link WallClock}. Governs both the state-timestamp stamp and the
   * emitted event's `received_at` so a {@link FakeClock} observes identical timestamps on both.
   */
  clock?: Clock | undefined;
};

/**
 * Atomic state transition on a `core.workspace_leases` row (1:1 with the Python `transition_lease`).
 * See the module docstring for the six-step protocol.
 *
 * @throws {Error}                      `fromState`/`toState` not in {@link LEASE_STATES}; `activity`
 *                                      empty; OR `tx` is not an open `Transaction` (the RuntimeError
 *                                      `session.in_transaction()` analogue).
 * @throws {StateDrift}                 the row is missing (`actualState = "<missing>"`) OR the current
 *                                      state is neither `fromState` nor `toState`.
 * @throws {CrossInstallationViolation} `expectedInstallationId` is provided and does NOT match the lease
 *                                      row's actual `installation_id` (no UPDATE runs; row unchanged).
 *
 * A DB CHECK-constraint violation (programming error — e.g. setting `state=RELEASED` while leaving
 * `released_at` NULL) surfaces as the underlying Postgres error, propagated to the caller for rollback.
 */
export async function transitionLease(args: TransitionLeaseArgs): Promise<LeaseTransitionOutcome> {
  const { tx, workspaceId, fromState, toState, activity } = args;
  const reason = args.reason ?? null;
  const expectedInstallationId = args.expectedInstallationId;

  // ── Step 1: validate at the boundary so callers see typed errors, not Postgres CHECK violations. ──
  if (!LEASE_STATES.has(fromState)) {
    throw new Error(
      `transitionLease: fromState='${fromState}' is not in LEASE_STATES. ` +
        `Valid values: ${JSON.stringify([...LEASE_STATES].sort())}`,
    );
  }
  if (!LEASE_STATES.has(toState)) {
    throw new Error(
      `transitionLease: toState='${toState}' is not in LEASE_STATES. ` +
        `Valid values: ${JSON.stringify([...LEASE_STATES].sort())}`,
    );
  }
  if (typeof activity !== "string" || activity.length === 0) {
    throw new Error(`transitionLease: activity must be a non-empty string, got ${JSON.stringify(activity)}`);
  }

  // ── Step 2: assert an OPEN transaction (the Python `session.in_transaction()` RuntimeError). The
  // SELECT FOR UPDATE + UPDATE + event-emit chain only composes safely inside one. A Kysely
  // `Transaction` is structurally in a txn; a bare `Kysely` engine is not — reject it loudly. ──
  if (!(tx instanceof Transaction)) {
    throw new Error(
      "transitionLease requires an already-open transaction. Pass the Kysely Transaction handle from " +
        "`db.transaction().execute(async (tx) => { ... })`. Without a txn, the SELECT FOR UPDATE releases " +
        "its row-level lock immediately and the UPDATE + event emit chain races concurrent writers.",
    );
  }

  const effectiveClock: Clock = args.clock ?? new WallClock();

  // ── Step 3: read current state under FOR UPDATE. Pull run_id + review_id + installation_id in the
  // same round trip so the event emit below needs no follow-up SELECT (emit needs run_id/review_id for
  // the FK targets, installation_id for the BF-9 check + the audit tenancy column). ──
  // tenant:exempt reason=PK-lookup-by-workspace_id-FOR-UPDATE follow_up=PERMANENT-EXEMPTION-workspace-lease-pk
  const currentResult = await sql<CurrentLeaseRow>`
    SELECT state, run_id, review_id, installation_id
      FROM core.workspace_leases
     WHERE workspace_id = ${workspaceId}
     FOR UPDATE
  `.execute(tx);

  const currentRow = currentResult.rows[0];
  if (currentRow === undefined) {
    // StateDrift carries actualState: string (not optional), so the row-missing case uses the literal
    // sentinel "<missing>" (1:1 with the Python). The caller treats it identically to a state mismatch.
    throw new StateDrift({ workspaceId, expectedFrom: fromState, actualState: "<missing>" });
  }

  const currentState = currentRow.state;
  const runId = currentRow.run_id;
  const reviewId = currentRow.review_id;
  const actualInstallationId = currentRow.installation_id;

  // ── BF-9 Phase A: cross-installation safety, BEFORE any mutation. ──
  //   * undefined — Phase B grace period: structured WARN + proceed. Phase C will require the arg.
  //   * matches — proceed.
  //   * mismatch — raise CrossInstallationViolation BEFORE any UPDATE / event emit so the outer
  //     transaction rolls back and the row is unchanged.
  if (expectedInstallationId === undefined) {
    // Structured WARN grace-period notice (1:1 with the Python `_LOG.warning`); no logger seam in the
    // domain layer yet — `console.warn` is the sanctioned stderr surface here.
    console.warn(
      `cross-installation: ${BF9_PRIMITIVE_NAME} called without expectedInstallationId; ` +
        `Phase B will require it. key_kind=${BF9_KEY_KIND} key_value=${workspaceId}`,
    );
  } else if (actualInstallationId !== expectedInstallationId) {
    throw new CrossInstallationViolation({
      primitive: BF9_PRIMITIVE_NAME,
      keyKind: BF9_KEY_KIND,
      keyValue: workspaceId,
      expectedInstallationId,
      actualInstallationId,
    });
  }

  // ── Step 4 (branch): idempotency — Temporal-retry safety. A re-attempted transition lands on the
  // same target state; treat as success, no DB mutation, no event emit. ──
  if (currentState === toState) {
    return LeaseTransitionOutcome.ALREADY_APPLIED;
  }

  if (currentState !== fromState) {
    throw new StateDrift({ workspaceId, expectedFrom: fromState, actualState: currentState });
  }

  // ── Step 4 (flip): the migration-0076 inverse-CHECK invariants require the state flip AND the
  // corresponding timestamp column AND (for RELEASE_REQUESTED) the release_requested_by attribution to
  // land in ONE UPDATE so no constraint observes the row mid-transition. The SET clause is composed
  // exclusively from string literals + the static STATE_TIMESTAMP_COLUMNS lookup (keys are validated
  // `toState` values); every value is bound via a parameterised `sql` fragment — no user input enters
  // the SQL string (mirrors the Python's `noqa: S608` static-composition note). ──
  const setClauses: Array<RawBuilder<unknown>> = [sql`state = ${toState}`];
  const tcol = STATE_TIMESTAMP_COLUMNS.get(toState);
  if (tcol !== undefined) {
    // `sql.ref(tcol)` injects the validated column NAME as an identifier (not a bound value); the
    // timestamp itself is a bound parameter from the injected clock.
    setClauses.push(sql`${sql.ref(tcol)} = ${effectiveClock.now()}`);
  }
  if (toState === "RELEASE_REQUESTED") {
    setClauses.push(sql`release_requested_by = ${activity}`);
  }
  // The retry path (FAILED_CLEANUP → RELEASED, per spec §6.3) MUST clear cleanup_failed_at in the same
  // UPDATE so the biconditional CHECK never observes state=RELEASED with cleanup_failed_at NOT NULL.
  if (fromState === "FAILED_CLEANUP" && toState !== "FAILED_CLEANUP") {
    setClauses.push(sql`cleanup_failed_at = NULL`);
  }

  // tenant:exempt reason=PK-update-by-workspace_id follow_up=PERMANENT-EXEMPTION-workspace-lease-pk
  await sql`
    UPDATE core.workspace_leases
       SET ${sql.join(setClauses, sql`, `)}
     WHERE workspace_id = ${workspaceId}
  `.execute(tx);

  // ── Step 5: emit the WORKSPACE_<toState> event. deliveryId is null — workspace lifecycle transitions
  // are internally generated, never tied to a provider webhook delivery. ──
  const eventType = eventTypeFor(toState);
  // Defensive: every workspace event_type must be registered in EVENT_TYPES (migration 0078). Failure
  // here is a programming error — the LEASE_STATES / eventTypeFor / EVENT_TYPES tables drifted.
  // emitWorkflowEvent itself rejects unknown event_types, but we raise earlier with a workspace-specific
  // message so the cause is obvious in operator logs (1:1 with the Python `pragma: no cover` guard).
  if (!EVENT_TYPES.has(eventType)) {
    throw new Error(
      `transitionLease: eventType='${eventType}' missing from EVENT_TYPES; migration 0078 / LEASE_STATES drift`,
    );
  }
  await emitWorkflowEvent({
    dbOrTx: tx,
    provider: "github",
    runId,
    reviewId,
    eventType,
    payload: {
      workspace_id: workspaceId,
      from_state: fromState,
      to_state: toState,
      activity,
      reason,
    },
    deliveryId: null,
    installationId: actualInstallationId, // BF-3 Phase B
    clock: effectiveClock,
  });

  return LeaseTransitionOutcome.APPLIED;
}
