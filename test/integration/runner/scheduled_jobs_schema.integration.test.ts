// Phase 3a W1 (migration 0040): core.scheduled_jobs — the Postgres scheduler rows replacing
// Temporal Schedules. Proves at the DB (raw INSERTs, same posture as the sibling 0039 suite):
//   (a) a valid cron row inserts, DB defaults land (input '{}', overlap_policy 'skip', enabled true),
//       and the row round-trips through ScheduledJobV1 (contract ↔ schema drift guard);
//   (b) a cadence_kind outside ('cron','interval') is REJECTED (ck_scheduled_jobs_cadence_kind);
//   (c) schedule_id is the PRIMARY KEY — a duplicate insert is REJECTED (ensureCronSchedule
//       idempotency lands on this key in Wave 3).
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster. schedule_ids are per-run-unique; afterAll deletes by prefix match on this run's ids.
import { afterAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ScheduledJobV1 } from "#contracts/scheduled_job.v1.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }

// Per-run-unique prefix so parallel/repeated runs cannot collide and teardown is exact.
const RUN_PREFIX = `w1-sched-test-${randomUUID()}`;

afterAll(async () => {
  if (db) {
    await sql`DELETE FROM core.scheduled_jobs WHERE schedule_id LIKE ${RUN_PREFIX + "%"}`.execute(db);
    await db.destroy();
  }
});

/** Direct INSERT into core.scheduled_jobs; only the columns under test are passed (defaults exercise). */
async function rawInsertSchedule(opts?: { scheduleId?: string; cadenceKind?: string; cadenceSpec?: string }): Promise<string> {
  const scheduleId = opts?.scheduleId ?? `${RUN_PREFIX}-${randomUUID()}`;
  await sql`INSERT INTO core.scheduled_jobs (schedule_id, job_type, cadence_kind, cadence_spec, next_run_at)
    VALUES (${scheduleId}, 'mark_stale_chunks', ${opts?.cadenceKind ?? "cron"},
            ${opts?.cadenceSpec ?? "0 * * * *"}, now())`.execute(db);
  return scheduleId;
}

describeDb("core.scheduled_jobs schema (migration 0040)", () => {
  it("(a) ACCEPTS a valid cron row; DB defaults land; row round-trips through ScheduledJobV1", async () => {
    const scheduleId = await rawInsertSchedule();
    const r = await sql<Record<string, unknown>>`SELECT * FROM core.scheduled_jobs
      WHERE schedule_id = ${scheduleId}`.execute(db);
    expect(r.rows).toHaveLength(1);
    const parsed = ScheduledJobV1.parse(r.rows[0]); // contract ↔ schema drift guard
    expect(parsed.schedule_id).toBe(scheduleId);
    expect(parsed.job_type).toBe("mark_stale_chunks");
    expect(parsed.cadence_kind).toBe("cron");
    expect(parsed.cadence_spec).toBe("0 * * * *");
    expect(parsed.input).toEqual({});          // DB default '{}'::jsonb
    expect(parsed.overlap_policy).toBe("skip"); // DB default
    expect(parsed.enabled).toBe(true);          // DB default
    expect(parsed.next_run_at).toBeInstanceOf(Date);
    expect(parsed.last_enqueued_at).toBeNull();
    expect(parsed.created_at).toBeInstanceOf(Date);
    expect(parsed.updated_at).toBeInstanceOf(Date);
  });

  it("(a') ACCEPTS an interval row (cadence_spec = seconds)", async () => {
    const scheduleId = await rawInsertSchedule({ cadenceKind: "interval", cadenceSpec: "21600" });
    const r = await sql<{ cadence_kind: string; cadence_spec: string }>`SELECT cadence_kind, cadence_spec
      FROM core.scheduled_jobs WHERE schedule_id = ${scheduleId}`.execute(db);
    expect(r.rows[0]).toEqual({ cadence_kind: "interval", cadence_spec: "21600" });
  });

  it("(b) REJECTS a cadence_kind outside the 2-value vocabulary", async () => {
    await expect(rawInsertSchedule({ cadenceKind: "rrule" }))
      .rejects.toThrow(/ck_scheduled_jobs_cadence_kind|check constraint/i);
  });

  it("(c) REJECTS a duplicate schedule_id (text PRIMARY KEY — Wave-3 idempotency anchor)", async () => {
    const scheduleId = await rawInsertSchedule();
    await expect(rawInsertSchedule({ scheduleId })).rejects.toThrow(/scheduled_jobs_pkey|duplicate key/i);
  });
});

// `describe` is imported so the file does not get flagged when the DSN is absent (suite skips).
void describe;
