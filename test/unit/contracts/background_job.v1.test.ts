// Phase 3a W1: BackgroundJobV1 — the row contract for core.background_jobs (migration 0039), the
// GENERIC job platform generalizing core.review_jobs. Key vocabulary divergences from ReviewJobV1:
//   - 'failed' does NOT exist (W4c.1 #7 / migration 0042): markFailed settles ready|dead exactly
//     like review_jobs, so the once-reserved persisted 'failed' state was unreachable vocabulary —
//     removed so operators never monitor a state that structurally cannot occur;
//   - 'cancelled' does NOT exist in the generic vocabulary;
//   - installation_id is NULLABLE (most job types are not tenant-scoped);
//   - payload_sha256 is contract-validated as 64 LOWERCASE hex (the sha256hex shape, mirroring the
//     DB CHECK ck_background_jobs_payload_sha256_hex) so a non-hex sha can never round-trip.
import { describe, expect, it } from "vitest";
import { BackgroundJobV1, BACKGROUND_JOB_STATES } from "#contracts/background_job.v1.js";

function validRow(): Record<string, unknown> {
  return {
    job_id: crypto.randomUUID(),
    job_type: "mark_stale_chunks",
    installation_id: null,
    payload: { schema_version: 1 },
    payload_sha256: "a".repeat(64),
    state: "ready",
    priority: 0,
    run_after: new Date("2026-06-10T00:00:00Z"),
    lease_owner: null,
    attempt_token: null,
    leased_until: null,
    timeout_at: null,
    heartbeat_at: null,
    attempts: 0,
    max_attempts: 3,
    finished_at: null, // W2a.1 (migration 0041): dead-letter triple, review_jobs parity
    dead_reason: null,
    last_error: null,
    dedup_key: null,
    created_at: new Date("2026-06-10T00:00:00Z"),
    updated_at: new Date("2026-06-10T00:00:00Z"),
  };
}

describe("BackgroundJobV1", () => {
  it("parses a valid ready row round-trip (defaults schema_version=1; tenant-less job)", () => {
    const row = validRow();
    const parsed = BackgroundJobV1.parse(row);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.job_id).toBe(row["job_id"]);
    expect(parsed.job_type).toBe("mark_stale_chunks");
    expect(parsed.installation_id).toBeNull();
    expect(parsed.payload).toEqual({ schema_version: 1 });
    expect(parsed.payload_sha256).toBe("a".repeat(64));
    expect(parsed.state).toBe("ready");
    expect(parsed.run_after).toEqual(new Date("2026-06-10T00:00:00Z"));
    expect(parsed.dedup_key).toBeNull();
  });

  it("parses a leased TENANT-SCOPED row (installation_id set; lease columns populated; ISO-string dates coerce)", () => {
    const iid = crypto.randomUUID();
    const token = crypto.randomUUID();
    const parsed = BackgroundJobV1.parse({
      ...validRow(),
      installation_id: iid,
      state: "leased",
      lease_owner: "worker-1",
      attempt_token: token,
      leased_until: "2026-06-10T00:05:00Z", // JSON wire shape — must coerce like the pg Date shape
      timeout_at: "2026-06-10T01:00:00Z",
      heartbeat_at: "2026-06-10T00:01:00Z",
      attempts: 1,
      dedup_key: "mark_stale_chunks:bucket-42",
    });
    expect(parsed.installation_id).toBe(iid);
    expect(parsed.attempt_token).toBe(token);
    expect(parsed.leased_until).toEqual(new Date("2026-06-10T00:05:00Z"));
    expect(parsed.dedup_key).toBe("mark_stale_chunks:bucket-42");
  });

  it("'failed' was REMOVED from the vocabulary (W4c.1 #7 — nothing ever wrote it); 'cancelled' never existed", () => {
    expect(BACKGROUND_JOB_STATES).toEqual(["ready", "leased", "done", "dead"]);
    expect(() => BackgroundJobV1.parse({ ...validRow(), state: "failed" })).toThrow();
    expect(() => BackgroundJobV1.parse({ ...validRow(), state: "cancelled" })).toThrow();
  });

  it("rejects an unknown state", () => {
    expect(() => BackgroundJobV1.parse({ ...validRow(), state: "running" })).toThrow();
  });

  it("parses a DEAD-LETTERED row (W2a.1 / migration 0041): dead_reason + last_error + finished_at populated", () => {
    const parsed = BackgroundJobV1.parse({
      ...validRow(),
      state: "dead",
      attempts: 3,
      last_error: "boom",
      dead_reason: "boom",
      finished_at: "2026-06-10T00:10:00Z", // JSON wire shape — must coerce like the pg Date shape
    });
    expect(parsed.state).toBe("dead");
    expect(parsed.last_error).toBe("boom");
    expect(parsed.dead_reason).toBe("boom");
    expect(parsed.finished_at).toEqual(new Date("2026-06-10T00:10:00Z"));
  });

  it("rejects a payload_sha256 that is not 64 lowercase hex chars", () => {
    // too short
    expect(() => BackgroundJobV1.parse({ ...validRow(), payload_sha256: "deadbeef" })).toThrow();
    // uppercase hex (sha256hex emits LOWERCASE only)
    expect(() => BackgroundJobV1.parse({ ...validRow(), payload_sha256: "A".repeat(64) })).toThrow();
    // 64 chars but a non-hex char
    expect(() => BackgroundJobV1.parse({ ...validRow(), payload_sha256: "g".repeat(64) })).toThrow();
  });

  it("rejects an empty job_type and a non-uuid job_id", () => {
    expect(() => BackgroundJobV1.parse({ ...validRow(), job_type: "" })).toThrow();
    expect(() => BackgroundJobV1.parse({ ...validRow(), job_id: "not-a-uuid" })).toThrow();
  });
});
