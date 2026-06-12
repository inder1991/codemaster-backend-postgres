import { randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  BedrockBudgetExceededError,
  CostCapLockTimeoutError,
} from "#backend/cost/enforcer.js";
import { PostgresCostCapEnforcer } from "#backend/cost/postgres_enforcer.js";

import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// DB-gated integration test for the PRODUCTION (Kysely-seam) PostgresCostCapEnforcer against a
// DISPOSABLE Postgres (telemetry.cost_daily + core.cost_cap_* already migrated). Runs ONLY when
// CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so validate-fast stays green without
// a DB. We NEVER touch any other DB. Each test owns a UNIQUE `today` so its global + per-org rows are
// isolated, and cleans them up scope-keyed by `today` in a finally.

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const FIXED_CLOCK = new FakeClock({ now: new Date("2099-01-01T00:00:00.000Z") });

let pool: Pool;
let db: Kysely<unknown>;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  // ADR-0062: ONE memoized pool for the whole file — never a pool per call. The enforcer is handed a
  // Kysely over THIS pool. `max` is generous because the concurrency test fires many connections.
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 16 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
});

afterAll(async () => {
  await db?.destroy(); // ends the pool it wraps
});

/** A unique YYYY-MM-DD-shaped date string so each test owns its own global + per-org rows. */
function uniqueToday(): string {
  const n = (parseInt(randomUUID().replace(/-/g, "").slice(0, 8), 16) % 3000) + 1;
  const base = Date.UTC(2090, 0, 1) + n * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

/** Delete every cost_daily row this test family created for a given `today` (scope-keyed cleanup). */
async function cleanupToday(today: string): Promise<void> {
  await sql`DELETE FROM telemetry.cost_daily WHERE today = ${today}`.execute(db);
}

/** Read the persisted daily_total_cents for one (today, scope) — integer cents. */
async function dailyTotal(today: string, scope: "global" | "per_org"): Promise<number> {
  const r = await sql<{ daily_total_cents: string }>`
    SELECT daily_total_cents FROM telemetry.cost_daily WHERE today = ${today} AND scope = ${scope}
  `.execute(db);
  return Number(r.rows[0]?.daily_total_cents);
}

describeDb("PostgresCostCapEnforcer (production, Kysely seam, disposable PG)", () => {
  it("a reservation creates + increments both cost_daily rows and reports zero prior spend", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const enforcer = new PostgresCostCapEnforcer({
      db,
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

      // The reservation persisted both rows with the estimate applied + the configured caps.
      const rows = await sql<{ scope: string; daily_total_cents: string; cap_cents: string }>`
        SELECT scope, daily_total_cents, cap_cents FROM telemetry.cost_daily WHERE today = ${today}
      `.execute(db);
      const byScope = new Map(rows.rows.map((r) => [r.scope, r]));
      expect(Number(byScope.get("global")?.daily_total_cents)).toBe(100);
      expect(Number(byScope.get("per_org")?.daily_total_cents)).toBe(100);
      expect(Number(byScope.get("global")?.cap_cents)).toBe(10_000);
      expect(Number(byScope.get("per_org")?.cap_cents)).toBe(5_000);
    } finally {
      await cleanupToday(today);
    }
  });

  it("raises BedrockBudgetExceededError(scope=global) when the global cap would be exceeded; no leak", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const enforcer = new PostgresCostCapEnforcer({
      db,
      clock: FIXED_CLOCK,
      globalCapCents: 100,
      perOrgCapCents: 1_000_000,
    });
    try {
      // Reserve 60 (under the global cap of 100).
      await enforcer.checkOrRaise({ installationId, estimatedCents: 60, today });
      // A further 50 would bring global to 110 > 100 → refused on the GLOBAL scope.
      await expect(
        enforcer.checkOrRaise({ installationId, estimatedCents: 50, today }),
      ).rejects.toThrow(BedrockBudgetExceededError);
      try {
        await enforcer.checkOrRaise({ installationId, estimatedCents: 50, today });
      } catch (err) {
        expect((err as BedrockBudgetExceededError).scope).toBe("global");
      }
      // Refused reservations did NOT leak — global total is still 60 (rolled back).
      expect(await dailyTotal(today, "global")).toBe(60);
    } finally {
      await cleanupToday(today);
    }
  });

  it("raises BedrockBudgetExceededError(scope=per_org, scope_id) when the per-org cap would be exceeded", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const enforcer = new PostgresCostCapEnforcer({
      db,
      clock: FIXED_CLOCK,
      globalCapCents: 1_000_000, // global generous → per_org is the binding cap
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

  it("W2.1: a global-cap denial is decided lock-free — no wait behind a held per-org row lock", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const enforcer = new PostgresCostCapEnforcer({
      db,
      clock: FIXED_CLOCK,
      globalCapCents: 100,
      perOrgCapCents: 1_000_000,
    });
    try {
      // Seed both rows at 60 (caps land at the constructor values, so the cap refresh is a no-op).
      await enforcer.checkOrRaise({ installationId, estimatedCents: 60, today });

      // A competing transaction holds the PER-ORG row lock. The global-cap refusal below must come
      // from the atomic conditional-UPDATE gate (0 rows ⇒ over cap) — NOT from a FOR-UPDATE
      // read-then-decide that would queue behind this held per-org lock and surface as
      // CostCapLockTimeoutError only after lock_timeout (the XC4 hot-row lock storm).
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT 1 FROM telemetry.cost_daily WHERE today = $1 AND scope = 'per_org' AND scope_id = $2 FOR UPDATE",
          [today, installationId],
        );

        // 60 + 50 > 100 → refused on the GLOBAL scope, while the per-org lock is still held.
        try {
          await enforcer.checkOrRaise({ installationId, estimatedCents: 50, today });
          throw new Error("expected BedrockBudgetExceededError");
        } catch (err) {
          expect(err).toBeInstanceOf(BedrockBudgetExceededError);
          expect((err as BedrockBudgetExceededError).scope).toBe("global");
        }

        await holder.query("ROLLBACK");
      } finally {
        holder.release();
      }

      // The refusal leaked nothing on EITHER row.
      expect(await dailyTotal(today, "global")).toBe(60);
      expect(await dailyTotal(today, "per_org")).toBe(60);
    } finally {
      await cleanupToday(today);
    }
  }, 15_000);

  it("W2.1: a per-org denial leaves NO partial global increment (both gates commit-or-rollback as one)", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const enforcer = new PostgresCostCapEnforcer({
      db,
      clock: FIXED_CLOCK,
      globalCapCents: 1_000_000, // global generous → per_org is the binding cap
      perOrgCapCents: 100,
    });
    try {
      await enforcer.checkOrRaise({ installationId, estimatedCents: 60, today });
      // 60 + 50 > 100 on the per-org cap. The global gate passes FIRST (conditional UPDATE applied),
      // then the per-org gate refuses — the whole transaction must roll back so the global increment
      // never partially applies.
      try {
        await enforcer.checkOrRaise({ installationId, estimatedCents: 50, today });
        throw new Error("expected BedrockBudgetExceededError");
      } catch (err) {
        expect(err).toBeInstanceOf(BedrockBudgetExceededError);
        const e = err as BedrockBudgetExceededError;
        expect(e.scope).toBe("per_org");
        expect(e.scopeId).toBe(installationId);
      }
      expect(await dailyTotal(today, "global")).toBe(60);
      expect(await dailyTotal(today, "per_org")).toBe(60);
    } finally {
      await cleanupToday(today);
    }
  });

  it("recordCallCost applies the (actual - estimated) diff — top-up then refund", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const enforcer = new PostgresCostCapEnforcer({
      db,
      clock: FIXED_CLOCK,
      globalCapCents: 10_000,
      perOrgCapCents: 5_000,
    });
    try {
      // Reserve 200.
      const first = await enforcer.checkOrRaise({ installationId, estimatedCents: 200, today });
      expect(first.cents_spent_today_global).toBe(0);
      // Actual came in at 350 → diff +150 on top of the reserved 200 → total 350 (under-estimate top-up).
      await enforcer.recordCallCost({ installationId, costCents: 350, estimatedCents: 200, today });
      // Next check sees the accumulated 350 (integer cents).
      const second = await enforcer.checkOrRaise({ installationId, estimatedCents: 10, today });
      expect(second.cents_spent_today_global).toBe(350);
      expect(second.cents_spent_today_org).toBe(350);
      expect(Number.isInteger(second.cents_spent_today_global)).toBe(true);

      // A refund (actual < estimated) walks the total back down. Reserve 100, actual 40 → diff -60.
      await enforcer.recordCallCost({ installationId, costCents: 40, estimatedCents: 100, today });
      // Row total: 350 (prior) + 10 (second reservation) - 60 (refund) = 300.
      expect(await dailyTotal(today, "global")).toBe(300);
      expect(await dailyTotal(today, "per_org")).toBe(300);
    } finally {
      await cleanupToday(today);
    }
  });

  it("recordCallCost with diff == 0 is a no-op (no row written)", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const enforcer = new PostgresCostCapEnforcer({ db, clock: FIXED_CLOCK });
    try {
      // No prior reservation; equal actual + estimated → diff 0 → early return, no row created.
      await enforcer.recordCallCost({ installationId, costCents: 100, estimatedCents: 100, today });
      const rows = await sql<{ scope: string }>`
        SELECT scope FROM telemetry.cost_daily WHERE today = ${today}
      `.execute(db);
      expect(rows.rows.length).toBe(0);
    } finally {
      await cleanupToday(today);
    }
  });

  it("skips per_org accounting for the platform-scope zero-UUID sentinel", async () => {
    const today = uniqueToday();
    const enforcer = new PostgresCostCapEnforcer({
      db,
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
      // Only the global row exists; no per_org row for the zero-UUID sentinel (the CHECK forbids it).
      const rows = await sql<{ scope: string }>`
        SELECT scope FROM telemetry.cost_daily WHERE today = ${today}
      `.execute(db);
      expect(rows.rows.map((r) => r.scope).sort()).toEqual(["global"]);
      expect(await dailyTotal(today, "global")).toBe(100);
    } finally {
      await cleanupToday(today);
    }
  });

  it("serializes concurrent checkOrRaise via the row lock — no double-spend past the cap (audit B1.1)", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const CAP = 1000;
    const PER_CALL = 100;
    const CONCURRENCY = 30;
    const enforcer = new PostgresCostCapEnforcer({
      db,
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

      // Exactly CAP / PER_CALL reservations may succeed; the rest are budget-refused (NOT lock-timeouts).
      expect(allowed).toBe(CAP / PER_CALL);
      expect(allowed + refused).toBe(CONCURRENCY);

      // The persisted total must NEVER exceed the cap — the row lock prevented the audit-B1.1
      // double-spend. (Equality: exactly CAP/PER_CALL * PER_CALL == CAP reservations landed.)
      const total = await dailyTotal(today, "global");
      expect(total).toBeLessThanOrEqual(CAP);
      expect(total).toBe(CAP);
    } finally {
      await cleanupToday(today);
    }
  });

  it("W2.1 LOAD-BEARING: concurrent reserves against the binding PER-ORG cap never overshoot it, and the global row matches the org row exactly (atomic two-gate)", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const ORG_CAP = 500;
    const PER_CALL = 100;
    const CONCURRENCY = 20;
    const enforcer = new PostgresCostCapEnforcer({
      db,
      clock: FIXED_CLOCK,
      globalCapCents: 1_000_000, // global generous → per_org is the binding cap
      perOrgCapCents: ORG_CAP,
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

      // (a) NO overshoot: exactly ORG_CAP/PER_CALL accepted; (b) every other call is a clean
      // budget refusal (never a lock timeout / partial state).
      expect(allowed).toBe(ORG_CAP / PER_CALL);
      expect(allowed + refused).toBe(CONCURRENCY);

      // (c) ATOMICITY UNDER CONTENTION: a refused per-org gate must roll back the already-applied
      // global gate, so the two rows agree EXACTLY. A partial leak shows up as global > per_org.
      const orgTotal = await dailyTotal(today, "per_org");
      const globalTotal = await dailyTotal(today, "global");
      expect(orgTotal).toBe(ORG_CAP);
      expect(globalTotal).toBe(orgTotal);
    } finally {
      await cleanupToday(today);
    }
  }, 20_000);

  it("W2.1 LOAD-BEARING: two orgs racing the binding GLOBAL cap — accepted sum == global row == sum of org rows; refusals are budget errors", async () => {
    const today = uniqueToday();
    const orgA = randomUUID();
    const orgB = randomUUID();
    const GLOBAL_CAP = 1000;
    const PER_CALL = 100;
    const PER_ORG_CONCURRENCY = 15; // 30 calls total race a cap that admits 10
    const enforcer = new PostgresCostCapEnforcer({
      db,
      clock: FIXED_CLOCK,
      globalCapCents: GLOBAL_CAP,
      perOrgCapCents: 10_000, // per-org generous → global is the binding cap
    });
    try {
      const calls = [
        ...Array.from({ length: PER_ORG_CONCURRENCY }, () => orgA),
        ...Array.from({ length: PER_ORG_CONCURRENCY }, () => orgB),
      ];
      const results = await Promise.allSettled(
        calls.map((installationId) =>
          enforcer.checkOrRaise({ installationId, estimatedCents: PER_CALL, today }),
        ),
      );
      const allowed = results.filter((r) => r.status === "fulfilled").length;
      const refused = results.filter(
        (r) => r.status === "rejected" && r.reason instanceof BedrockBudgetExceededError,
      ).length;

      expect(allowed).toBe(GLOBAL_CAP / PER_CALL);
      expect(allowed + refused).toBe(2 * PER_ORG_CONCURRENCY);

      // The global row carries EXACTLY the accepted sum, and the per-org rows partition it — a
      // global-gate pass whose per-org gate refused (or vice versa) would break this equality.
      const globalTotal = await dailyTotal(today, "global");
      expect(globalTotal).toBe(GLOBAL_CAP);
      const orgRows = await sql<{ scope_id: string; daily_total_cents: string }>`
        SELECT scope_id, daily_total_cents FROM telemetry.cost_daily
         WHERE today = ${today} AND scope = 'per_org'
      `.execute(db);
      const orgSum = orgRows.rows.reduce((acc, r) => acc + Number(r.daily_total_cents), 0);
      expect(orgSum).toBe(globalTotal);
      for (const r of orgRows.rows) {
        expect(Number(r.daily_total_cents) % PER_CALL).toBe(0);
      }
    } finally {
      await cleanupToday(today);
    }
  }, 20_000);

  it("W2.1 LOAD-BEARING: a near-full cap admits at most the remaining headroom under a concurrent burst (no overshoot, headroom < 2×estimate)", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const GLOBAL_CAP = 1000;
    const enforcer = new PostgresCostCapEnforcer({
      db,
      clock: FIXED_CLOCK,
      globalCapCents: GLOBAL_CAP,
      perOrgCapCents: 10_000,
    });
    try {
      // Pre-spend to 850: headroom 150 fits exactly ONE more 100-cent reservation.
      await enforcer.checkOrRaise({ installationId, estimatedCents: 850, today });

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          enforcer.checkOrRaise({ installationId, estimatedCents: 100, today }),
        ),
      );
      const allowed = results.filter((r) => r.status === "fulfilled").length;
      const refused = results.filter(
        (r) => r.status === "rejected" && r.reason instanceof BedrockBudgetExceededError,
      ).length;
      expect(allowed).toBe(1);
      expect(refused).toBe(9);

      const total = await dailyTotal(today, "global");
      expect(total).toBe(950);
      expect(total).toBeLessThanOrEqual(GLOBAL_CAP);
    } finally {
      await cleanupToday(today);
    }
  }, 20_000);

  it("maps a contended FOR UPDATE row lock to CostCapLockTimeoutError (SQLSTATE 55P03)", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const enforcer = new PostgresCostCapEnforcer({ db, clock: FIXED_CLOCK });

    // Seed both rows so the global FOR UPDATE inside the enforcer targets an EXISTING row, and a
    // separate holder connection can lock it. (checkOrRaise's idempotent INSERT ON CONFLICT DO NOTHING
    // would otherwise create-then-lock; we want the lock contention on the global row.)
    await enforcer.checkOrRaise({ installationId, estimatedCents: 0, today });

    // Hold a competing FOR UPDATE lock on the global row from a separate connection so the enforcer's
    // SET LOCAL lock_timeout='2s' fires (55P03) before the holder releases.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT 1 FROM telemetry.cost_daily WHERE today = $1 AND scope = 'global' FOR UPDATE",
        [today],
      );

      await expect(
        enforcer.checkOrRaise({ installationId, estimatedCents: 1, today }),
      ).rejects.toThrow(CostCapLockTimeoutError);

      await holder.query("ROLLBACK");
    } finally {
      holder.release();
      await cleanupToday(today);
    }
  }, 15_000);
});
