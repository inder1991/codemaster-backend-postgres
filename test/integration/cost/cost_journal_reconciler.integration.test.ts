import { randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { PostgresCostJournal } from "#backend/cost/cost_journal.js";
import {
  CostJournalReconciler,
  RECONCILE_WINDOW_SECONDS,
} from "#backend/cost/cost_journal_reconciler.js";

import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// de-Temporal Phase 0 checklist #3 — the reconciler finds reserves older than the window with NO
// settle and APPENDS compensating release rows (never an UPDATE/DELETE, never a write to the
// cost_daily aggregate). DB-gated against the disposable :5434 Postgres. Orphan AGE is driven by a
// FakeClock shared between the journal (which authors created_at) and the reconciler (which
// computes the cutoff) — no real waiting, no wall-clock flake.
//
// Healing contract under test:
//   * an orphaned reserve past the window → exactly ONE release: amount = −reserve, same call_id /
//     installation_id / today, closes_journal_id = the reserve row (the partial-unique pairing);
//   * a SETTLED call is never "healed" — including the zero-diff settle (the always-append row
//     exists precisely so this case is distinguishable from an orphan);
//   * a reserve younger than the window is left alone (a settle may still legitimately arrive);
//   * a call with a FRESH reserve (a live retry under the same ADR-0068 call_id) is skipped whole —
//     even its OLD unsettled reserve waits until the retry's envelope closes;
//   * multi-attempt pairing is count-based: 2 reserves + 1 settle → exactly 1 release, closing the
//     OLDEST unreferenced reserve (deterministic);
//   * re-running the pass appends nothing (idempotent under re-runs and races — uq_cost_journal_closes).

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

/** A unique YYYY-MM-DD-shaped date string so each test owns its own journal day. */
function uniqueToday(): string {
  const n = (parseInt(randomUUID().replace(/-/g, "").slice(0, 8), 16) % 3000) + 1;
  const base = Date.UTC(2070, 0, 1) + n * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

async function cleanupToday(today: string): Promise<void> {
  await sql`DELETE FROM telemetry.cost_journal WHERE today = ${today}`.execute(db);
}

type JournalRow = {
  journal_id: string;
  call_id: string;
  installation_id: string;
  entry_kind: string;
  amount_cents: string;
  closes_journal_id: string | null;
};

async function rowsFor(today: string): Promise<Array<JournalRow>> {
  const r = await sql<JournalRow>`
    SELECT journal_id, call_id, installation_id, entry_kind, amount_cents, closes_journal_id
      FROM telemetry.cost_journal
     WHERE today = ${today}
     ORDER BY created_at, journal_id
  `.execute(db);
  return [...r.rows];
}

/** One FakeClock drives BOTH sides; start far in the future so foreign rows can never look young. */
function harness(): { clock: FakeClock; journal: PostgresCostJournal; reconciler: CostJournalReconciler } {
  const clock = new FakeClock({ now: new Date("2099-06-01T00:00:00.000Z") });
  return {
    clock,
    journal: new PostgresCostJournal({ db, clock }),
    reconciler: new CostJournalReconciler({ db, clock }),
  };
}

describeDb("CostJournalReconciler — append-only orphan healing (disposable PG)", () => {
  it("heals an orphaned reserve past the window with ONE paired release row; SUM returns to 0", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const { clock, journal, reconciler } = harness();
    try {
      await journal.appendReserve({ callId: "orphan", installationId, amountCents: 120, today });
      clock.advance({ seconds: RECONCILE_WINDOW_SECONDS + 1 });

      const released = await reconciler.releaseOrphanedReserves();
      expect(released).toBe(1);

      const rows = await rowsFor(today);
      expect(rows).toHaveLength(2);
      const reserve = rows[0]!;
      const release = rows[1]!;
      expect(release.entry_kind).toBe("release");
      expect(Number(release.amount_cents)).toBe(-120);
      expect(release.call_id).toBe("orphan");
      expect(release.installation_id).toBe(installationId);
      expect(release.closes_journal_id).toBe(reserve.journal_id);
      // Headroom restored THROUGH THE SUM — the day nets to zero again.
      expect(await journal.sumForDay({ today })).toBe(0);
    } finally {
      await cleanupToday(today);
    }
  });

  it("never heals a settled call — including the zero-diff settle the aggregate would have skipped", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const { clock, journal, reconciler } = harness();
    try {
      // Call A: settled with a real diff. Call B: settled with diff 0 (the always-append row).
      await journal.appendReserve({ callId: "settled-a", installationId, amountCents: 100, today });
      await journal.appendSettle({ callId: "settled-a", installationId, amountCents: 35, today });
      await journal.appendReserve({ callId: "settled-b", installationId, amountCents: 50, today });
      await journal.appendSettle({ callId: "settled-b", installationId, amountCents: 0, today });
      clock.advance({ seconds: RECONCILE_WINDOW_SECONDS * 3 });

      expect(await reconciler.releaseOrphanedReserves()).toBe(0);
      expect(await rowsFor(today)).toHaveLength(4); // nothing appended
    } finally {
      await cleanupToday(today);
    }
  });

  it("leaves a reserve YOUNGER than the window alone (a settle may still legitimately arrive)", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const { clock, journal, reconciler } = harness();
    try {
      await journal.appendReserve({ callId: "young", installationId, amountCents: 80, today });
      clock.advance({ seconds: RECONCILE_WINDOW_SECONDS - 5 });

      expect(await reconciler.releaseOrphanedReserves()).toBe(0);
      expect(await rowsFor(today)).toHaveLength(1);
    } finally {
      await cleanupToday(today);
    }
  });

  it("skips a call with a FRESH reserve whole — a live retry defers healing of its old orphan too", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const { clock, journal, reconciler } = harness();
    try {
      // Attempt 1 reserved and died un-settled …
      await journal.appendReserve({ callId: "retrying", installationId, amountCents: 60, today });
      clock.advance({ seconds: RECONCILE_WINDOW_SECONDS + 100 });
      // … and a runner retry under the SAME ADR-0068 key just reserved again (still in-flight).
      await journal.appendReserve({ callId: "retrying", installationId, amountCents: 60, today });

      expect(await reconciler.releaseOrphanedReserves()).toBe(0);
      expect(await rowsFor(today)).toHaveLength(2);
    } finally {
      await cleanupToday(today);
    }
  });

  it("pairs count-based across attempts: 2 old reserves + 1 settle → exactly 1 release, closing the OLDEST", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const { clock, journal, reconciler } = harness();
    try {
      await journal.appendReserve({ callId: "multi", installationId, amountCents: 70, today });
      clock.advance({ seconds: 10 });
      await journal.appendReserve({ callId: "multi", installationId, amountCents: 70, today });
      clock.advance({ seconds: 10 });
      await journal.appendSettle({ callId: "multi", installationId, amountCents: -20, today });
      clock.advance({ seconds: RECONCILE_WINDOW_SECONDS + 1 });

      expect(await reconciler.releaseOrphanedReserves()).toBe(1);
      const rows = await rowsFor(today);
      expect(rows).toHaveLength(4);
      const release = rows[3]!;
      const oldestReserve = rows[0]!;
      expect(release.entry_kind).toBe("release");
      expect(Number(release.amount_cents)).toBe(-70);
      expect(release.closes_journal_id).toBe(oldestReserve.journal_id);
    } finally {
      await cleanupToday(today);
    }
  });

  it("re-running the pass appends NOTHING (idempotent healing)", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const { clock, journal, reconciler } = harness();
    try {
      await journal.appendReserve({ callId: "orphan-2", installationId, amountCents: 40, today });
      clock.advance({ seconds: RECONCILE_WINDOW_SECONDS + 1 });

      expect(await reconciler.releaseOrphanedReserves()).toBe(1);
      expect(await reconciler.releaseOrphanedReserves()).toBe(0);
      clock.advance({ seconds: RECONCILE_WINDOW_SECONDS * 5 }); // even much later
      expect(await reconciler.releaseOrphanedReserves()).toBe(0);
      expect(await rowsFor(today)).toHaveLength(2);
    } finally {
      await cleanupToday(today);
    }
  });
});
