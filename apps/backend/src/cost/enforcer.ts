/**
 * Cost-cap enforcer shared surface — 1:1 TypeScript port of `codemaster/cost/enforcer.py`:
 * the error types, the `CostCapEnforcer` interface, the `CostCapDecision`, the default caps, the
 * `InMemoryCostCapEnforcer` (unit-test double), and the `todayUtc` clock→date helper.
 *
 * The REAL production enforcer — `PostgresCostCapEnforcer` (the atomic, optimistic-reservation
 * `SELECT ... FOR UPDATE` enforcer over `telemetry.cost_daily`, 1:1 with the Python
 * `codemaster/cost/postgres_enforcer.py`) — lives in the sibling `./postgres_enforcer.ts`, matching
 * the Python file split. It implements the `CostCapEnforcer` interface exported here; the production
 * `LlmClientCache` injects it. ALL cost arithmetic is INTEGER cents — no float, no division.
 *
 * Workers call `enforcer.checkOrRaise({ installationId, estimatedCents, today })` before every
 * Bedrock call; `recordCallCost()` applies the post-call accounting afterward.
 */

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

/**
 * Derive the UTC date string (`YYYY-MM-DD`) that callers pass as `today`.
 *
 * Mirrors the Python caller idiom `self._clock.now().date()` — the UTC calendar date of the clock's
 * `now()`. `Clock.now()` returns an absolute UTC instant, so the ISO date prefix is the UTC date.
 */
export function todayUtc(clock: Clock): string {
  return clock.now().toISOString().slice(0, 10);
}
