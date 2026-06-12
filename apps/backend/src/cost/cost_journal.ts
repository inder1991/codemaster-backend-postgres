/**
 * PostgresCostJournal — de-Temporal Phase 0: the compensating SIGNED per-call cost journal
 * (`telemetry.cost_journal`, migration 0047) that runs ALONGSIDE the `telemetry.cost_daily`
 * aggregate. The ADR fork is resolved as "additive journal": orphaned reservations are healed by
 * APPENDING a release row (see `cost_journal_reconciler.ts`), never a destructive subtract against
 * the shared aggregate, and the parity-critical {@link PostgresCostCapEnforcer} is NOT rewritten —
 * it stays the sole production cap authority until the Phase-4 cutover.
 *
 * ## Two surfaces, one table
 *
 * 1. **Shadow appends** ({@link CostJournalShadowPort}: `appendReserve` / `appendSettle`) — what the
 *    `LlmClient` calls BESIDE the aggregate's `checkOrRaise` / `recordCallCost` when the
 *    `CODEMASTER_COST_JOURNAL_SHADOW=1` seam is on (default OFF). Plain INSERTs, NO locks and NO
 *    decisions: the aggregate is authoritative in shadow mode, so the journal adds zero contention
 *    to the paid path. The client guards every shadow write fail-safe (a journal failure never
 *    perturbs a paid call) and surfaces the swallow via
 *    {@link recordCostJournalShadowWriteFailed}.
 *
 * 2. **The deciding path** (`checkOrRaise` / `recordCallCost`) — the cutover twin of the aggregate
 *    enforcer, NOT called by production in Phase 0. The cap is checked against `SUM(journal)`
 *    (checklist #2): global(day) = SUM over the day's rows (platform-scope zero-UUID rows count
 *    here only); per-org(day, org) = SUM where `installation_id = org`. Decision semantics mirror
 *    the enforcer 1:1 — same `RangeError` guards, same `BedrockBudgetExceededError` reason strings
 *    and scopes, same 55P03 → {@link CostCapLockTimeoutError} mapping — so the [P0.5] parity suite
 *    can drive identical call sequences through both and assert identical decisions.
 *
 * ## Serialization (the SUM analogue of the aggregate's row lock)
 *
 * The aggregate serializes every reservation on the global row's `SELECT ... FOR UPDATE`. A SUM has
 * no single row to lock, so the deciding path takes
 * `pg_advisory_xact_lock(hashtext('cost_journal'), hashtext(today))` — one day-keyed lock — which
 * is the honest equivalent: every reservation contends on the GLOBAL sum anyway, so the per-day
 * lock serializes exactly the calls the global row lock would. `recordCallCost` takes the same lock
 * so a settle can never interleave mid-decision (the aggregate gets this from `FOR UPDATE` on the
 * same rows). `SET LOCAL lock_timeout='2s'` applies to advisory-lock waits too, so contention maps
 * to the same `CostCapLockTimeoutError` the Bedrock client already handles.
 *
 * ## call_id and the always-append settle
 *
 * `call_id` = the ADR-0068 ledger `idempotency_key` (the client's `requestId` uuid4 for un-ledgered
 * paid calls) — the reconciler pairs reserve/settle/release rows by it. `recordCallCost` therefore
 * ALWAYS appends the settle row, INCLUDING the `diff == 0` case the aggregate early-returns on: a
 * zero row leaves every SUM unchanged (decision parity preserved) but is the reconciler's proof the
 * call completed — without it a fully-settled zero-diff call would be "healed" with a spurious
 * release and the SUMs would diverge.
 *
 * ## Tenancy / clock
 *
 * `telemetry.cost_journal` is scope-discriminated exactly like `telemetry.cost_daily` (NOT in
 * `TENANT_SCOPED_TABLES`; the `installation_id` column is the discriminator, zero-UUID = platform
 * scope). Statements that don't naturally carry an `installation_id` token carry the enforcer's
 * documentation-idiom `tenant:exempt` marker. Every `created_at` is authored by the injected
 * {@link Clock} (no wall-clock reads — the clock_random gate), which is what lets the reconciler
 * tests drive orphan aging with a `FakeClock`.
 */

import { type Kysely, sql } from "kysely";

import { type Clock, WallClock } from "#platform/clock.js";
import { tenantKysely } from "#platform/db/database.js";
import { type Counter, getMeter } from "#platform/observability/metrics.js";

import {
  BedrockBudgetExceededError,
  CostCapDecisionV1,
  CostCapLockTimeoutError,
  type CostCapDecision,
  DEFAULT_GLOBAL_CAP_CENTS,
  DEFAULT_PER_ORG_CAP_CENTS,
} from "#backend/cost/enforcer.js";

// ─── Constants (mirroring postgres_enforcer.ts so the parity suite compares like with like) ────────

/** The zero-UUID platform-scope sentinel — same semantics as the enforcer's global/platform scope. */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * `SET LOCAL lock_timeout` — applies to the advisory-lock wait below exactly as it applies to the
 * enforcer's `FOR UPDATE` wait; Postgres raises SQLSTATE 55P03 either way, which we translate to
 * {@link CostCapLockTimeoutError} so the Bedrock client's retry-once-then-fail-closed policy keeps
 * working unchanged if the deciding path ever goes live. Values verbatim from postgres_enforcer.ts.
 */
const PG_LOCK_TIMEOUT_SQLSTATE = "55P03";
const LOCK_TIMEOUT = "2s";

/** A Kysely/pg transaction connection — what `db.transaction().execute((trx) => …)` hands the callback. */
type Trx = Kysely<unknown>;

/** Narrow the unknown thrown value to a node-postgres error carrying a SQLSTATE `.code`. */
function pgSqlstate(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Map a thrown error to {@link CostCapLockTimeoutError} when it is the Postgres lock-timeout
 * (55P03), else re-throw unchanged — `BedrockBudgetExceededError` carries no `.code`, so refusals
 * surface verbatim. Local copy of the enforcer's private helper (postgres_enforcer.ts stays
 * untouched — the no-Pattern-D-rewrite rule).
 */
function mapLockTimeout(err: unknown, context: string): never {
  if (pgSqlstate(err) === PG_LOCK_TIMEOUT_SQLSTATE) {
    throw new CostCapLockTimeoutError(context);
  }
  throw err;
}

/** `COALESCE(SUM(amount_cents), 0)` read row (pg returns bigint sums as strings). */
type SumRow = {
  readonly cents: string;
};

/** A `cost_daily` row read by the divergence seam. */
type CostDailyRow = {
  readonly scope: string;
  readonly scope_id: string;
  readonly daily_total_cents: string;
};

/** A per-installation journal SUM group read by the divergence seam. */
type JournalGroupRow = {
  readonly installation_id: string;
  readonly cents: string;
};

// ─── Ports / argument shapes ───────────────────────────────────────────────────────────────────────

/** One signed journal append: the (callId, installationId, amountCents, today) event coordinates. */
export type CostJournalAppendArgs = {
  /** The ADR-0068 ledger idempotency_key (sha256 hex) — or the client's requestId for un-ledgered calls. */
  callId: string;
  /** The org installation, or the zero-UUID sentinel for platform-scope (global-only) spend. */
  installationId: string;
  /** SIGNED integer cents: reserve ≥ 0; settle = actual − estimated (any sign). */
  amountCents: number;
  /** The accounting day (`YYYY-MM-DD`) — the SAME value the aggregate keys `cost_daily` on. */
  today: string;
};

/**
 * The narrow injection seam the `LlmClient` shadow writes depend on — the concrete
 * {@link PostgresCostJournal} satisfies it structurally; unit tests inject an in-memory fake
 * (exactly the {@link LlmInvocationLedgerPort} pattern).
 */
export type CostJournalShadowPort = {
  appendReserve(args: CostJournalAppendArgs): Promise<void>;
  appendSettle(args: CostJournalAppendArgs): Promise<void>;
};

/**
 * One row of the dual-read comparison report: a (scope[, scope_id]) whose aggregate daily total
 * differs from the journal SUM for the day. The global row carries the zero-UUID sentinel as its
 * `scopeId`, mirroring the `cost_daily` row shape.
 */
export type CostJournalDivergence = {
  readonly scope: "global" | "per_org";
  readonly scopeId: string;
  readonly aggregateCents: number;
  readonly journalCents: number;
};

// ─── The journal ───────────────────────────────────────────────────────────────────────────────────

/**
 * The Postgres-backed signed cost journal. Owns NO pool — handed a `Kysely` over the process-wide
 * single pool (ADR-0062); {@link PostgresCostJournal.fromDsn} is the composition-root entry point.
 * `Kysely<unknown>` because only raw `sql` templates are used (mirrors `LlmInvocationLedger`).
 */
export class PostgresCostJournal implements CostJournalShadowPort {
  readonly #db: Kysely<unknown>;
  readonly #clock: Clock;
  public readonly globalCapCents: number;
  public readonly perOrgCapCents: number;

  /**
   * Caps default to the enforcer's env-var-seeded constants. DB-resolved live caps
   * (`core.cost_cap_overrides` / `cost_cap_settings`) are DELIBERATELY deferred to the cutover flip
   * — the deciding path is parity/test-only in Phase 0, and the [P0.5] parity suite drives both
   * sides with constructor caps.
   */
  public constructor(args: {
    db: Kysely<unknown>;
    clock?: Clock;
    globalCapCents?: number;
    perOrgCapCents?: number;
  }) {
    this.#db = args.db;
    this.#clock = args.clock ?? new WallClock();
    this.globalCapCents = args.globalCapCents ?? DEFAULT_GLOBAL_CAP_CENTS;
    this.perOrgCapCents = args.perOrgCapCents ?? DEFAULT_PER_ORG_CAP_CENTS;
  }

  /** Build a journal over the process-wide single pool for `dsn` (ADR-0062 seam). */
  public static fromDsn(args: { dsn: string; clock?: Clock }): PostgresCostJournal {
    return new PostgresCostJournal({
      db: tenantKysely<unknown>(args.dsn),
      // Spread only when present — `exactOptionalPropertyTypes` forbids an explicit `undefined`.
      ...(args.clock !== undefined ? { clock: args.clock } : {}),
    });
  }

  // ─── Shadow appends (the LlmClient seam — no locks, no decisions) ────────────────────────────────

  /** Append a `reserve` row (+estimated). Negative amounts are a programmer error, refused early. */
  public async appendReserve(args: CostJournalAppendArgs): Promise<void> {
    if (args.amountCents < 0) {
      throw new RangeError("reserve amountCents must be >= 0");
    }
    await this.#append(this.#db, { ...args, entryKind: "reserve" });
  }

  /** Append a `settle` row (actual − estimated; refund negative, top-up positive, zero allowed). */
  public async appendSettle(args: CostJournalAppendArgs): Promise<void> {
    await this.#append(this.#db, { ...args, entryKind: "settle" });
  }

  /** The one INSERT every append routes through; `created_at` authored by the injected clock. */
  async #append(
    db: Trx,
    args: CostJournalAppendArgs & { entryKind: "reserve" | "settle" },
  ): Promise<void> {
    await sql`
      INSERT INTO telemetry.cost_journal
          (call_id, installation_id, today, entry_kind, amount_cents, created_at)
      VALUES
          (${args.callId}, ${args.installationId}::uuid, ${args.today}, ${args.entryKind},
           ${args.amountCents}, ${this.#clock.now()})
    `.execute(db);
  }

  // ─── The deciding path (cutover twin of the aggregate enforcer; parity/test-only in Phase 0) ─────

  /**
   * Cap check AGAINST THE SUM + reserve append, atomically, serialized per day by the advisory
   * lock. Mirrors `PostgresCostCapEnforcer.checkOrRaise` decision-for-decision: same guards, same
   * refusal reason strings/scopes (a refusal rolls back, appending nothing), same lock-timeout
   * mapping, same `CostCapDecisionV1` return carrying the PRIOR sums.
   */
  public async checkOrRaise(args: {
    callId: string;
    installationId: string;
    estimatedCents: number;
    today: string;
  }): Promise<CostCapDecision> {
    const { callId, installationId, estimatedCents, today } = args;
    if (estimatedCents < 0) {
      throw new RangeError("estimatedCents must be >= 0");
    }
    const isPlatformScope = installationId === ZERO_UUID;

    try {
      return await this.#db.transaction().execute(async (trx) => {
        await this.#lockDay(trx, today);

        const globalTotal = await this.#sumDay(trx, { today });
        const orgTotal = isPlatformScope ? 0 : await this.#sumDay(trx, { today, installationId });

        // Budget checks — reason strings verbatim from the aggregate enforcer so the parity suite
        // (and any operator reading logs) sees IDENTICAL refusals from either implementation.
        if (globalTotal + estimatedCents > this.globalCapCents) {
          throw new BedrockBudgetExceededError({
            reason:
              `global spend ${globalTotal} + estimated ${estimatedCents} ` +
              `would exceed cap ${this.globalCapCents} cents/day`,
            scope: "global",
          });
        }
        if (!isPlatformScope && orgTotal + estimatedCents > this.perOrgCapCents) {
          throw new BedrockBudgetExceededError({
            reason:
              `org ${installationId} spend ${orgTotal} + estimated ` +
              `${estimatedCents} would exceed per-org cap ${this.perOrgCapCents} cents/day`,
            scope: "per_org",
            scopeId: installationId,
          });
        }

        // Reserve by APPEND, inside the same locked transaction (a refusal above rolls back into
        // appending nothing — the journal twin of "refused reservations don't leak").
        await this.#append(trx, {
          callId,
          installationId,
          amountCents: estimatedCents,
          today,
          entryKind: "reserve",
        });

        return CostCapDecisionV1.parse({
          allowed: true,
          cents_spent_today_global: globalTotal,
          cents_spent_today_org: orgTotal,
          cents_estimated: estimatedCents,
        });
      });
    } catch (err) {
      mapLockTimeout(
        err,
        `cost_journal day lock timed out after ${LOCK_TIMEOUT} ` +
          `(SQLSTATE ${PG_LOCK_TIMEOUT_SQLSTATE}); BedrockClient will retry once`,
      );
    }
  }

  /**
   * Post-call accounting: append the `settle` row of `costCents − estimatedCents` under the same
   * day lock (so a settle never interleaves mid-decision — the aggregate gets this from taking
   * `FOR UPDATE` on the same rows). DELIBERATE divergence from the aggregate's `diff === 0`
   * early-return: the zero settle row IS appended — it leaves every SUM unchanged but is the
   * reconciler's proof the call completed (see the module header).
   */
  public async recordCallCost(args: {
    callId: string;
    installationId: string;
    costCents: number;
    today: string;
    estimatedCents?: number;
  }): Promise<void> {
    const { callId, installationId, costCents, today, estimatedCents = 0 } = args;
    if (costCents < 0) {
      throw new RangeError("costCents must be >= 0");
    }
    const diff = costCents - estimatedCents;

    try {
      await this.#db.transaction().execute(async (trx) => {
        await this.#lockDay(trx, today);
        await this.#append(trx, {
          callId,
          installationId,
          amountCents: diff,
          today,
          entryKind: "settle",
        });
      });
    } catch (err) {
      mapLockTimeout(
        err,
        `cost_journal day lock timed out during recordCallCost ` +
          `(SQLSTATE ${PG_LOCK_TIMEOUT_SQLSTATE})`,
      );
    }
  }

  // ─── Reads ────────────────────────────────────────────────────────────────────────────────────

  /**
   * The SUM invariant read: with `installationId`, the per-org total; without it, the GLOBAL total
   * (every row of the day — platform-scope zero-UUID rows included, exactly as every call lands on
   * the aggregate's global row).
   */
  public async sumForDay(args: { today: string; installationId?: string }): Promise<number> {
    return this.#sumDay(this.#db, args);
  }

  async #sumDay(db: Trx, args: { today: string; installationId?: string }): Promise<number> {
    if (args.installationId !== undefined) {
      const r = await sql<SumRow>`
        SELECT COALESCE(SUM(amount_cents), 0) AS cents
          FROM telemetry.cost_journal
         WHERE today = ${args.today} AND installation_id = ${args.installationId}::uuid
      `.execute(db);
      return Number(r.rows[0]?.cents ?? 0);
    }
    // tenant:exempt reason=scope-discriminated-cost-journal follow_up=PERMANENT-EXEMPTION-cost-daily-scope
    const r = await sql<SumRow>`
      SELECT COALESCE(SUM(amount_cents), 0) AS cents
        FROM telemetry.cost_journal
       WHERE today = ${args.today}
    `.execute(db);
    return Number(r.rows[0]?.cents ?? 0);
  }

  /**
   * The DUAL-READ comparison seam (checklist #4): report every (scope[, scope_id]) whose
   * `cost_daily.daily_total_cents` differs from the journal SUM for `today`. Empty report == the
   * two accountings agree. Keys present on only ONE side are compared against 0 (a journal-only
   * key means the aggregate write was lost; an aggregate-only key means the guarded shadow write
   * was swallowed — both must surface). A POST-HEAL delta (journal released an orphan the
   * aggregate still leaks) is the BY-DESIGN divergence this seam exists to quantify before
   * cutover. Two snapshot reads, no locks — the seam is an observability read, not a decider; a
   * torn read across a concurrent write shows up as transient divergence that the next comparison
   * clears. Deterministic order: global first, then per_org sorted by scopeId.
   */
  public async divergenceFromAggregate(args: {
    today: string;
  }): Promise<ReadonlyArray<CostJournalDivergence>> {
    const { today } = args;
    // tenant:exempt reason=scope-discriminated-cost-daily follow_up=PERMANENT-EXEMPTION-cost-daily-scope
    const agg = await sql<CostDailyRow>`
      SELECT scope, scope_id, daily_total_cents
        FROM telemetry.cost_daily
       WHERE today = ${today}
    `.execute(this.#db);
    // tenant:exempt reason=scope-discriminated-cost-journal follow_up=PERMANENT-EXEMPTION-cost-daily-scope
    const jnl = await sql<JournalGroupRow>`
      SELECT installation_id, COALESCE(SUM(amount_cents), 0) AS cents
        FROM telemetry.cost_journal
       WHERE today = ${today}
       GROUP BY installation_id
    `.execute(this.#db);

    // Journal view: global = the sum of EVERY group (platform-scope zero-UUID rows included —
    // exactly as every call lands on the aggregate's global row); per-org = the non-sentinel groups.
    let journalGlobal = 0;
    const journalOrg = new Map<string, number>();
    for (const row of jnl.rows) {
      const cents = Number(row.cents);
      journalGlobal += cents;
      if (row.installation_id !== ZERO_UUID) {
        journalOrg.set(row.installation_id, cents);
      }
    }

    // Aggregate view, keyed identically.
    let aggregateGlobal = 0;
    const aggregateOrg = new Map<string, number>();
    for (const row of agg.rows) {
      if (row.scope === "global") {
        aggregateGlobal = Number(row.daily_total_cents);
      } else {
        aggregateOrg.set(row.scope_id, Number(row.daily_total_cents));
      }
    }

    const report: Array<CostJournalDivergence> = [];
    if (aggregateGlobal !== journalGlobal) {
      report.push({
        scope: "global",
        scopeId: ZERO_UUID,
        aggregateCents: aggregateGlobal,
        journalCents: journalGlobal,
      });
    }
    const orgIds = [...new Set([...aggregateOrg.keys(), ...journalOrg.keys()])].sort();
    for (const scopeId of orgIds) {
      const aggregateCents = aggregateOrg.get(scopeId) ?? 0;
      const journalCents = journalOrg.get(scopeId) ?? 0;
      if (aggregateCents !== journalCents) {
        report.push({ scope: "per_org", scopeId, aggregateCents, journalCents });
      }
    }
    return report;
  }

  /**
   * The day-keyed advisory lock + lock_timeout — the deciding path's serialization primitive (see
   * the module header). Transaction-scoped: commit/rollback releases it, exactly like the
   * aggregate's row lock.
   */
  async #lockDay(trx: Trx, today: string): Promise<void> {
    await sql`SET LOCAL lock_timeout = ${sql.lit(LOCK_TIMEOUT)}`.execute(trx);
    await sql`SELECT pg_advisory_xact_lock(hashtext('cost_journal'), hashtext(${today}))`.execute(trx);
  }
}

// ─── shadow-write telemetry — one bounded-cardinality counter, label `entry` only ──────────────────
//
// The client GUARDS every shadow journal write (a journal failure must never perturb the paid path —
// the aggregate enforcer remains the decider), so without this counter a dead journal would silently
// stop shadow-accounting and the dual-read comparison would report bogus divergence at cutover
// review time. Mirrors the invocation_ledger store_failed idiom: module-scoped meter + instrument
// cached once at import, every emit fail-safe. Cardinality discipline: the ONLY label is `entry`
// (bounded to {reserve, settle}) — NEVER per-tenant / per-call labels.

/** Grafana-query-stable counter name (renaming requires ADR). */
export const COST_JOURNAL_SHADOW_WRITE_FAILED_TOTAL_NAME =
  "codemaster_cost_journal_shadow_write_failed_total";

const COST_JOURNAL_METER = getMeter("codemaster.cost.cost_journal");

const SHADOW_WRITE_FAILED_COUNTER: Counter = COST_JOURNAL_METER.createCounter(
  COST_JOURNAL_SHADOW_WRITE_FAILED_TOTAL_NAME,
  {
    description:
      "Count of GUARDED cost-journal shadow writes that FAILED beside a successful aggregate " +
      "cost-cap call (the swallow keeps the paid path healthy but leaves a journal gap the " +
      "divergence seam will report). Bounded label `entry` (reserve|settle).",
  },
);

/** Record one swallowed shadow-write failure. `entry` is the bounded label. Fail-safe. */
export function recordCostJournalShadowWriteFailed(entry: "reserve" | "settle"): void {
  try { SHADOW_WRITE_FAILED_COUNTER.add(1, { entry }); } catch { /* telemetry never perturbs the paid path */ }
}

// ─── the feature seam (default OFF) ─────────────────────────────────────────────────────────────────

/**
 * The Phase-0 shadow-write feature seam: the composition roots wire a {@link PostgresCostJournal}
 * into the `LlmClient` ONLY when `CODEMASTER_COST_JOURNAL_SHADOW` is EXACTLY `"1"`. STRICT on
 * purpose — truthy-looking strings (`"true"`, `"yes"`, `" 1"`) stay OFF, so a typo can never
 * silently turn on double-writes; an operator must set the one documented value. Unset (every
 * environment today) → no journal anywhere → production behavior is byte-identical until the
 * deliberate cutover-prep flip. Read at COLLABORATOR-BUILD time (not module import), so a test /
 * operator toggle takes effect without re-importing the world.
 */
export function costJournalShadowEnabled(env: NodeJS.ProcessEnv): boolean {
  return env["CODEMASTER_COST_JOURNAL_SHADOW"] === "1";
}
