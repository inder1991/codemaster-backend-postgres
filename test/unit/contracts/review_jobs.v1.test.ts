import { describe, expect, it } from "vitest";
import { ReviewJobV1, JOB_STATES } from "#contracts/review_jobs.v1.js";
describe("ReviewJobV1", () => {
  it("parses a ready job, rejects unknown/transient state", () => {
    const base = { job_id: crypto.randomUUID(), run_id: crypto.randomUUID(), review_id: crypto.randomUUID(),
      installation_id: crypto.randomUUID(), state: "ready", priority: 0, attempts: 0, max_attempts: 3 };
    expect(ReviewJobV1.parse(base).state).toBe("ready");
    expect(() => ReviewJobV1.parse({ ...base, state: "failed" })).toThrow(); // 'failed' is not a persisted state
    expect(JOB_STATES).toEqual(["ready", "leased", "done", "dead", "cancelled"]);
  });

  it("parses the durable-payload envelope columns (job_payload_schema_version/payload_sha256/mutex_id)", () => {
    // F1: job_payload_schema_version is the STORAGE-ENVELOPE version (default 1), NOT the review payload's
    // own inner schema_version (=2). It must never collide with the payload contract's literal.
    const base = { job_id: crypto.randomUUID(), run_id: crypto.randomUUID(), review_id: crypto.randomUUID(),
      installation_id: crypto.randomUUID(), state: "leased", priority: 0, attempts: 1, max_attempts: 3,
      job_payload_schema_version: 1, payload_sha256: "a".repeat(64), mutex_id: crypto.randomUUID() };
    const parsed = ReviewJobV1.parse(base);
    expect(parsed.job_payload_schema_version).toBe(1);
    expect(parsed.payload_sha256).toBe("a".repeat(64));
    expect(parsed.mutex_id).toBe(base.mutex_id);
  });

  it("accepts a null mutex_id (no mutex acquired yet)", () => {
    const base = { job_id: crypto.randomUUID(), run_id: crypto.randomUUID(), review_id: crypto.randomUUID(),
      installation_id: crypto.randomUUID(), state: "ready", priority: 0, attempts: 0, max_attempts: 3,
      job_payload_schema_version: 1, payload_sha256: "b".repeat(64), mutex_id: null };
    expect(ReviewJobV1.parse(base).mutex_id).toBeNull();
  });

  it("rejects a non-integer job_payload_schema_version", () => {
    const base = { job_id: crypto.randomUUID(), run_id: crypto.randomUUID(), review_id: crypto.randomUUID(),
      installation_id: crypto.randomUUID(), state: "ready", priority: 0, attempts: 0, max_attempts: 3,
      job_payload_schema_version: 1.5, payload_sha256: "c".repeat(64) };
    expect(() => ReviewJobV1.parse(base)).toThrow();
  });
});
