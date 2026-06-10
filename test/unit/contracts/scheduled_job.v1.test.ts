// Phase 3a W1: ScheduledJobV1 — the row contract for core.scheduled_jobs (migration 0040), the
// Postgres scheduler replacing Temporal Schedules. cadence_kind is the 2-value vocabulary
// ('cron' | 'interval' — DB CHECK ck_scheduled_jobs_cadence_kind); overlap_policy mirrors the DB
// (text, default 'skip' — 'skip' is the only Wave-3-implemented policy, no DB CHECK so the contract
// stays string-typed to avoid contract-stricter-than-DB read crashes on operator-edited rows).
import { describe, expect, it } from "vitest";
import { ScheduledJobV1, CADENCE_KINDS } from "#contracts/scheduled_job.v1.js";

function validRow(): Record<string, unknown> {
  return {
    schedule_id: "mark-stale-chunks-hourly",
    job_type: "mark_stale_chunks",
    cadence_kind: "cron",
    cadence_spec: "0 * * * *",
    input: {},
    overlap_policy: "skip",
    enabled: true,
    next_run_at: new Date("2026-06-10T01:00:00Z"),
    last_enqueued_at: null,
    created_at: new Date("2026-06-10T00:00:00Z"),
    updated_at: new Date("2026-06-10T00:00:00Z"),
  };
}

describe("ScheduledJobV1", () => {
  it("parses a valid cron row round-trip (defaults schema_version=1)", () => {
    const parsed = ScheduledJobV1.parse(validRow());
    expect(parsed.schema_version).toBe(1);
    expect(parsed.schedule_id).toBe("mark-stale-chunks-hourly");
    expect(parsed.job_type).toBe("mark_stale_chunks");
    expect(parsed.cadence_kind).toBe("cron");
    expect(parsed.cadence_spec).toBe("0 * * * *");
    expect(parsed.input).toEqual({});
    expect(parsed.overlap_policy).toBe("skip");
    expect(parsed.enabled).toBe(true);
    expect(parsed.next_run_at).toEqual(new Date("2026-06-10T01:00:00Z"));
    expect(parsed.last_enqueued_at).toBeNull();
  });

  it("parses an interval row with a populated last_enqueued_at (ISO-string dates coerce)", () => {
    const parsed = ScheduledJobV1.parse({
      ...validRow(),
      schedule_id: "partition-maintenance-6h",
      cadence_kind: "interval",
      cadence_spec: "21600",
      last_enqueued_at: "2026-06-09T18:00:00Z", // JSON wire shape — must coerce like the pg Date shape
      input: { retention_days: 30 },
    });
    expect(parsed.cadence_kind).toBe("interval");
    expect(parsed.last_enqueued_at).toEqual(new Date("2026-06-09T18:00:00Z"));
    expect(parsed.input).toEqual({ retention_days: 30 });
  });

  it("rejects a cadence_kind outside the 2-value vocabulary", () => {
    expect(CADENCE_KINDS).toEqual(["cron", "interval"]);
    expect(() => ScheduledJobV1.parse({ ...validRow(), cadence_kind: "rrule" })).toThrow();
  });

  it("rejects an empty schedule_id / job_type / cadence_spec", () => {
    expect(() => ScheduledJobV1.parse({ ...validRow(), schedule_id: "" })).toThrow();
    expect(() => ScheduledJobV1.parse({ ...validRow(), job_type: "" })).toThrow();
    expect(() => ScheduledJobV1.parse({ ...validRow(), cadence_spec: "" })).toThrow();
  });
});
