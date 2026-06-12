// de-Temporal Phase 0 (migration 0047): telemetry.cost_journal — the compensating SIGNED per-call
// cost journal that runs ALONGSIDE the telemetry.cost_daily aggregate (shadow-write until cutover).
// This suite proves the SCHEMA invariants at the DB (raw INSERTs bypass the PostgresCostJournal repo
// entirely — the "manual edit / future migration" threat, same posture as
// background_jobs_schema.integration.test.ts):
//   (a) a valid reserve insert succeeds and the DB defaults land (gen_random_uuid journal_id,
//       now() created_at);
//   (b) an entry_kind outside the 3-value vocabulary is REJECTED (ck_cost_journal_entry_kind);
//   (c) a NEGATIVE 'reserve' is REJECTED (ck_cost_journal_reserve_sign — a destructive negative
//       reservation is unrepresentable; healing happens via 'release' rows, never signed reserves);
//   (d) a POSITIVE 'release' is REJECTED (ck_cost_journal_release_sign — a release can only ever
//       RESTORE headroom, never steal it);
//   (e) closes_journal_id on a non-release row is REJECTED (only reconciler-authored release rows
//       pair back to the reserve they compensate);
//   (f) a closes_journal_id pointing at no journal row is REJECTED (FK — a release cannot heal a
//       phantom reserve);
//   (g) a SECOND release closing the SAME reserve is REJECTED (uq_cost_journal_closes, the partial
//       unique arbiter that makes reconciliation idempotent under re-runs and races).
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster. Every insert carries a per-run-unique call_id; afterAll deletes by it.
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, expect, it } from "vitest";
import { describeDb, INTEGRATION_DSN } from "../_db.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }

// Per-run-unique call_id so parallel/repeated runs cannot collide and teardown is exact.
const CALL_ID = `p0-schema-test-${randomUUID()}`;
const INSTALLATION_ID = randomUUID();
const TODAY = "2091-01-01";

afterAll(async () => {
  if (db) {
    // One statement removes parent reserves AND the releases referencing them (the self-FK is
    // checked at end-of-statement, so deleting both sides together is safe).
    await sql`DELETE FROM telemetry.cost_journal WHERE call_id = ${CALL_ID}`.execute(db);
    await db.destroy();
  }
});

/**
 * Direct INSERT into telemetry.cost_journal (bypasses the repo entirely — this is the threat model
 * the DB CHECKs defend against). Only the columns under test are passed; journal_id + created_at
 * exercise the DB defaults. Returns the minted journal_id.
 */
async function rawInsert(opts: {
  entryKind: string; amountCents: number; closesJournalId?: string | null;
}): Promise<string> {
  const r = await sql<{ journal_id: string }>`
    INSERT INTO telemetry.cost_journal (call_id, installation_id, today, entry_kind, amount_cents, closes_journal_id)
    VALUES (${CALL_ID}, ${INSTALLATION_ID}::uuid, ${TODAY}, ${opts.entryKind}, ${opts.amountCents},
            ${opts.closesJournalId ?? null})
    RETURNING journal_id
  `.execute(db);
  return r.rows[0]!.journal_id;
}

describeDb("telemetry.cost_journal schema (migration 0047)", () => {
  it("(a) ACCEPTS a valid reserve row; the DB defaults mint journal_id + created_at", async () => {
    const journalId = await rawInsert({ entryKind: "reserve", amountCents: 125 });
    const r = await sql<{ journal_id: string; created_at: Date; amount_cents: string }>`
      SELECT journal_id, created_at, amount_cents FROM telemetry.cost_journal
       WHERE journal_id = ${journalId}::uuid
    `.execute(db);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.journal_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.rows[0]!.created_at).toBeInstanceOf(Date);
    expect(Number(r.rows[0]!.amount_cents)).toBe(125);
  });

  it("(b) REJECTS an entry_kind outside the reserve/settle/release vocabulary", async () => {
    await expect(rawInsert({ entryKind: "refund", amountCents: 1 })).rejects.toThrow(
      /ck_cost_journal_entry_kind/,
    );
  });

  it("(c) REJECTS a NEGATIVE reserve (healing is release-append, never a signed reserve)", async () => {
    await expect(rawInsert({ entryKind: "reserve", amountCents: -1 })).rejects.toThrow(
      /ck_cost_journal_reserve_sign/,
    );
  });

  it("(d) REJECTS a POSITIVE release (a release can only restore headroom)", async () => {
    await expect(rawInsert({ entryKind: "release", amountCents: 1 })).rejects.toThrow(
      /ck_cost_journal_release_sign/,
    );
  });

  it("(e) REJECTS closes_journal_id on a non-release row", async () => {
    const reserveId = await rawInsert({ entryKind: "reserve", amountCents: 10 });
    await expect(
      rawInsert({ entryKind: "settle", amountCents: 0, closesJournalId: reserveId }),
    ).rejects.toThrow(/ck_cost_journal_closes_release_only/);
  });

  it("(f) REJECTS a release whose closes_journal_id names no journal row (FK)", async () => {
    await expect(
      rawInsert({ entryKind: "release", amountCents: -10, closesJournalId: randomUUID() }),
    ).rejects.toThrow(/cost_journal_closes_journal_id_fkey/);
  });

  it("(g) REJECTS a SECOND release closing the SAME reserve (uq_cost_journal_closes — idempotent healing)", async () => {
    const reserveId = await rawInsert({ entryKind: "reserve", amountCents: 40 });
    await rawInsert({ entryKind: "release", amountCents: -40, closesJournalId: reserveId });
    await expect(
      rawInsert({ entryKind: "release", amountCents: -40, closesJournalId: reserveId }),
    ).rejects.toThrow(/uq_cost_journal_closes/);
  });
});
