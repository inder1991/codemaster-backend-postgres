import { randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { PostgresCostJournal } from "#backend/cost/cost_journal.js";
import { CostJournalReconciler } from "#backend/cost/cost_journal_reconciler.js";
import { PostgresCostCapEnforcer } from "#backend/cost/postgres_enforcer.js";

import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// de-Temporal Phase 0 checklist #4 — the DUAL-READ comparison seam: the journal runs alongside the
// telemetry.cost_daily aggregate, and `divergenceFromAggregate` reports every (scope[, scope_id])
// whose aggregate daily total differs from the journal SUM for the day. Empty report == the two
// accountings agree. Key cases:
//   * agreement after the SAME sequence through both sides → [];
//   * a skewed aggregate (manual UPDATE — the "what if they drift" probe) → reported with BOTH
//     values, global scope keyed by the zero-UUID sentinel;
//   * one-sided keys are still compared (absent == 0): journal-only rows (aggregate write lost) and
//     aggregate-only rows (shadow write lost — the realistic guarded-swallow case) both surface;
//   * the BY-DESIGN post-heal divergence: an orphan healed in the journal while the aggregate keeps
//     its known reservation leak → the delta IS the signal (it quantifies what cutover fixes).
// DB-gated against the disposable :5434 Postgres; per-test unique `today`, both tables cleaned up.

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

let pool: Pool;
let db: Kysely<unknown>;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
});

afterAll(async () => {
  await db?.destroy();
});

/** A unique YYYY-MM-DD-shaped date string so each test owns its own day in BOTH tables. */
function uniqueToday(): string {
  const n = (parseInt(randomUUID().replace(/-/g, "").slice(0, 8), 16) % 3000) + 1;
  const base = Date.UTC(2060, 0, 1) + n * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

async function cleanupToday(today: string): Promise<void> {
  await sql`DELETE FROM telemetry.cost_journal WHERE today = ${today}`.execute(db);
  await sql`DELETE FROM telemetry.cost_daily WHERE today = ${today}`.execute(db);
}

function harness(): {
  clock: FakeClock;
  enforcer: PostgresCostCapEnforcer;
  journal: PostgresCostJournal;
} {
  const clock = new FakeClock({ now: new Date("2099-06-01T00:00:00.000Z") });
  return {
    clock,
    enforcer: new PostgresCostCapEnforcer({ db, clock, globalCapCents: 10_000, perOrgCapCents: 5_000 }),
    journal: new PostgresCostJournal({ db, clock, globalCapCents: 10_000, perOrgCapCents: 5_000 }),
  };
}

describeDb("PostgresCostJournal.divergenceFromAggregate — the dual-read seam (disposable PG)", () => {
  it("reports NOTHING when the same sequence flowed through both sides (shadow-write agreement)", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const { enforcer, journal } = harness();
    try {
      // The shadow-write shape: aggregate decides, journal mirrors — reserve then settle.
      await enforcer.checkOrRaise({ installationId, estimatedCents: 200, today });
      await journal.appendReserve({ callId: "c1", installationId, amountCents: 200, today });
      await enforcer.recordCallCost({ installationId, costCents: 350, estimatedCents: 200, today });
      await journal.appendSettle({ callId: "c1", installationId, amountCents: 150, today });

      expect(await journal.divergenceFromAggregate({ today })).toEqual([]);
    } finally {
      await cleanupToday(today);
    }
  });

  it("reports a skewed aggregate with BOTH values; the global row keys on the zero-UUID sentinel", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const { enforcer, journal } = harness();
    try {
      await enforcer.checkOrRaise({ installationId, estimatedCents: 100, today });
      await journal.appendReserve({ callId: "c1", installationId, amountCents: 100, today });

      // Skew ONLY the aggregate's global row (+25) — the probe for "the accountings drifted".
      await sql`
        UPDATE telemetry.cost_daily SET daily_total_cents = daily_total_cents + 25
         WHERE today = ${today} AND scope = 'global'
      `.execute(db);

      const report = await journal.divergenceFromAggregate({ today });
      expect(report).toEqual([
        { scope: "global", scopeId: ZERO_UUID, aggregateCents: 125, journalCents: 100 },
      ]);
    } finally {
      await cleanupToday(today);
    }
  });

  it("compares one-sided keys against 0: journal-only rows AND aggregate-only org rows both surface", async () => {
    const today = uniqueToday();
    const orgJournalOnly = randomUUID();
    const orgAggOnly = randomUUID();
    const { enforcer, journal } = harness();
    try {
      // Journal-only spend (the aggregate write was lost): global + per-org both diverge.
      await journal.appendReserve({ callId: "c1", installationId: orgJournalOnly, amountCents: 60, today });
      // Aggregate-only spend for a DIFFERENT org (the shadow write was lost): its org row diverges
      // (and the global row carries the lost 40 too).
      await enforcer.checkOrRaise({ installationId: orgAggOnly, estimatedCents: 40, today });

      const report = await journal.divergenceFromAggregate({ today });
      expect(report).toContainEqual({
        scope: "global",
        scopeId: ZERO_UUID,
        aggregateCents: 40,
        journalCents: 60,
      });
      expect(report).toContainEqual({
        scope: "per_org",
        scopeId: orgJournalOnly,
        aggregateCents: 0,
        journalCents: 60,
      });
      expect(report).toContainEqual({
        scope: "per_org",
        scopeId: orgAggOnly,
        aggregateCents: 40,
        journalCents: 0,
      });
      expect(report).toHaveLength(3);
    } finally {
      await cleanupToday(today);
    }
  });

  it("surfaces the BY-DESIGN post-heal divergence: journal released the orphan, the aggregate still leaks it", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const { clock, enforcer, journal } = harness();
    const reconciler = new CostJournalReconciler({ db, clock });
    try {
      // Both sides reserve; the call dies before any settle (the orphan-leak scenario).
      await enforcer.checkOrRaise({ installationId, estimatedCents: 90, today });
      await journal.appendReserve({ callId: "orphan", installationId, amountCents: 90, today });
      expect(await journal.divergenceFromAggregate({ today })).toEqual([]); // agree pre-heal

      clock.advance({ seconds: 10_000 }); // past any window
      expect(await reconciler.releaseOrphanedReserves()).toBe(1);

      // The journal healed (SUM back to 0); the aggregate's reservation leaks forever — the delta
      // is the cutover-value signal this seam exists to report.
      const report = await journal.divergenceFromAggregate({ today });
      expect(report).toContainEqual({
        scope: "global",
        scopeId: ZERO_UUID,
        aggregateCents: 90,
        journalCents: 0,
      });
      expect(report).toContainEqual({
        scope: "per_org",
        scopeId: installationId,
        aggregateCents: 90,
        journalCents: 0,
      });
    } finally {
      await cleanupToday(today);
    }
  });
});
