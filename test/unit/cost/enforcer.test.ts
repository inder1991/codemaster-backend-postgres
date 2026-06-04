import { describe, expect, it } from "vitest";

import { CostCapDecisionV1 } from "#contracts/cost_cap_decision.v1.js";

import {
  BedrockBudgetExceededError,
  DEFAULT_GLOBAL_CAP_CENTS,
  DEFAULT_PER_ORG_CAP_CENTS,
  InMemoryCostCapEnforcer,
  todayUtc,
} from "#backend/cost/enforcer.js";

import { FakeClock } from "#platform/clock.js";

// A fixed UTC date string used across the unit tests (the in-memory enforcer keys spend by it).
const TODAY = "2026-06-04";
const INSTALL_A = "11111111-1111-1111-1111-111111111111";
const INSTALL_B = "22222222-2222-2222-2222-222222222222";

describe("CostCapDecisionV1 contract", () => {
  it("accepts a valid decision and defaults schema_version/refused_* fields", () => {
    const d = CostCapDecisionV1.parse({
      allowed: true,
      cents_spent_today_global: 10,
      cents_spent_today_org: 5,
      cents_estimated: 3,
    });
    expect(d.schema_version).toBe(1);
    expect(d.refused_reason).toBeNull();
    expect(d.refused_scope).toBeNull();
  });

  it("rejects negative cents", () => {
    expect(() =>
      CostCapDecisionV1.parse({
        allowed: true,
        cents_spent_today_global: -1,
        cents_spent_today_org: 0,
        cents_estimated: 0,
      }),
    ).toThrow();
  });

  it("rejects fractional cents (int-cents invariant)", () => {
    expect(() =>
      CostCapDecisionV1.parse({
        allowed: true,
        cents_spent_today_global: 1.5,
        cents_spent_today_org: 0,
        cents_estimated: 0,
      }),
    ).toThrow();
  });

  it("rejects an unexpected schema_version (fixed v1 decision shape)", () => {
    expect(() =>
      CostCapDecisionV1.parse({
        schema_version: 2,
        allowed: true,
        cents_spent_today_global: 0,
        cents_spent_today_org: 0,
        cents_estimated: 0,
      }),
    ).toThrow();
  });
});

describe("InMemoryCostCapEnforcer", () => {
  it("uses the frozen-Python default caps", () => {
    const e = new InMemoryCostCapEnforcer();
    expect(e.globalCapCents).toBe(DEFAULT_GLOBAL_CAP_CENTS);
    expect(e.perOrgCapCents).toBe(DEFAULT_PER_ORG_CAP_CENTS);
    expect(DEFAULT_GLOBAL_CAP_CENTS).toBe(500_000);
    expect(DEFAULT_PER_ORG_CAP_CENTS).toBe(100_000);
  });

  it("allows a call under both caps and reports current spend", async () => {
    const e = new InMemoryCostCapEnforcer({ globalCapCents: 1000, perOrgCapCents: 500 });
    const d = await e.checkOrRaise({
      installationId: INSTALL_A,
      estimatedCents: 100,
      today: TODAY,
    });
    expect(d.allowed).toBe(true);
    expect(d.cents_spent_today_global).toBe(0);
    expect(d.cents_spent_today_org).toBe(0);
    expect(d.cents_estimated).toBe(100);
  });

  it("raises BedrockBudgetExceededError when the global cap would be exceeded", async () => {
    const e = new InMemoryCostCapEnforcer({ globalCapCents: 100, perOrgCapCents: 100_000 });
    await e.recordCallCost({ installationId: INSTALL_A, costCents: 60, today: TODAY });
    await expect(
      e.checkOrRaise({ installationId: INSTALL_A, estimatedCents: 50, today: TODAY }),
    ).rejects.toMatchObject({ scope: "global" });
    await expect(
      e.checkOrRaise({ installationId: INSTALL_A, estimatedCents: 50, today: TODAY }),
    ).rejects.toBeInstanceOf(BedrockBudgetExceededError);
  });

  it("raises BedrockBudgetExceededError with scope_id when the per-org cap would be exceeded", async () => {
    const e = new InMemoryCostCapEnforcer({ globalCapCents: 1_000_000, perOrgCapCents: 100 });
    await e.recordCallCost({ installationId: INSTALL_A, costCents: 60, today: TODAY });
    try {
      await e.checkOrRaise({ installationId: INSTALL_A, estimatedCents: 50, today: TODAY });
      throw new Error("expected BedrockBudgetExceededError");
    } catch (err) {
      expect(err).toBeInstanceOf(BedrockBudgetExceededError);
      const e2 = err as BedrockBudgetExceededError;
      expect(e2.scope).toBe("per_org");
      expect(e2.scopeId).toBe(INSTALL_A);
    }
  });

  it("treats the cap as inclusive (== cap is allowed, cap+1 is refused)", async () => {
    const e = new InMemoryCostCapEnforcer({ globalCapCents: 100, perOrgCapCents: 100_000 });
    // spent 40 + estimated 60 == cap 100 → allowed (strict `>` comparison)
    const ok = await e.checkOrRaise({ installationId: INSTALL_A, estimatedCents: 100, today: TODAY });
    expect(ok.allowed).toBe(true);
    await e.recordCallCost({ installationId: INSTALL_A, costCents: 100, today: TODAY });
    // now any positive estimate exceeds
    await expect(
      e.checkOrRaise({ installationId: INSTALL_A, estimatedCents: 1, today: TODAY }),
    ).rejects.toBeInstanceOf(BedrockBudgetExceededError);
  });

  it("accumulates integer cents across recordCallCost calls with no fractional drift", async () => {
    const e = new InMemoryCostCapEnforcer({ globalCapCents: 1_000_000, perOrgCapCents: 1_000_000 });
    const amounts = [1, 2, 3, 7, 11, 13, 17, 19, 23, 100];
    for (const c of amounts) {
      await e.recordCallCost({ installationId: INSTALL_A, costCents: c, today: TODAY });
    }
    const expected = amounts.reduce((a, b) => a + b, 0);
    expect(e.getGlobalSpend(TODAY)).toBe(expected);
    expect(e.getOrgSpend({ installationId: INSTALL_A, today: TODAY })).toBe(expected);
    // Integer invariant: the accumulated value is an exact integer, no fractional cents.
    expect(Number.isInteger(e.getGlobalSpend(TODAY))).toBe(true);
    expect(e.getGlobalSpend(TODAY) % 1).toBe(0);
  });

  it("estimatedCents is ignored by recordCallCost (non-reserving) — full cost applied", async () => {
    const e = new InMemoryCostCapEnforcer({ globalCapCents: 1_000_000, perOrgCapCents: 1_000_000 });
    await e.recordCallCost({
      installationId: INSTALL_A,
      costCents: 75,
      estimatedCents: 200,
      today: TODAY,
    });
    // Full 75 applied, NOT a 75-200 diff.
    expect(e.getGlobalSpend(TODAY)).toBe(75);
  });

  it("keeps per-org spend isolated between installations", async () => {
    const e = new InMemoryCostCapEnforcer({ globalCapCents: 1_000_000, perOrgCapCents: 1_000_000 });
    await e.recordCallCost({ installationId: INSTALL_A, costCents: 40, today: TODAY });
    await e.recordCallCost({ installationId: INSTALL_B, costCents: 25, today: TODAY });
    expect(e.getOrgSpend({ installationId: INSTALL_A, today: TODAY })).toBe(40);
    expect(e.getOrgSpend({ installationId: INSTALL_B, today: TODAY })).toBe(25);
    // Global is the sum of both orgs.
    expect(e.getGlobalSpend(TODAY)).toBe(65);
  });

  it("honours a per-org cap override", async () => {
    const e = new InMemoryCostCapEnforcer({ globalCapCents: 1_000_000, perOrgCapCents: 100_000 });
    e.setPerOrgCap({ installationId: INSTALL_A, cents: 50 });
    await expect(
      e.checkOrRaise({ installationId: INSTALL_A, estimatedCents: 51, today: TODAY }),
    ).rejects.toMatchObject({ scope: "per_org", scopeId: INSTALL_A });
    // INSTALL_B keeps the default cap.
    const ok = await e.checkOrRaise({ installationId: INSTALL_B, estimatedCents: 51, today: TODAY });
    expect(ok.allowed).toBe(true);
  });

  it("refuses immediately when the kill switch is set", async () => {
    const e = new InMemoryCostCapEnforcer({ globalCapCents: 1_000_000, perOrgCapCents: 1_000_000 });
    e.setKillSwitch(true);
    await expect(
      e.checkOrRaise({ installationId: INSTALL_A, estimatedCents: 1, today: TODAY }),
    ).rejects.toMatchObject({ scope: "kill_switch" });
  });

  it("rejects negative estimated/cost inputs", async () => {
    const e = new InMemoryCostCapEnforcer();
    await expect(
      e.checkOrRaise({ installationId: INSTALL_A, estimatedCents: -1, today: TODAY }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      e.recordCallCost({ installationId: INSTALL_A, costCents: -1, today: TODAY }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("partitions spend by day (rollover)", async () => {
    const e = new InMemoryCostCapEnforcer({ globalCapCents: 1_000_000, perOrgCapCents: 1_000_000 });
    await e.recordCallCost({ installationId: INSTALL_A, costCents: 40, today: "2026-06-04" });
    await e.recordCallCost({ installationId: INSTALL_A, costCents: 10, today: "2026-06-05" });
    expect(e.getGlobalSpend("2026-06-04")).toBe(40);
    expect(e.getGlobalSpend("2026-06-05")).toBe(10);
  });
});

describe("todayUtc", () => {
  it("derives the UTC date string from the clock (mirrors clock.now().date())", () => {
    const clock = new FakeClock({ now: new Date("2026-06-04T23:30:00.000Z") });
    expect(todayUtc(clock)).toBe("2026-06-04");
  });
});
