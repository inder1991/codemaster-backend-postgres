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
});
