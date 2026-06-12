/**
 * Production cost-cap enforcer — 1:1 TypeScript/Kysely port of the frozen Python spine enforcer
 * `vendor/codemaster-py/codemaster/cost/postgres_enforcer.py::PostgresCostCapEnforcer`
 * (Sprint 14 / S14.D, closes audit B1.1 + B2.6; Sprint 15 / S15.H cap-resolution).
 *
 * This is the REAL, atomic, optimistic-reservation enforcer the frozen worker wires ALWAYS-ON in
 * production — NOT a stub, mock, or no-op. (The {@link InMemoryCostCapEnforcer} in
 * `#backend/cost/enforcer.js` is the unit-test double; the `AllowAllCostCap` default inside
 * `LlmClient` is the cassette-test default that the production `LlmClientCache` REPLACES with an
 * instance of THIS class.)
 *
 * ## What it does (W2.1 — lock-free conditional-UPDATE gate; closes XC4)
 *
 * `checkOrRaise` opens a transaction, sets `lock_timeout`, ensures the global + per-org rows exist
 * (idempotent `INSERT ... ON CONFLICT DO NOTHING`), then reserves via ONE atomic conditional
 * `UPDATE ... SET daily_total_cents = daily_total_cents + :est WHERE ... AND daily_total_cents +
 * :est <= cap_cents RETURNING daily_total_cents` per cap (global first, then per-org). A returned
 * row ⇒ reserved under that cap; 0 rows ⇒ over cap ⇒ `BedrockBudgetExceededError`. The row lock is
 * statement-internal — Postgres' READ COMMITTED predicate re-check after a lock wait re-sees a
 * competitor's committed increment before applying, so the cap can never be overshot — and is NOT
 * held across the read→app-decide→write round-trips the pre-W2.1 `SELECT ... FOR UPDATE` enforcer
 * serialized every paid call on (the XC4 hot-row lock storm). Both gates run in ONE transaction; a
 * refusal at either throws and rolls back BOTH, so a partial increment never leaks.
 *
 * `recordCallCost` applies the `actual - estimated` diff to both rows as single unconditional
 * UPDATEs (no pre-locking read) so the daily total tracks reality. Refunds (actual < estimated) are
 * negative diffs that correctly walk the total down; the DB `daily_total_cents >= 0` CHECK faults
 * loudly if a coding bug ever drives it negative. ALL arithmetic is INTEGER cents — no float, no
 * division.
 *
 * Residual hot spot + documented FOLLOW-UP (master-hardening-plan W2.1 fallback): every reservation
 * still touches the single global row, now only for the microseconds the statement holds it. If that
 * residual contention ever shows (watch `codemaster_cost_cap_lock_timeout_total`), the plan's
 * fallback is to shard the global counter K-ways (gate on a random shard; cap/K per shard) or a
 * per-pod token bucket with DB reconciliation. NOT implemented — the conditional UPDATE alone
 * removes the held-lock serialization, and sharding would trade exactness at the cap boundary.
 *
 * Caps are stored on the daily row (not just on the instance) so an admin override is visible to all
 * worker pods immediately, without a redeploy. When `readCapsFromDb` is true (the production path
 * post-S15.H), every check consults `core.cost_cap_overrides` + `core.cost_cap_settings` for the live
 * cap values BEFORE writing them onto the daily row; the constructor caps are the env-var-seeded
 * fallback used only when those tables are empty (first-boot before the bootstrap seed).
 *
 * ## Concurrency / connection contract (ADR-0062)
 *
 * Each call runs inside `db.transaction().execute(trx => …)` over the SHARED single-pool Kysely seam
 * ({@link tenantKysely} / {@link getPool}). Kysely pins ONE checked-out connection for the whole
 * transaction callback, so `SET LOCAL lock_timeout`, the idempotent INSERTs, and the conditional
 * reserve-gate `UPDATE`s all run on the same connection — exactly the single-connection contract
 * the Python `async with session.begin()` provides. The `pg.Pool` is NEVER created per call.
 *
 * ## Tenancy (telemetry.cost_daily is scope-discriminated, NOT per-installation)
 *
 * `telemetry.cost_daily`, `core.cost_cap_overrides`, and `core.cost_cap_settings` are NOT in
 * `TENANT_SCOPED_TABLES` (verified against `libs/platform/src/db/tenant_scoped_tables.ts`). The
 * cost-daily row's tenancy is a `(scope, scope_id)` discriminator — the global row carries the
 * zero-UUID sentinel and the per-org row carries the installation as `scope_id`, NOT as an
 * `installation_id`-equality filter the runtime `TenancyPlugin` / PR-time raw-SQL gate can model.
 * `cost_cap_overrides` keys on `installation_id` as a PK (the row IS the scope), and `cost_cap_settings`
 * is platform-global. Each raw `sql` below carries the `// tenant:exempt reason=… follow_up=…` marker
 * verbatim from the part-1 settings-repo platform-config idiom so a human reviews any future query and
 * the scope-discriminated rationale travels with the code. (Mirrors the frozen Python, which carries
 * no `installation_id` filter on these tables.)
 *
 * ## Clock seam
 *
 * The injected {@link Clock} authors `updated_at` on every write and the `now()` comparison in the
 * `cost_cap_overrides` expiry predicate — mirroring the Python `self._clock.now()`. No raw `Date` /
 * `Math.random` is used (the `check_clock_random` gate is satisfied).
 *
 * @see vendor/codemaster-py/codemaster/cost/postgres_enforcer.py — the frozen source of truth.
 */

import { type Kysely, sql } from "kysely";

import { type Clock, WallClock } from "#platform/clock.js";
import { tenantKysely } from "#platform/db/database.js";

import {
  BedrockBudgetExceededError,
  CostCapDecisionV1,
  CostCapLockTimeoutError,
  type CostCapDecision,
  type CostCapEnforcer,
  DEFAULT_GLOBAL_CAP_CENTS,
  DEFAULT_PER_ORG_CAP_CENTS,
} from "#backend/cost/enforcer.js";

// ─── Constants (1:1 with the frozen postgres_enforcer.py module constants) ──────────────────────────

/**
 * The zero-UUID sentinel the global-scope row carries (migration 0024 default + the
 * `cost_daily_global_has_zero_scope_id` CHECK). Inserted LITERALLY for the global scope (the column
 * DEFAULT only fires when the column is OMITTED; an explicit NULL would be the literal NULL and
 * violate the CHECK). Callers pass this same sentinel for platform-scope (walkthrough / housekeeping)
 * LLM invocations that don't bill against a specific org.
 */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * `SET LOCAL lock_timeout` — Postgres returns SQLSTATE 55P03 when the row lock cannot be acquired
 * within this window. We translate that to {@link CostCapLockTimeoutError} so the Bedrock client can
 * apply the retry-once-then-fail-closed policy from the S14.D failure-mode spec. Verbatim from the
 * Python `_PG_LOCK_TIMEOUT_SQLSTATE` / `_LOCK_TIMEOUT_SECONDS`.
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
 * Map a thrown error to {@link CostCapLockTimeoutError} when it is the Postgres lock-timeout (55P03),
 * else re-throw it unchanged. `BedrockBudgetExceededError` (a refusal, not a DB error) carries no
 * `.code`, so it falls through to the re-throw and surfaces to the caller verbatim — exactly the
 * Python `except DBAPIError` branch, which only intercepts driver errors.
 */
function mapLockTimeout(err: unknown, context: string): never {
  if (pgSqlstate(err) === PG_LOCK_TIMEOUT_SQLSTATE) {
    throw new CostCapLockTimeoutError(context);
  }
  throw err;
}

// ─── Row shapes the raw `sql<T>` reads materialize ──────────────────────────────────────────────────

/** `daily_total_cents` + `cap_cents` from a lock-free `cost_daily` SELECT (pg returns bigint as string). */
type DailyRow = {
  readonly daily_total_cents: string;
  readonly cap_cents: string;
};

/** The `RETURNING daily_total_cents` row of a conditional reserve-gate UPDATE (the POST-update total). */
type GateRow = {
  readonly daily_total_cents: string;
};

/** `cap_cents` from a `cost_cap_overrides` / `cost_cap_settings` cap-resolution read. */
type CapRow = {
  readonly cap_cents: string;
};

// ─── The enforcer ───────────────────────────────────────────────────────────────────────────────────

/**
 * Atomic, optimistic-reservation cost-cap enforcer — the production path.
 *
 * Drop-in for the {@link CostCapEnforcer} interface (the same one {@link InMemoryCostCapEnforcer}
 * implements), so the `LlmClient` / `LlmClientCache` can inject it without code changes.
 */
export class PostgresCostCapEnforcer implements CostCapEnforcer {
  private readonly db: Kysely<unknown>;
  private readonly clock: Clock;
  public readonly globalCapCents: number;
  public readonly perOrgCapCents: number;
  private readonly readCapsFromDb: boolean;

  public constructor(args: {
    db: Kysely<unknown>;
    clock?: Clock;
    globalCapCents?: number;
    perOrgCapCents?: number;
    readCapsFromDb?: boolean;
  }) {
    this.db = args.db;
    this.clock = args.clock ?? new WallClock();
    this.globalCapCents = args.globalCapCents ?? DEFAULT_GLOBAL_CAP_CENTS;
    this.perOrgCapCents = args.perOrgCapCents ?? DEFAULT_PER_ORG_CAP_CENTS;
    // Production default: read live caps from core.cost_cap_overrides + core.cost_cap_settings
    // (S15.H). The Python constructor defaults this False; the PRODUCTION wiring passes True. We keep
    // the same default-False so call sites are explicit about the production posture (mirrors Python).
    this.readCapsFromDb = args.readCapsFromDb ?? false;
  }

  /**
   * Build an enforcer whose `Kysely` is the shared single-pool tenant Kysely for `dsn` (ADR-0062
   * seam). Mirrors the `*.fromDsn(...)` convenience constructor the sibling spine repos expose for the
   * lazy-fallback wiring; the production `LlmClientCache` uses this to construct the always-on
   * enforcer from `CODEMASTER_PG_CORE_DSN`.
   */
  public static fromDsn(args: {
    dsn: string;
    clock?: Clock;
    globalCapCents?: number;
    perOrgCapCents?: number;
    readCapsFromDb?: boolean;
  }): PostgresCostCapEnforcer {
    return new PostgresCostCapEnforcer({
      db: tenantKysely<unknown>(args.dsn),
      // Spread only when present — `exactOptionalPropertyTypes` forbids passing an explicit
      // `undefined` for an optional field.
      ...(args.clock !== undefined ? { clock: args.clock } : {}),
      ...(args.globalCapCents !== undefined ? { globalCapCents: args.globalCapCents } : {}),
      ...(args.perOrgCapCents !== undefined ? { perOrgCapCents: args.perOrgCapCents } : {}),
      ...(args.readCapsFromDb !== undefined ? { readCapsFromDb: args.readCapsFromDb } : {}),
    });
  }

  public async checkOrRaise(args: {
    installationId: string;
    estimatedCents: number;
    today: string;
  }): Promise<CostCapDecision> {
    const { installationId, estimatedCents, today } = args;
    if (estimatedCents < 0) {
      throw new RangeError("estimatedCents must be >= 0");
    }
    const isPlatformScope = installationId === ZERO_UUID;

    try {
      return await this.db.transaction().execute(async (trx) => {
        // SET LOCAL lock_timeout — bounded by this transaction; 55P03 on a contended row lock.
        await sql`SET LOCAL lock_timeout = ${sql.lit(LOCK_TIMEOUT)}`.execute(trx);

        // Idempotent global-scope row creation. The zero-UUID sentinel is inserted LITERALLY (the
        // column DEFAULT only fires when the column is OMITTED; an explicit NULL would violate the
        // cost_daily_global_has_zero_scope_id CHECK). Smoke-driven bug fix 2026-05-11.
        // tenant:exempt reason=scope-discriminated-cost-daily follow_up=PERMANENT-EXEMPTION-cost-daily-scope
        await sql`
          INSERT INTO telemetry.cost_daily
            (today, scope, scope_id, daily_total_cents, cap_cents)
          VALUES (${today}, 'global', ${ZERO_UUID}::uuid, 0, ${this.globalCapCents})
          ON CONFLICT DO NOTHING
        `.execute(trx);
        // Skip the per_org INSERT for platform-scope calls (zero-UUID sentinel) — the CHECK requires
        // scope='per_org' ⇒ scope_id <> ZERO. Global-scope tracking covers the platform-scope spend.
        if (!isPlatformScope) {
          // tenant:exempt reason=scope-discriminated-cost-daily follow_up=PERMANENT-EXEMPTION-cost-daily-scope
          await sql`
            INSERT INTO telemetry.cost_daily
              (today, scope, scope_id, daily_total_cents, cap_cents)
            VALUES (${today}, 'per_org', ${installationId}::uuid, 0, ${this.perOrgCapCents})
            ON CONFLICT DO NOTHING
          `.execute(trx);
        }

        // Refresh cap_cents so admin overrides take effect within seconds (S14.5.G); the DB
        // resolution (S15.H) picks the live cap when readCapsFromDb is true, env-var seed as
        // first-boot fallback.
        const effectiveGlobalCap = await this.resolveEffectiveCap(trx, {
          scope: "global",
          scopeId: null,
          fallback: this.globalCapCents,
        });
        const effectiveOrgCap = await this.resolveEffectiveCap(trx, {
          scope: "per_org",
          scopeId: installationId,
          fallback: this.perOrgCapCents,
        });
        await this.refreshCapCents(trx, {
          today,
          scope: "global",
          scopeId: null,
          configuredCap: effectiveGlobalCap,
        });
        await this.refreshCapCents(trx, {
          today,
          scope: "per_org",
          scopeId: installationId,
          configuredCap: effectiveOrgCap,
        });

        // ── The lock-free reserve gate (W2.1, closes XC4) ─────────────────────────────────────────
        // ONE atomic conditional UPDATE per cap: Postgres locks the row only INSIDE the statement
        // (lock → re-evaluate the predicate against the latest committed version → apply or skip),
        // never across a read→app-decide→write round-trip. Row returned ⇒ reserved under the cap;
        // 0 rows ⇒ over cap ⇒ refused. Under READ COMMITTED the predicate re-check after a lock wait
        // is exactly what makes concurrent gates correct: a competitor's committed increment is
        // re-seen before this UPDATE applies, so the cap can NEVER be overshot.
        //
        // Gate order is global→per_org, matching the cap-refresh write order above and the settle
        // order in recordCallCost — every cost_daily writer acquires row locks in the same order, so
        // writers cannot deadlock. A refusal at EITHER gate throws, rolling back the WHOLE
        // transaction: a passed global gate never leaks a partial increment when the per-org gate
        // refuses.
        // tenant:exempt reason=scope-discriminated-cost-daily follow_up=PERMANENT-EXEMPTION-cost-daily-scope
        const gGate = await sql<GateRow>`
          UPDATE telemetry.cost_daily
             SET daily_total_cents = daily_total_cents + ${estimatedCents},
                 updated_at = ${this.clock.now()}
           WHERE today = ${today} AND scope = 'global'
             AND daily_total_cents + ${estimatedCents} <= cap_cents
           RETURNING daily_total_cents
        `.execute(trx);
        const gRow = gGate.rows[0];
        if (gRow === undefined) {
          // Over cap (the row EXISTS — the idempotent INSERT above ran in THIS transaction; a
          // missing row is a programmer error readDailyRow faults on). Lock-free message read; the
          // throw rolls back, so a refused call reserves nothing.
          const g = await this.readDailyRow(trx, { today, scope: "global", scopeId: null });
          throw new BedrockBudgetExceededError({
            reason:
              `global spend ${g.total} + estimated ${estimatedCents} ` +
              `would exceed cap ${g.cap} cents/day`,
            scope: "global",
          });
        }
        // RETURNING carries the POST-update total; the decision contract reports the PRIOR spend.
        const globalTotal = Number(gRow.daily_total_cents) - estimatedCents;

        // per_org gate skipped for platform-scope calls (symmetric with the INSERT gate).
        let orgTotal = 0;
        if (!isPlatformScope) {
          // tenant:exempt reason=scope-discriminated-cost-daily follow_up=PERMANENT-EXEMPTION-cost-daily-scope
          const oGate = await sql<GateRow>`
            UPDATE telemetry.cost_daily
               SET daily_total_cents = daily_total_cents + ${estimatedCents},
                   updated_at = ${this.clock.now()}
             WHERE today = ${today} AND scope = 'per_org' AND scope_id = ${installationId}::uuid
               AND daily_total_cents + ${estimatedCents} <= cap_cents
             RETURNING daily_total_cents
          `.execute(trx);
          const oRow = oGate.rows[0];
          if (oRow === undefined) {
            const o = await this.readDailyRow(trx, {
              today,
              scope: "per_org",
              scopeId: installationId,
            });
            throw new BedrockBudgetExceededError({
              reason:
                `org ${installationId} spend ${o.total} + estimated ` +
                `${estimatedCents} would exceed per-org cap ${o.cap} cents/day`,
              scope: "per_org",
              scopeId: installationId,
            });
          }
          orgTotal = Number(oRow.daily_total_cents) - estimatedCents;
        }

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
        `cost_daily row lock timed out after ${LOCK_TIMEOUT} ` +
          `(SQLSTATE ${PG_LOCK_TIMEOUT_SQLSTATE}); BedrockClient will retry once`,
      );
    }
  }

  public async recordCallCost(args: {
    installationId: string;
    costCents: number;
    today: string;
    estimatedCents?: number;
  }): Promise<void> {
    const { installationId, costCents, today, estimatedCents = 0 } = args;
    if (costCents < 0) {
      throw new RangeError("costCents must be >= 0");
    }
    const diff = costCents - estimatedCents;
    if (diff === 0) {
      return;
    }
    const isPlatformScope = installationId === ZERO_UUID;

    try {
      await this.db.transaction().execute(async (trx) => {
        await sql`SET LOCAL lock_timeout = ${sql.lit(LOCK_TIMEOUT)}`.execute(trx);

        // Defensive cap refresh on both rows (S14.5.G) so a cap edit between the reservation and the
        // post-call accounting still lands the new value on the row.
        const effectiveGlobalCap = await this.resolveEffectiveCap(trx, {
          scope: "global",
          scopeId: null,
          fallback: this.globalCapCents,
        });
        const effectiveOrgCap = await this.resolveEffectiveCap(trx, {
          scope: "per_org",
          scopeId: installationId,
          fallback: this.perOrgCapCents,
        });
        await this.refreshCapCents(trx, {
          today,
          scope: "global",
          scopeId: null,
          configuredCap: effectiveGlobalCap,
        });
        await this.refreshCapCents(trx, {
          today,
          scope: "per_org",
          scopeId: installationId,
          configuredCap: effectiveOrgCap,
        });

        // SELECT FOR UPDATE on both rows so the diff is applied under the same lock as the original
        // reservation — no torn read between this UPDATE and a concurrent checkOrRaise.
        // tenant:exempt reason=scope-discriminated-cost-daily follow_up=PERMANENT-EXEMPTION-cost-daily-scope
        await sql`
          SELECT daily_total_cents FROM telemetry.cost_daily
           WHERE today = ${today} AND scope = 'global' FOR UPDATE
        `.execute(trx);
        if (!isPlatformScope) {
          // tenant:exempt reason=scope-discriminated-cost-daily follow_up=PERMANENT-EXEMPTION-cost-daily-scope
          await sql`
            SELECT daily_total_cents FROM telemetry.cost_daily
             WHERE today = ${today} AND scope = 'per_org' AND scope_id = ${installationId}::uuid FOR UPDATE
          `.execute(trx);
        }
        // tenant:exempt reason=scope-discriminated-cost-daily follow_up=PERMANENT-EXEMPTION-cost-daily-scope
        await sql`
          UPDATE telemetry.cost_daily
             SET daily_total_cents = daily_total_cents + ${diff}, updated_at = ${this.clock.now()}
           WHERE today = ${today} AND scope = 'global'
        `.execute(trx);
        if (!isPlatformScope) {
          // tenant:exempt reason=scope-discriminated-cost-daily follow_up=PERMANENT-EXEMPTION-cost-daily-scope
          await sql`
            UPDATE telemetry.cost_daily
               SET daily_total_cents = daily_total_cents + ${diff}, updated_at = ${this.clock.now()}
             WHERE today = ${today} AND scope = 'per_org' AND scope_id = ${installationId}::uuid
          `.execute(trx);
        }
      });
    } catch (err) {
      mapLockTimeout(
        err,
        `cost_daily row lock timed out during recordCallCost ` +
          `(SQLSTATE ${PG_LOCK_TIMEOUT_SQLSTATE})`,
      );
    }
  }

  /**
   * Lock-free read of one `(today, scope[, scope_id])` daily row — the refusal-message values for a
   * denied gate, plus the row-missing guard (the idempotent INSERT ran in the same transaction, so
   * a missing row is a programmer error, faulted loudly like the pre-W2.1 FOR-UPDATE read did).
   */
  private async readDailyRow(
    trx: Trx,
    args: { today: string; scope: "global" | "per_org"; scopeId: string | null },
  ): Promise<{ total: number; cap: number }> {
    const { today, scope, scopeId } = args;
    let row: DailyRow | undefined;
    if (scope === "global") {
      // tenant:exempt reason=scope-discriminated-cost-daily follow_up=PERMANENT-EXEMPTION-cost-daily-scope
      const r = await sql<DailyRow>`
        SELECT daily_total_cents, cap_cents FROM telemetry.cost_daily
         WHERE today = ${today} AND scope = 'global'
      `.execute(trx);
      row = r.rows[0];
    } else {
      // tenant:exempt reason=scope-discriminated-cost-daily follow_up=PERMANENT-EXEMPTION-cost-daily-scope
      const r = await sql<DailyRow>`
        SELECT daily_total_cents, cap_cents FROM telemetry.cost_daily
         WHERE today = ${today} AND scope = 'per_org' AND scope_id = ${scopeId}::uuid
      `.execute(trx);
      row = r.rows[0];
    }
    if (row === undefined) {
      throw new Error(`${scope} cost_daily row missing after idempotent insert`);
    }
    return { total: Number(row.daily_total_cents), cap: Number(row.cap_cents) };
  }

  /**
   * Sprint 15 / S15.H — resolve the live cap from `core.cost_cap_overrides` +
   * `core.cost_cap_settings`. Returns the constructor-arg fallback when the new tables are absent or
   * empty (first-boot before the bootstrap seed).
   *
   * Lookup order for `per_org`:
   *   1. core.cost_cap_overrides for the installation (if not expired) — the per-tenant override
   *   2. core.cost_cap_settings row scope='per_org_default'
   *   3. fallback (env-var seed)
   * For `global`:
   *   1. core.cost_cap_settings row scope='global'
   *   2. fallback
   *
   * Errors are SWALLOWED and the helper returns the fallback — this path runs inside the
   * cost-reservation transaction; a transient cost_cap_settings read failure must NOT take down
   * Bedrock invocations across the cluster (fail-open). The observability path owns the
   * "cost_cap_settings unreachable" alert; the enforcer just falls back.
   */
  private async resolveEffectiveCap(
    trx: Trx,
    args: { scope: "global" | "per_org"; scopeId: string | null; fallback: number },
  ): Promise<number> {
    const { scope, scopeId, fallback } = args;
    if (!this.readCapsFromDb) {
      return fallback;
    }
    try {
      if (scope === "per_org" && scopeId !== null) {
        // tenant:exempt reason=installation-pk-is-the-scope follow_up=PERMANENT-EXEMPTION-cost-cap-overrides-pk
        const ovr = await sql<CapRow>`
          SELECT cap_cents FROM core.cost_cap_overrides
           WHERE installation_id = ${scopeId}::uuid
             AND (expires_at IS NULL OR expires_at > ${this.clock.now()})
        `.execute(trx);
        const ovrRow = ovr.rows[0];
        if (ovrRow !== undefined) {
          return Number(ovrRow.cap_cents);
        }
        // tenant:exempt reason=platform-global-cost-cap-settings follow_up=PERMANENT-EXEMPTION-cost-cap-settings
        const stg = await sql<CapRow>`
          SELECT cap_cents FROM core.cost_cap_settings WHERE scope = 'per_org_default'
        `.execute(trx);
        const stgRow = stg.rows[0];
        if (stgRow !== undefined) {
          return Number(stgRow.cap_cents);
        }
        return fallback;
      }
      // Global scope.
      // tenant:exempt reason=platform-global-cost-cap-settings follow_up=PERMANENT-EXEMPTION-cost-cap-settings
      const stg = await sql<CapRow>`
        SELECT cap_cents FROM core.cost_cap_settings WHERE scope = 'global'
      `.execute(trx);
      const stgRow = stg.rows[0];
      if (stgRow !== undefined) {
        return Number(stgRow.cap_cents);
      }
      return fallback;
    } catch {
      // Fail-open: any failure falls back to the env-var seed. A transient cost_cap_settings read
      // failure must NOT take down Bedrock invocations cluster-wide.
      return fallback;
    }
  }

  /**
   * Refresh the row's `cap_cents` to the live configured value (S14.5.G). The WHERE clause includes
   * `AND cap_cents != ${configuredCap}` so no WAL is written when the value already matches —
   * concurrent worker pods can call this on every check without observable cost.
   */
  private async refreshCapCents(
    trx: Trx,
    args: {
      today: string;
      scope: "global" | "per_org";
      scopeId: string | null;
      configuredCap: number;
    },
  ): Promise<void> {
    const { today, scope, scopeId, configuredCap } = args;
    if (scope === "global") {
      // tenant:exempt reason=scope-discriminated-cost-daily follow_up=PERMANENT-EXEMPTION-cost-daily-scope
      await sql`
        UPDATE telemetry.cost_daily
           SET cap_cents = ${configuredCap}, updated_at = ${this.clock.now()}
         WHERE today = ${today} AND scope = 'global' AND cap_cents != ${configuredCap}
      `.execute(trx);
    } else {
      // tenant:exempt reason=scope-discriminated-cost-daily follow_up=PERMANENT-EXEMPTION-cost-daily-scope
      await sql`
        UPDATE telemetry.cost_daily
           SET cap_cents = ${configuredCap}, updated_at = ${this.clock.now()}
         WHERE today = ${today} AND scope = 'per_org' AND scope_id = ${scopeId}::uuid
           AND cap_cents != ${configuredCap}
      `.execute(trx);
    }
  }
}
