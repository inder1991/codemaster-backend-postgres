/**
 * Cost-cap enforcer — 1:1 TypeScript port of the frozen Python spine cost gate.
 *
 * Sources ported verbatim:
 *   - codemaster/cost/enforcer.py          (errors, CostCapDecision, InMemoryCostCapEnforcer)
 *   - codemaster/cost/postgres_enforcer.py (PostgresCostCapEnforcer — Sprint 14 / S14.D)
 *
 * Workers call `enforcer.checkOrRaise({ installationId, estimatedCents, today })` before every
 * Bedrock call. The enforcer:
 *   1. (in-memory only) checks a kill switch — if set, refuses immediately.
 *   2. checks today's accumulated global spend + estimated cost vs the global cap.
 *   3. checks today's accumulated per-org spend + estimated cost vs the per-org cap.
 *   4. otherwise allows the call.
 * After the call completes, `recordCallCost()` applies the post-call accounting.
 *
 * The `PostgresCostCapEnforcer` is the production, atomic, optimistic-reservation enforcer: it takes
 * a `SELECT ... FOR UPDATE` row lock (under `SET LOCAL lock_timeout = '2s'`) on the dedicated
 * `telemetry.cost_daily` row so concurrent worker pods cannot collectively exceed the daily cap
 * (audit B1.1 / B2.6). ALL arithmetic is INTEGER cents — no float, no division.
 *
 * Per ADR-0062 the `pg.Pool` is passed in (memoized by the caller), NEVER created per call.
 */

import type { Pool, PoolClient } from "pg";

import type { Clock } from "#platform/clock.js";

import { CostCapDecisionV1 } from "#contracts/cost_cap_decision.v1.js";

// ─── Errors (1:1 with enforcer.py) ──────────────────────────────────────────

/**
 * Raised when a cap would be exceeded.
 *
 * The workflow catches this and surfaces as a `cost_cap_exceeded` finding in the walkthrough
 * degradation note. Audit-logged. Mirrors `BedrockBudgetExceededError(*, reason, scope, scope_id)`.
 */
export class BedrockBudgetExceededError extends Error {
  public readonly reason: string;
  public readonly scope: string;
  public readonly scopeId: string | null;

  public constructor({
    reason,
    scope,
    scopeId = null,
  }: {
    reason: string;
    scope: string;
    scopeId?: string | null;
  }) {
    super(reason);
    this.name = "BedrockBudgetExceededError";
    this.reason = reason;
    this.scope = scope;
    this.scopeId = scopeId;
  }
}

/**
 * Raised when the Postgres row lock for the daily-cost row times out (Postgres SQLSTATE 55P03 /
 * `lock_timeout = '2s'`).
 *
 * The Bedrock client catches this and retries `checkOrRaise` once; if the retry also times out, the
 * call fails closed via `BedrockBudgetExceededError` per the S14.D failure-mode spec.
 */
export class CostCapLockTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CostCapLockTimeoutError";
  }
}

// ─── Contract re-export (the decision is the public return shape) ────────────

export { CostCapDecisionV1 };
export type CostCapDecision = CostCapDecisionV1;

/** The narrow interface the worker uses (the Sprint-0 `CostCapEnforcer` Protocol). */
export type CostCapEnforcer = {
  checkOrRaise(args: {
    installationId: string;
    estimatedCents: number;
    today: string;
  }): Promise<CostCapDecision>;
  recordCallCost(args: {
    installationId: string;
    costCents: number;
    today: string;
    estimatedCents?: number;
  }): Promise<void>;
};

// ─── Shared constants (postgres_enforcer.py) ────────────────────────────────

/** $5,000/day — `DEFAULT_GLOBAL_CAP_CENTS`. */
export const DEFAULT_GLOBAL_CAP_CENTS = 500_000;
/** $1,000/day — `DEFAULT_PER_ORG_CAP_CENTS`. */
export const DEFAULT_PER_ORG_CAP_CENTS = 100_000;

/** The zero-UUID sentinel the global-scope row carries (migration 0024 default + CHECK contract). */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * SET LOCAL lock_timeout — Postgres returns SQLSTATE 55P03 when the row lock cannot be acquired
 * within this window. We translate that to {@link CostCapLockTimeoutError} so the Bedrock client can
 * apply the retry-once-then-fail-closed policy from the S14.D failure-mode spec.
 */
const PG_LOCK_TIMEOUT_SQLSTATE = "55P03";
const LOCK_TIMEOUT = "2s";

/** Narrow the unknown thrown value to a node-postgres error carrying a SQLSTATE `.code`. */
function pgSqlstate(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

// ─── In-memory enforcer (1:1 with enforcer.py::InMemoryCostCapEnforcer) ─────

/**
 * In-memory enforcer for unit tests and local dev.
 *
 * Holds today's accumulated spend in maps. Tests can pass `today` to simulate day-rollover;
 * production wraps a real `Clock`-derived date string. Non-reserving: `checkOrRaise` only reads, so
 * `recordCallCost` applies the actual cost in full and ignores `estimatedCents`.
 */
export class InMemoryCostCapEnforcer implements CostCapEnforcer {
  public globalCapCents: number;
  public perOrgCapCents: number;
  public killSwitch: boolean;

  // (today) -> cents
  private readonly globalSpend = new Map<string, number>();
  // (`${today}\0${installationId}`) -> cents
  private readonly orgSpend = new Map<string, number>();
  // installation_id -> cap override
  private readonly perOrgOverrides = new Map<string, number>();

  public constructor({
    globalCapCents = DEFAULT_GLOBAL_CAP_CENTS,
    perOrgCapCents = DEFAULT_PER_ORG_CAP_CENTS,
    killSwitch = false,
  }: { globalCapCents?: number; perOrgCapCents?: number; killSwitch?: boolean } = {}) {
    this.globalCapCents = globalCapCents;
    this.perOrgCapCents = perOrgCapCents;
    this.killSwitch = killSwitch;
  }

  // --- test/admin API ---

  public setKillSwitch(value: boolean): void {
    this.killSwitch = value;
  }

  public setPerOrgCap({ installationId, cents }: { installationId: string; cents: number }): void {
    this.perOrgOverrides.set(installationId, cents);
  }

  public getGlobalSpend(today: string): number {
    return this.globalSpend.get(today) ?? 0;
  }

  public getOrgSpend({ installationId, today }: { installationId: string; today: string }): number {
    return this.orgSpend.get(orgKey(today, installationId)) ?? 0;
  }

  private capForOrg(installationId: string): number {
    return this.perOrgOverrides.get(installationId) ?? this.perOrgCapCents;
  }

  // --- CostCapEnforcer impl ---

  public async checkOrRaise({
    installationId,
    estimatedCents,
    today,
  }: {
    installationId: string;
    estimatedCents: number;
    today: string;
  }): Promise<CostCapDecision> {
    if (estimatedCents < 0) {
      throw new RangeError("estimatedCents must be >= 0");
    }

    const globalSpent = this.globalSpend.get(today) ?? 0;
    const orgSpent = this.orgSpend.get(orgKey(today, installationId)) ?? 0;

    if (this.killSwitch) {
      throw new BedrockBudgetExceededError({
        reason: "bedrock_global_kill_switch is set",
        scope: "kill_switch",
      });
    }

    if (globalSpent + estimatedCents > this.globalCapCents) {
      throw new BedrockBudgetExceededError({
        reason:
          `global spend ${globalSpent} + estimated ${estimatedCents} ` +
          `would exceed cap ${this.globalCapCents} cents/day`,
        scope: "global",
      });
    }

    const orgCap = this.capForOrg(installationId);
    if (orgSpent + estimatedCents > orgCap) {
      throw new BedrockBudgetExceededError({
        reason:
          `org ${installationId} spend ${orgSpent} + estimated ` +
          `${estimatedCents} would exceed per-org cap ${orgCap} cents/day`,
        scope: "per_org",
        scopeId: installationId,
      });
    }

    return CostCapDecisionV1.parse({
      allowed: true,
      cents_spent_today_global: globalSpent,
      cents_spent_today_org: orgSpent,
      cents_estimated: estimatedCents,
    });
  }

  public async recordCallCost({
    installationId,
    costCents,
    today,
  }: {
    installationId: string;
    costCents: number;
    today: string;
    estimatedCents?: number;
  }): Promise<void> {
    if (costCents < 0) {
      throw new RangeError("costCents must be >= 0");
    }
    // Non-reserving — checkOrRaise only reads, so apply the actual cost in full. estimatedCents is
    // part of the protocol for parity with PostgresCostCapEnforcer; ignored here.
    this.globalSpend.set(today, (this.globalSpend.get(today) ?? 0) + costCents);
    const key = orgKey(today, installationId);
    this.orgSpend.set(key, (this.orgSpend.get(key) ?? 0) + costCents);
  }
}

/** Compose the (today, installationId) org-spend map key. `\0` cannot appear in either part. */
function orgKey(today: string, installationId: string): string {
  return `${today}\0${installationId}`;
}

// ─── Postgres enforcer (1:1 with postgres_enforcer.py::PostgresCostCapEnforcer) ──

/**
 * Atomic, optimistic-reservation cost-cap enforcer.
 *
 * `checkOrRaise` opens a transaction, sets `lock_timeout`, ensures the global + per-org rows exist
 * (idempotent INSERT ON CONFLICT DO NOTHING), takes a row lock via `SELECT ... FOR UPDATE` on both,
 * validates that `daily_total + estimatedCents` fits inside each cap, and then atomically reserves
 * the spend with an UPDATE that adds `estimatedCents` to both rows. Commit releases the row lock.
 *
 * `recordCallCost` applies the `actual - estimated` diff to both rows under the same row lock so the
 * daily total tracks reality. Refunds (actual < estimated) are negative diffs.
 *
 * Caps are stored on the row (not just on the instance) so an admin override is visible to all
 * worker pods immediately, without a redeploy. When `readCapsFromDb` is true (the production path
 * post-S15.H), every check consults `core.cost_cap_overrides` + `core.cost_cap_settings` for the
 * live cap values BEFORE writing them onto the daily row; the constructor caps are the env-var-seeded
 * fallback used only when those tables are empty (first-boot before the bootstrap seed).
 *
 * Per ADR-0062 the `pg.Pool` is injected (memoized by the caller), NEVER created per call.
 */
export class PostgresCostCapEnforcer implements CostCapEnforcer {
  private readonly pool: Pool;
  private readonly clock: Clock;
  public readonly globalCapCents: number;
  public readonly perOrgCapCents: number;
  private readonly readCapsFromDb: boolean;

  public constructor({
    pool,
    clock,
    globalCapCents = DEFAULT_GLOBAL_CAP_CENTS,
    perOrgCapCents = DEFAULT_PER_ORG_CAP_CENTS,
    readCapsFromDb = false,
  }: {
    pool: Pool;
    clock: Clock;
    globalCapCents?: number;
    perOrgCapCents?: number;
    readCapsFromDb?: boolean;
  }) {
    this.pool = pool;
    this.clock = clock;
    this.globalCapCents = globalCapCents;
    this.perOrgCapCents = perOrgCapCents;
    this.readCapsFromDb = readCapsFromDb;
  }

  public async checkOrRaise({
    installationId,
    estimatedCents,
    today,
  }: {
    installationId: string;
    estimatedCents: number;
    today: string;
  }): Promise<CostCapDecision> {
    if (estimatedCents < 0) {
      throw new RangeError("estimatedCents must be >= 0");
    }
    const isPlatformScope = installationId === ZERO_UUID;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);

      // Idempotent global-scope row creation. The zero-UUID sentinel is inserted LITERALLY (the
      // column DEFAULT only fires when the column is OMITTED; an explicit NULL would violate the
      // cost_daily_global_has_zero_scope_id CHECK). Smoke-driven bug fix 2026-05-11.
      await client.query(
        `INSERT INTO telemetry.cost_daily
           (today, scope, scope_id, daily_total_cents, cap_cents)
         VALUES ($1, 'global', '${ZERO_UUID}'::uuid, 0, $2)
         ON CONFLICT DO NOTHING`,
        [today, this.globalCapCents],
      );
      // Skip the per_org INSERT for platform-scope calls (zero-UUID sentinel) — the CHECK requires
      // scope='per_org' ⇒ scope_id <> ZERO. Global-scope tracking covers the platform-scope spend.
      if (!isPlatformScope) {
        await client.query(
          `INSERT INTO telemetry.cost_daily
             (today, scope, scope_id, daily_total_cents, cap_cents)
           VALUES ($1, 'per_org', $2, 0, $3)
           ON CONFLICT DO NOTHING`,
          [today, installationId, this.perOrgCapCents],
        );
      }

      // Refresh cap_cents so admin overrides take effect within seconds (S14.5.G); the DB resolution
      // (S15.H) picks the live cap when readCapsFromDb is true, env-var seed as first-boot fallback.
      const effectiveGlobalCap = await this.resolveEffectiveCap(client, {
        scope: "global",
        scopeId: null,
        fallback: this.globalCapCents,
      });
      const effectiveOrgCap = await this.resolveEffectiveCap(client, {
        scope: "per_org",
        scopeId: installationId,
        fallback: this.perOrgCapCents,
      });
      await this.refreshCapCents(client, {
        today,
        scope: "global",
        scopeId: null,
        configuredCap: effectiveGlobalCap,
      });
      await this.refreshCapCents(client, {
        today,
        scope: "per_org",
        scopeId: installationId,
        configuredCap: effectiveOrgCap,
      });

      // SELECT FOR UPDATE on the global row. The lock blocks any concurrent reservation against the
      // same (today, 'global') until commit.
      const grow = await client.query<{ daily_total_cents: string; cap_cents: string }>(
        `SELECT daily_total_cents, cap_cents
           FROM telemetry.cost_daily
          WHERE today = $1 AND scope = 'global'
          FOR UPDATE`,
        [today],
      );
      const gRow = grow.rows[0];
      if (gRow === undefined) {
        throw new Error("global cost_daily row missing after idempotent insert");
      }
      const globalTotal = Number(gRow.daily_total_cents);
      const globalCap = Number(gRow.cap_cents);

      // per_org SELECT FOR UPDATE skipped for platform-scope calls (symmetric with the INSERT gate).
      let orgTotal = 0;
      let orgCap = 0;
      if (!isPlatformScope) {
        const orow = await client.query<{ daily_total_cents: string; cap_cents: string }>(
          `SELECT daily_total_cents, cap_cents
             FROM telemetry.cost_daily
            WHERE today = $1 AND scope = 'per_org' AND scope_id = $2
            FOR UPDATE`,
          [today, installationId],
        );
        const oRow = orow.rows[0];
        if (oRow === undefined) {
          throw new Error("per_org cost_daily row missing after idempotent insert");
        }
        orgTotal = Number(oRow.daily_total_cents);
        orgCap = Number(oRow.cap_cents);
      }

      // Budget checks. Throwing here rolls back the tx, which releases the row lock — no reservation
      // leaks for refused calls.
      if (globalTotal + estimatedCents > globalCap) {
        throw new BedrockBudgetExceededError({
          reason:
            `global spend ${globalTotal} + estimated ${estimatedCents} ` +
            `would exceed cap ${globalCap} cents/day`,
          scope: "global",
        });
      }
      if (!isPlatformScope && orgTotal + estimatedCents > orgCap) {
        throw new BedrockBudgetExceededError({
          reason:
            `org ${installationId} spend ${orgTotal} + estimated ` +
            `${estimatedCents} would exceed per-org cap ${orgCap} cents/day`,
          scope: "per_org",
          scopeId: installationId,
        });
      }

      // Reserve under the same row lock.
      await client.query(
        `UPDATE telemetry.cost_daily
            SET daily_total_cents = daily_total_cents + $1, updated_at = $2
          WHERE today = $3 AND scope = 'global'`,
        [estimatedCents, this.clock.now(), today],
      );
      if (!isPlatformScope) {
        await client.query(
          `UPDATE telemetry.cost_daily
              SET daily_total_cents = daily_total_cents + $1, updated_at = $2
            WHERE today = $3 AND scope = 'per_org' AND scope_id = $4`,
          [estimatedCents, this.clock.now(), today, installationId],
        );
      }

      await client.query("COMMIT");

      return CostCapDecisionV1.parse({
        allowed: true,
        cents_spent_today_global: globalTotal,
        cents_spent_today_org: orgTotal,
        cents_estimated: estimatedCents,
      });
    } catch (err) {
      await safeRollback(client);
      if (pgSqlstate(err) === PG_LOCK_TIMEOUT_SQLSTATE) {
        throw new CostCapLockTimeoutError(
          `cost_daily row lock timed out after ${LOCK_TIMEOUT} ` +
            `(SQLSTATE ${PG_LOCK_TIMEOUT_SQLSTATE}); BedrockClient will retry once`,
        );
      }
      throw err;
    } finally {
      client.release();
    }
  }

  public async recordCallCost({
    installationId,
    costCents,
    today,
    estimatedCents = 0,
  }: {
    installationId: string;
    costCents: number;
    today: string;
    estimatedCents?: number;
  }): Promise<void> {
    if (costCents < 0) {
      throw new RangeError("costCents must be >= 0");
    }
    const diff = costCents - estimatedCents;
    if (diff === 0) {
      return;
    }
    const isPlatformScope = installationId === ZERO_UUID;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);

      // Defensive cap refresh on both rows (S14.5.G) so a cap edit between the reservation and the
      // post-call accounting still lands the new value on the row.
      const effectiveGlobalCap = await this.resolveEffectiveCap(client, {
        scope: "global",
        scopeId: null,
        fallback: this.globalCapCents,
      });
      const effectiveOrgCap = await this.resolveEffectiveCap(client, {
        scope: "per_org",
        scopeId: installationId,
        fallback: this.perOrgCapCents,
      });
      await this.refreshCapCents(client, {
        today,
        scope: "global",
        scopeId: null,
        configuredCap: effectiveGlobalCap,
      });
      await this.refreshCapCents(client, {
        today,
        scope: "per_org",
        scopeId: installationId,
        configuredCap: effectiveOrgCap,
      });

      // SELECT FOR UPDATE on both rows so the diff is applied under the same lock as the original
      // reservation — no torn read between this UPDATE and a concurrent checkOrRaise.
      await client.query(
        `SELECT daily_total_cents FROM telemetry.cost_daily
          WHERE today = $1 AND scope = 'global' FOR UPDATE`,
        [today],
      );
      if (!isPlatformScope) {
        await client.query(
          `SELECT daily_total_cents FROM telemetry.cost_daily
            WHERE today = $1 AND scope = 'per_org' AND scope_id = $2 FOR UPDATE`,
          [today, installationId],
        );
      }
      await client.query(
        `UPDATE telemetry.cost_daily
            SET daily_total_cents = daily_total_cents + $1, updated_at = $2
          WHERE today = $3 AND scope = 'global'`,
        [diff, this.clock.now(), today],
      );
      if (!isPlatformScope) {
        await client.query(
          `UPDATE telemetry.cost_daily
              SET daily_total_cents = daily_total_cents + $1, updated_at = $2
            WHERE today = $3 AND scope = 'per_org' AND scope_id = $4`,
          [diff, this.clock.now(), today, installationId],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await safeRollback(client);
      if (pgSqlstate(err) === PG_LOCK_TIMEOUT_SQLSTATE) {
        throw new CostCapLockTimeoutError(
          `cost_daily row lock timed out during recordCallCost ` +
            `(SQLSTATE ${PG_LOCK_TIMEOUT_SQLSTATE})`,
        );
      }
      throw err;
    } finally {
      client.release();
    }
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
   * Bedrock invocations across the cluster (fail-open).
   */
  private async resolveEffectiveCap(
    client: PoolClient,
    {
      scope,
      scopeId,
      fallback,
    }: { scope: "global" | "per_org"; scopeId: string | null; fallback: number },
  ): Promise<number> {
    if (!this.readCapsFromDb) {
      return fallback;
    }
    try {
      if (scope === "per_org" && scopeId !== null) {
        const ovr = await client.query<{ cap_cents: string }>(
          `SELECT cap_cents FROM core.cost_cap_overrides
            WHERE installation_id = $1
              AND (expires_at IS NULL OR expires_at > $2)`,
          [scopeId, this.clock.now()],
        );
        const ovrRow = ovr.rows[0];
        if (ovrRow !== undefined) {
          return Number(ovrRow.cap_cents);
        }
        const stg = await client.query<{ cap_cents: string }>(
          `SELECT cap_cents FROM core.cost_cap_settings WHERE scope = 'per_org_default'`,
        );
        const stgRow = stg.rows[0];
        if (stgRow !== undefined) {
          return Number(stgRow.cap_cents);
        }
        return fallback;
      }
      const stg = await client.query<{ cap_cents: string }>(
        `SELECT cap_cents FROM core.cost_cap_settings WHERE scope = 'global'`,
      );
      const stgRow = stg.rows[0];
      if (stgRow !== undefined) {
        return Number(stgRow.cap_cents);
      }
      return fallback;
    } catch {
      // Fail-open: any failure falls back to the env-var seed. A transient cost_cap_settings read
      // failure must NOT take down Bedrock invocations cluster-wide. (The observability path owns the
      // "cost_cap_settings unreachable" alert; the enforcer just falls back.)
      return fallback;
    }
  }

  /**
   * Refresh the row's `cap_cents` to the live configured value (S14.5.G). The WHERE clause includes
   * `AND cap_cents != $configuredCap` so no WAL is written when the value already matches —
   * concurrent worker pods can call this on every check without observable cost.
   */
  private async refreshCapCents(
    client: PoolClient,
    {
      today,
      scope,
      scopeId,
      configuredCap,
    }: { today: string; scope: "global" | "per_org"; scopeId: string | null; configuredCap: number },
  ): Promise<void> {
    if (scope === "global") {
      await client.query(
        `UPDATE telemetry.cost_daily
            SET cap_cents = $1, updated_at = $2
          WHERE today = $3 AND scope = 'global' AND cap_cents != $1`,
        [configuredCap, this.clock.now(), today],
      );
    } else {
      await client.query(
        `UPDATE telemetry.cost_daily
            SET cap_cents = $1, updated_at = $2
          WHERE today = $3 AND scope = 'per_org' AND scope_id = $4 AND cap_cents != $1`,
        [configuredCap, this.clock.now(), today, scopeId],
      );
    }
  }
}

/** Roll back the current transaction, swallowing any rollback error so the original error surfaces. */
async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Ignore — the original error is what matters; a rollback failure here would mask it.
  }
}

/**
 * Derive the UTC date string (`YYYY-MM-DD`) that callers pass as `today`.
 *
 * Mirrors the Python caller idiom `self._clock.now().date()` — the UTC calendar date of the clock's
 * `now()`. `Clock.now()` returns an absolute UTC instant, so the ISO date prefix is the UTC date.
 */
export function todayUtc(clock: Clock): string {
  return clock.now().toISOString().slice(0, 10);
}
