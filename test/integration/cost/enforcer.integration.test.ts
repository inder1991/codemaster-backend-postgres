import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  BedrockBudgetExceededError,
  PostgresCostCapEnforcer,
} from "#backend/cost/enforcer.js";

import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// DB-gated integration test against a DISPOSABLE Postgres (migrations applied, telemetry.cost_daily +
// seeded config). Runs ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so
// validate-fast stays green without a DB. We NEVER touch any other DB.

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
// A fixed, far-future date string keeps every test's rows isolated from real wall-clock days; each
// test additionally uses a UNIQUE installation_id so per-org rows never collide. The global row IS
// shared per `today`, so each test that asserts on global spend uses its OWN unique `today`.
const FIXED_CLOCK = new FakeClock({ now: new Date("2099-01-01T00:00:00.000Z") });

let pool: Pool;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  // ADR-0062: ONE memoized pool for the whole file — never a pool per call.
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 8 });
});

afterAll(async () => {
  await pool?.end();
});

/** A unique YYYY-MM-DD-shaped date string so each test owns its own global + per-org rows. */
function uniqueToday(): string {
  // Map a random uint16 onto a synthetic far-future date: 2090-01-01 + N days, formatted as ISO date.
  const n = (parseInt(randomUUID().replace(/-/g, "").slice(0, 8), 16) % 3000) + 1;
  const base = Date.UTC(2090, 0, 1) + n * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

/** Delete every cost_daily row this test family created for a given `today`. */
async function cleanupToday(today: string): Promise<void> {
  await pool.query(`DELETE FROM telemetry.cost_daily WHERE today = $1`, [today]);
}

describeDb("PostgresCostCapEnforcer (integration, disposable PG)", () => {
  it("allows a call under both caps and reports zero prior spend", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const enforcer = new PostgresCostCapEnforcer({
      pool,
      clock: FIXED_CLOCK,
      globalCapCents: 10_000,
      perOrgCapCents: 5_000,
    });
    try {
      const d = await enforcer.checkOrRaise({ installationId, estimatedCents: 100, today });
      expect(d.allowed).toBe(true);
      expect(d.cents_spent_today_global).toBe(0);
      expect(d.cents_spent_today_org).toBe(0);
      expect(d.cents_estimated).toBe(100);

      // The reservation persisted both rows with the estimate applied.
      const rows = await pool.query<{ scope: string; daily_total_cents: string; cap_cents: string }>(
        `SELECT scope, daily_total_cents, cap_cents FROM telemetry.cost_daily WHERE today = $1`,
        [today],
      );
      const byScope = new Map(rows.rows.map((r) => [r.scope, r]));
      expect(Number(byScope.get("global")?.daily_total_cents)).toBe(100);
      expect(Number(byScope.get("per_org")?.daily_total_cents)).toBe(100);
      expect(Number(byScope.get("global")?.cap_cents)).toBe(10_000);
      expect(Number(byScope.get("per_org")?.cap_cents)).toBe(5_000);
    } finally {
      await cleanupToday(today);
    }
  });

  it("raises BedrockBudgetExceededError(scope=global) when the global cap would be exceeded", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const enforcer = new PostgresCostCapEnforcer({
      pool,
      clock: FIXED_CLOCK,
      globalCapCents: 100,
      perOrgCapCents: 1_000_000,
    });
    try {
      // Reserve 60 (under the global cap of 100).
      await enforcer.checkOrRaise({ installationId, estimatedCents: 60, today });
      // A further 50 would bring global to 110 > 100 → refused on the GLOBAL scope.
      try {
        await enforcer.checkOrRaise({ installationId, estimatedCents: 50, today });
        throw new Error("expected BedrockBudgetExceededError");
      } catch (err) {
        expect(err).toBeInstanceOf(BedrockBudgetExceededError);
        expect((err as BedrockBudgetExceededError).scope).toBe("global");
      }
      // Refused reservation did NOT leak — global total is still 60 (rolled back).
      const g = await pool.query<{ daily_total_cents: string }>(
        `SELECT daily_total_cents FROM telemetry.cost_daily WHERE today = $1 AND scope = 'global'`,
        [today],
      );
      expect(Number(g.rows[0]?.daily_total_cents)).toBe(60);
    } finally {
      await cleanupToday(today);
    }
  });

  it("raises BedrockBudgetExceededError(scope=per_org, scope_id) when the per-org cap would be exceeded", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const enforcer = new PostgresCostCapEnforcer({
      pool,
      clock: FIXED_CLOCK,
      globalCapCents: 1_000_000, // global is generous so per_org is the binding cap
      perOrgCapCents: 100,
    });
    try {
      await enforcer.checkOrRaise({ installationId, estimatedCents: 60, today });
      try {
        await enforcer.checkOrRaise({ installationId, estimatedCents: 50, today });
        throw new Error("expected BedrockBudgetExceededError");
      } catch (err) {
        expect(err).toBeInstanceOf(BedrockBudgetExceededError);
        const e = err as BedrockBudgetExceededError;
        expect(e.scope).toBe("per_org");
        expect(e.scopeId).toBe(installationId);
      }
    } finally {
      await cleanupToday(today);
    }
  });

  it("recordCallCost applies the (actual - estimated) diff; a subsequent checkOrRaise sees new spend", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const enforcer = new PostgresCostCapEnforcer({
      pool,
      clock: FIXED_CLOCK,
      globalCapCents: 10_000,
      perOrgCapCents: 5_000,
    });
    try {
      // Reserve 200.
      const first = await enforcer.checkOrRaise({ installationId, estimatedCents: 200, today });
      expect(first.cents_spent_today_global).toBe(0);
      // Actual came in at 350 → diff +150 added on top of the reserved 200 → total 350.
      await enforcer.recordCallCost({
        installationId,
        costCents: 350,
        estimatedCents: 200,
        today,
      });
      // Next check sees the accumulated 350 (integer cents).
      const second = await enforcer.checkOrRaise({ installationId, estimatedCents: 10, today });
      expect(second.cents_spent_today_global).toBe(350);
      expect(second.cents_spent_today_org).toBe(350);
      expect(Number.isInteger(second.cents_spent_today_global)).toBe(true);

      // A refund (actual < estimated) walks the total back down. Reserve 100, actual 40 → diff -60.
      await enforcer.recordCallCost({
        installationId,
        costCents: 40,
        estimatedCents: 100,
        today,
      });
      // Row total: 350 (prior) + 10 (second reservation) - 60 (refund) = 300.
      const g = await pool.query<{ daily_total_cents: string }>(
        `SELECT daily_total_cents FROM telemetry.cost_daily WHERE today = $1 AND scope = 'global'`,
        [today],
      );
      expect(Number(g.rows[0]?.daily_total_cents)).toBe(300);
    } finally {
      await cleanupToday(today);
    }
  });

  it("skips per_org accounting for the platform-scope zero-UUID sentinel", async () => {
    const today = uniqueToday();
    const enforcer = new PostgresCostCapEnforcer({
      pool,
      clock: FIXED_CLOCK,
      globalCapCents: 10_000,
      perOrgCapCents: 5_000,
    });
    try {
      const d = await enforcer.checkOrRaise({
        installationId: ZERO_UUID,
        estimatedCents: 100,
        today,
      });
      expect(d.allowed).toBe(true);
      // Only the global row exists; no per_org row for the zero-UUID sentinel (CHECK forbids it).
      const rows = await pool.query<{ scope: string }>(
        `SELECT scope FROM telemetry.cost_daily WHERE today = $1`,
        [today],
      );
      expect(rows.rows.map((r) => r.scope).sort()).toEqual(["global"]);
    } finally {
      await cleanupToday(today);
    }
  });

  it("serializes concurrent checkOrRaise via the row lock — no double-spend past the cap", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    // Cap = 1000, each call reserves 100 → at most 10 can succeed. Fire 30 concurrently.
    const CAP = 1000;
    const PER_CALL = 100;
    const CONCURRENCY = 30;
    const enforcer = new PostgresCostCapEnforcer({
      pool,
      clock: FIXED_CLOCK,
      globalCapCents: CAP,
      perOrgCapCents: CAP,
    });
    try {
      const results = await Promise.allSettled(
        Array.from({ length: CONCURRENCY }, () =>
          enforcer.checkOrRaise({ installationId, estimatedCents: PER_CALL, today }),
        ),
      );
      const allowed = results.filter((r) => r.status === "fulfilled").length;
      const refused = results.filter(
        (r) => r.status === "rejected" && r.reason instanceof BedrockBudgetExceededError,
      ).length;

      // Exactly CAP / PER_CALL reservations may succeed; the rest are refused (NOT lock-timeouts).
      expect(allowed).toBe(CAP / PER_CALL);
      expect(allowed + refused).toBe(CONCURRENCY);

      // The persisted total must NEVER exceed the cap — the row lock prevented the audit-B1.1
      // double-spend. (Equality, since exactly CAP/PER_CALL * PER_CALL == CAP reservations landed.)
      const g = await pool.query<{ daily_total_cents: string }>(
        `SELECT daily_total_cents FROM telemetry.cost_daily WHERE today = $1 AND scope = 'global'`,
        [today],
      );
      const total = Number(g.rows[0]?.daily_total_cents);
      expect(total).toBeLessThanOrEqual(CAP);
      expect(total).toBe(CAP);
    } finally {
      await cleanupToday(today);
    }
  });
});
