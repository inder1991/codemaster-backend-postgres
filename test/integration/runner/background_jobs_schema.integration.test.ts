// Phase 3a W1 (migration 0039): core.background_jobs — the GENERIC job platform table generalizing
// the proven core.review_jobs runner. This suite proves the SCHEMA invariants at the DB (raw INSERTs
// bypass any future repo validation — the "manual edit / future migration" threat, same posture as
// review_jobs_payload_check.integration.test.ts):
//   (a) a valid platform-scoped insert succeeds, the DB defaults land, and the row round-trips
//       through BackgroundJobV1 (contract ↔ schema drift guard);
//   (b) a payload_sha256 that is not 64 lowercase hex is REJECTED (ck_background_jobs_payload_sha256_hex);
//   (c) a state outside the 5-value vocabulary is REJECTED (the state CHECK);
//   (d) the PARTIAL UNIQUE index on dedup_key blocks a 2nd ACTIVE ('ready') row with the same key
//       (the scheduler's overlap=SKIP guard) — and STOPS blocking once the first row is terminal
//       (state='done'), which is the "partial" half of the invariant.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster. Each insert carries a per-run-unique job_type; afterAll deletes by it.
import { afterAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { BackgroundJobV1 } from "#contracts/background_job.v1.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }

// Per-run-unique job_type so parallel/repeated runs cannot collide and teardown is exact.
const JOB_TYPE = `w1-schema-test-${randomUUID()}`;
const VALID_SHA = "a".repeat(64);

afterAll(async () => {
  if (db) {
    await sql`DELETE FROM core.background_jobs WHERE job_type = ${JOB_TYPE}`.execute(db);
    await db.destroy();
  }
});

/**
 * Direct INSERT into core.background_jobs (bypasses the Wave-2 repo entirely — this is the threat
 * model the DB CHECKs defend against). Only the columns under test are passed; everything else
 * exercises the DB defaults. Returns the minted job_id.
 */
async function rawInsertJob(opts?: {
  state?: string; sha256?: string; dedupKey?: string | null; installationId?: string | null;
}): Promise<string> {
  const jobId = randomUUID();
  await sql`INSERT INTO core.background_jobs (job_id, job_type, installation_id, payload, payload_sha256, state, dedup_key)
    VALUES (${jobId}, ${JOB_TYPE}, ${opts?.installationId ?? null}, CAST(${"{}"} AS jsonb),
            ${opts?.sha256 ?? VALID_SHA}, ${opts?.state ?? "ready"}, ${opts?.dedupKey ?? null})`.execute(db);
  return jobId;
}

describeDb("core.background_jobs schema (migration 0039)", () => {
  it("(a) ACCEPTS a valid platform-scoped row; DB defaults land; row round-trips through BackgroundJobV1", async () => {
    const jobId = await rawInsertJob();
    const r = await sql<Record<string, unknown>>`SELECT * FROM core.background_jobs WHERE job_id = ${jobId}`.execute(db);
    expect(r.rows).toHaveLength(1);
    const parsed = BackgroundJobV1.parse(r.rows[0]); // contract ↔ schema drift guard
    expect(parsed.job_id).toBe(jobId);
    expect(parsed.job_type).toBe(JOB_TYPE);
    expect(parsed.installation_id).toBeNull(); // NULLABLE: platform-scoped job
    expect(parsed.state).toBe("ready");
    expect(parsed.priority).toBe(0);
    expect(parsed.attempts).toBe(0);
    expect(parsed.max_attempts).toBe(3);
    expect(parsed.run_after).toBeInstanceOf(Date);
    expect(parsed.created_at).toBeInstanceOf(Date);
    expect(parsed.updated_at).toBeInstanceOf(Date);
    expect(parsed.lease_owner).toBeNull();
    expect(parsed.attempt_token).toBeNull();
    expect(parsed.dedup_key).toBeNull();
  });

  it("(a') ACCEPTS a tenant-scoped row (installation_id set)", async () => {
    const iid = randomUUID();
    const jobId = await rawInsertJob({ installationId: iid });
    const r = await sql<{ installation_id: string }>`SELECT installation_id FROM core.background_jobs
      WHERE job_id = ${jobId}`.execute(db);
    expect(r.rows[0]?.installation_id).toBe(iid);
  });

  it("(b) REJECTS a payload_sha256 that is not 64 lowercase hex chars", async () => {
    // too short
    await expect(rawInsertJob({ sha256: "deadbeef" }))
      .rejects.toThrow(/ck_background_jobs_payload_sha256_hex|check constraint/i);
    // uppercase hex (sha256hex emits LOWERCASE only)
    await expect(rawInsertJob({ sha256: "A".repeat(64) }))
      .rejects.toThrow(/ck_background_jobs_payload_sha256_hex|check constraint/i);
    // 64 chars but a non-hex char
    await expect(rawInsertJob({ sha256: "g".repeat(64) }))
      .rejects.toThrow(/ck_background_jobs_payload_sha256_hex|check constraint/i);
  });

  it("(c) REJECTS a state outside the 5-value vocabulary ('cancelled' is review_jobs-only)", async () => {
    await expect(rawInsertJob({ state: "running" })).rejects.toThrow(/check constraint/i);
    await expect(rawInsertJob({ state: "cancelled" })).rejects.toThrow(/check constraint/i);
    // 'failed' IS persisted in the generic vocabulary (divergence from review_jobs):
    await expect(rawInsertJob({ state: "failed" })).resolves.toBeDefined();
  });

  it("(d) dedup_key partial-unique: a 2nd ACTIVE row with the same key is BLOCKED; a terminal first row unblocks it", async () => {
    const key = `dedup-${randomUUID()}`;
    const first = await rawInsertJob({ dedupKey: key, state: "ready" });
    // overlap=SKIP: the second active enqueue conflicts
    await expect(rawInsertJob({ dedupKey: key, state: "ready" }))
      .rejects.toThrow(/uq_background_jobs_dedup_active|duplicate key/i);
    await expect(rawInsertJob({ dedupKey: key, state: "leased" }))
      .rejects.toThrow(/uq_background_jobs_dedup_active|duplicate key/i);
    // the PARTIAL half: once the first row is terminal, the same key is insertable again
    await sql`UPDATE core.background_jobs SET state = 'done' WHERE job_id = ${first}`.execute(db);
    await expect(rawInsertJob({ dedupKey: key, state: "ready" })).resolves.toBeDefined();
  });
});

// `describe` is imported so the file does not get flagged when the DSN is absent (suite skips).
void describe;
