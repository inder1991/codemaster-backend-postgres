import { randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  BedrockBudgetExceededError,
  CostCapLockTimeoutError,
} from "#backend/cost/enforcer.js";
import { PostgresCostJournal } from "#backend/cost/cost_journal.js";

import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// de-Temporal Phase 0 — DB-gated integration test for PostgresCostJournal, the compensating signed
// journal that runs ALONGSIDE telemetry.cost_daily. Proves the checklist-#2 invariants against a
// DISPOSABLE Postgres (:5434, migration 0047 applied):
//   * daily totals are SUMs over the signed rows — global(day) = SUM(all rows of the day, including
//     platform-scope zero-UUID rows); per-org(day, org) = SUM(rows with installation_id = org);
//   * the journal's (not-yet-production) deciding path checks the cap AGAINST THE SUM with the same
//     decision/error semantics as the aggregate enforcer (same error classes + scopes, refusals
//     leak no row);
//   * recordCallCost ALWAYS appends the settle row — including the diff==0 case the aggregate
//     early-returns on — because the settle row is the reconciler's proof the call completed;
//   * release = APPEND, never subtract: appending a negative release row restores cap headroom
//     (a previously refused reserve passes) while every existing row stays byte-identical.
// Mirrors the postgres_enforcer.integration.test.ts harness: one memoized pool, a unique `today`
// per test so rows are isolated, scope-keyed cleanup in a finally. SKIPS without the DSN.

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const FIXED_CLOCK = new FakeClock({ now: new Date("2099-01-01T00:00:00.000Z") });

let pool: Pool;
let db: Kysely<unknown>;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 8 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
});

afterAll(async () => {
  await db?.destroy(); // ends the pool it wraps
});

/** A unique YYYY-MM-DD-shaped date string so each test owns its own journal day (and cost_daily rows). */
function uniqueToday(): string {
  const n = (parseInt(randomUUID().replace(/-/g, "").slice(0, 8), 16) % 3000) + 1;
  const base = Date.UTC(2080, 0, 1) + n * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

/** Delete every journal row this test created for `today` (releases + reserves go in one statement). */
async function cleanupToday(today: string): Promise<void> {
  await sql`DELETE FROM telemetry.cost_journal WHERE today = ${today}`.execute(db);
}

/** Count ALL journal rows for `today` — the "append-only" witness (the count may only ever grow). */
async function rowCount(today: string): Promise<number> {
  const r = await sql<{ n: string }>`
    SELECT COUNT(*) AS n FROM telemetry.cost_journal WHERE today = ${today}
  `.execute(db);
  return Number(r.rows[0]?.n);
}

function journal(caps?: { globalCapCents?: number; perOrgCapCents?: number }): PostgresCostJournal {
  return new PostgresCostJournal({
    db,
    clock: FIXED_CLOCK,
    globalCapCents: caps?.globalCapCents ?? 10_000,
    perOrgCapCents: caps?.perOrgCapCents ?? 5_000,
  });
}

describeDb("PostgresCostJournal (Phase 0 — signed journal beside the aggregate, disposable PG)", () => {
  it("SUM invariant: global = SUM(all rows incl. platform-scope); per-org = SUM(org rows only)", async () => {
    const today = uniqueToday();
    const orgA = randomUUID();
    const orgB = randomUUID();
    const j = journal();
    try {
      await j.appendReserve({ callId: "call-a", installationId: orgA, amountCents: 100, today });
      await j.appendSettle({ callId: "call-a", installationId: orgA, amountCents: -40, today });
      await j.appendReserve({ callId: "call-b", installationId: orgB, amountCents: 50, today });
      // Platform-scope (zero-UUID sentinel) spend counts toward the GLOBAL sum only.
      await j.appendReserve({ callId: "call-p", installationId: ZERO_UUID, amountCents: 30, today });

      expect(await j.sumForDay({ today })).toBe(140); // 100 - 40 + 50 + 30
      expect(await j.sumForDay({ today, installationId: orgA })).toBe(60);
      expect(await j.sumForDay({ today, installationId: orgB })).toBe(50);
    } finally {
      await cleanupToday(today);
    }
  });

  it("checkOrRaise admits under the cap, reports prior sums, and appends the reserve row", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const j = journal();
    try {
      await j.appendReserve({ callId: "prior", installationId, amountCents: 70, today });

      const d = await j.checkOrRaise({ callId: "call-1", installationId, estimatedCents: 100, today });
      expect(d.allowed).toBe(true);
      expect(d.cents_spent_today_global).toBe(70);
      expect(d.cents_spent_today_org).toBe(70);
      expect(d.cents_estimated).toBe(100);
      // The reserve was APPENDED — the sums now include it.
      expect(await j.sumForDay({ today })).toBe(170);
      expect(await j.sumForDay({ today, installationId })).toBe(170);
    } finally {
      await cleanupToday(today);
    }
  });

  it("refuses on the GLOBAL scope when SUM + estimate would exceed the cap; the refusal appends NOTHING", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const j = journal({ globalCapCents: 100, perOrgCapCents: 1_000_000 });
    try {
      await j.checkOrRaise({ callId: "c1", installationId, estimatedCents: 60, today });
      const before = await rowCount(today);
      try {
        await j.checkOrRaise({ callId: "c2", installationId, estimatedCents: 50, today });
        throw new Error("expected BedrockBudgetExceededError");
      } catch (err) {
        expect(err).toBeInstanceOf(BedrockBudgetExceededError);
        expect((err as BedrockBudgetExceededError).scope).toBe("global");
      }
      // No leaked reserve row — count and SUM unchanged by the refusal.
      expect(await rowCount(today)).toBe(before);
      expect(await j.sumForDay({ today })).toBe(60);
    } finally {
      await cleanupToday(today);
    }
  });

  it("refuses on the PER-ORG scope (scope_id carried) when the org sum would exceed the org cap", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const j = journal({ globalCapCents: 1_000_000, perOrgCapCents: 100 });
    try {
      await j.checkOrRaise({ callId: "c1", installationId, estimatedCents: 60, today });
      try {
        await j.checkOrRaise({ callId: "c2", installationId, estimatedCents: 50, today });
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

  it("platform-scope (zero-UUID) calls skip the per-org check and journal under the sentinel", async () => {
    const today = uniqueToday();
    // perOrgCap of 1 would refuse ANY org call — proving the platform path never consults it.
    const j = journal({ globalCapCents: 10_000, perOrgCapCents: 1 });
    try {
      const d = await j.checkOrRaise({
        callId: "c-platform",
        installationId: ZERO_UUID,
        estimatedCents: 100,
        today,
      });
      expect(d.allowed).toBe(true);
      expect(d.cents_spent_today_org).toBe(0);
      expect(await j.sumForDay({ today })).toBe(100);
      expect(await j.sumForDay({ today, installationId: ZERO_UUID })).toBe(100);
    } finally {
      await cleanupToday(today);
    }
  });

  it("recordCallCost appends the signed settle diff — top-up, refund, AND the zero diff", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const j = journal();
    try {
      // Reserve 200, actual 350 → settle +150 (top-up).
      await j.checkOrRaise({ callId: "c1", installationId, estimatedCents: 200, today });
      await j.recordCallCost({ callId: "c1", installationId, costCents: 350, estimatedCents: 200, today });
      expect(await j.sumForDay({ today })).toBe(350);

      // Reserve 100, actual 40 → settle -60 (refund).
      await j.checkOrRaise({ callId: "c2", installationId, estimatedCents: 100, today });
      await j.recordCallCost({ callId: "c2", installationId, costCents: 40, estimatedCents: 100, today });
      expect(await j.sumForDay({ today })).toBe(390);

      // DELIBERATE divergence from the aggregate's diff==0 early-return: the zero settle row IS
      // appended (it is the reconciler's proof the call completed) — sum unchanged, count grows.
      const before = await rowCount(today);
      await j.recordCallCost({ callId: "c3", installationId, costCents: 100, estimatedCents: 100, today });
      expect(await rowCount(today)).toBe(before + 1);
      expect(await j.sumForDay({ today })).toBe(390);
    } finally {
      await cleanupToday(today);
    }
  });

  it("mirrors the aggregate's RangeError guards (negative estimate / negative cost)", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const j = journal();
    try {
      await expect(
        j.checkOrRaise({ callId: "c1", installationId, estimatedCents: -1, today }),
      ).rejects.toThrow(RangeError);
      await expect(
        j.recordCallCost({ callId: "c1", installationId, costCents: -1, today }),
      ).rejects.toThrow(RangeError);
      expect(await rowCount(today)).toBe(0);
    } finally {
      await cleanupToday(today);
    }
  });

  it("release = APPEND, never subtract: a negative release row restores headroom; prior rows untouched", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const j = journal({ globalCapCents: 100, perOrgCapCents: 100 });
    try {
      // Fill the day to the cap exactly, then prove the next reserve refuses.
      await j.checkOrRaise({ callId: "c1", installationId, estimatedCents: 100, today });
      await expect(
        j.checkOrRaise({ callId: "c2", installationId, estimatedCents: 40, today }),
      ).rejects.toThrow(BedrockBudgetExceededError);

      // Heal the orphan the way the reconciler does: APPEND a release row referencing the reserve
      // (raw insert — the reconciler lands in [P0.3]; this pins the SUM-side semantics it relies on).
      const reserve = await sql<{ journal_id: string; amount_cents: string }>`
        SELECT journal_id, amount_cents FROM telemetry.cost_journal
         WHERE today = ${today} AND entry_kind = 'reserve'
      `.execute(db);
      const countBefore = await rowCount(today);
      await sql`
        INSERT INTO telemetry.cost_journal
            (call_id, installation_id, today, entry_kind, amount_cents, closes_journal_id)
        VALUES ('c1', ${installationId}::uuid, ${today}, 'release', -100, ${reserve.rows[0]!.journal_id}::uuid)
      `.execute(db);

      // Headroom restored THROUGH THE SUM — the previously refused reserve now passes …
      const d = await j.checkOrRaise({ callId: "c2", installationId, estimatedCents: 40, today });
      expect(d.allowed).toBe(true);
      expect(d.cents_spent_today_global).toBe(0); // 100 reserve + (-100) release
      // … and healing only ever ADDED rows; the original reserve row is byte-identical.
      expect(await rowCount(today)).toBe(countBefore + 2); // the release + the admitted reserve
      const reserveAfter = await sql<{ amount_cents: string }>`
        SELECT amount_cents FROM telemetry.cost_journal
         WHERE journal_id = ${reserve.rows[0]!.journal_id}::uuid
      `.execute(db);
      expect(Number(reserveAfter.rows[0]!.amount_cents)).toBe(100);
    } finally {
      await cleanupToday(today);
    }
  });

  it("maps a contended day lock to CostCapLockTimeoutError (SQLSTATE 55P03) — enforcer parity", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const j = journal();

    // Hold the journal's day-keyed advisory lock from a separate connection so the deciding path's
    // SET LOCAL lock_timeout='2s' fires (55P03) before the holder releases.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('cost_journal'), hashtext($1))", [today]);

      await expect(
        j.checkOrRaise({ callId: "c1", installationId, estimatedCents: 1, today }),
      ).rejects.toThrow(CostCapLockTimeoutError);

      await holder.query("ROLLBACK");
    } finally {
      holder.release();
      await cleanupToday(today);
    }
  }, 15_000);
});
