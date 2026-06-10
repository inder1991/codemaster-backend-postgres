// Phase 3a W3: computeNextRun — the PURE cadence arithmetic of the Postgres scheduler that replaces
// Temporal Schedules. No clock read happens inside computeNextRun: the `after` instant is passed in
// by the caller (pollAndEnqueue threads clock.now()), so every case here is fully deterministic.
//
//   * interval: cadence_spec is an integer number of seconds → `after` + that many seconds.
//   * cron: ONLY the daily "M H * * *" shape is supported — the next UTC instant at H:M STRICTLY
//     after `after` (today if H:M is still ahead, else tomorrow). Every other cron shape (lists,
//     ranges, steps, non-* in fields 3-5, wrong field count, out-of-range M/H) THROWS the
//     deliberate-extension error so new shapes are added consciously, never half-parsed.
import { describe, expect, it } from "vitest";
import { computeNextRun } from "#backend/runner/scheduler.js";

const at = (iso: string): Date => new Date(iso);

describe("computeNextRun — interval cadence", () => {
  it("adds the integer number of seconds to `after`", () => {
    expect(computeNextRun("interval", "300", at("2026-06-10T12:00:00.000Z")))
      .toEqual(at("2026-06-10T12:05:00.000Z"));
    expect(computeNextRun("interval", "1", at("2026-06-10T23:59:59.000Z")))
      .toEqual(at("2026-06-11T00:00:00.000Z")); // rolls the UTC day
    expect(computeNextRun("interval", "86400", at("2026-12-31T06:00:00.000Z")))
      .toEqual(at("2027-01-01T06:00:00.000Z")); // rolls the year
  });

  it("preserves sub-second precision of `after` (pure shift — no truncation)", () => {
    expect(computeNextRun("interval", "60", at("2026-06-10T12:00:00.250Z")))
      .toEqual(at("2026-06-10T12:01:00.250Z"));
  });

  it.each(["abc", "1.5", "0", "-300", "", " 300", "300 ", "+300", "1e3"])(
    "THROWS on non-positive-integer interval spec %j",
    (spec) => {
      expect(() => computeNextRun("interval", spec, at("2026-06-10T12:00:00.000Z")))
        .toThrow(`unsupported interval spec: ${spec} (expected a positive integer number of seconds)`);
    },
  );
});

describe('computeNextRun — daily cron "M H * * *"', () => {
  it("returns TODAY at H:M when it is still ahead of `after` (just-before boundary)", () => {
    expect(computeNextRun("cron", "30 5 * * *", at("2026-06-10T05:29:59.999Z")))
      .toEqual(at("2026-06-10T05:30:00.000Z"));
    expect(computeNextRun("cron", "0 12 * * *", at("2026-06-10T00:00:00.000Z")))
      .toEqual(at("2026-06-10T12:00:00.000Z"));
  });

  it("returns TOMORROW when `after` is EXACTLY H:M (strictly-after contract)", () => {
    expect(computeNextRun("cron", "30 5 * * *", at("2026-06-10T05:30:00.000Z")))
      .toEqual(at("2026-06-11T05:30:00.000Z"));
  });

  it("returns TOMORROW when `after` is just past H:M (just-after boundary)", () => {
    expect(computeNextRun("cron", "30 5 * * *", at("2026-06-10T05:30:00.001Z")))
      .toEqual(at("2026-06-11T05:30:00.000Z"));
    // seconds within the H:M minute also count as "past" — the schedule instant is H:M:00.000.
    expect(computeNextRun("cron", "30 5 * * *", at("2026-06-10T05:30:25.000Z")))
      .toEqual(at("2026-06-11T05:30:00.000Z"));
  });

  it("rolls over month / year / leap-day boundaries via UTC date arithmetic", () => {
    expect(computeNextRun("cron", "0 0 * * *", at("2026-06-30T23:59:59.000Z")))
      .toEqual(at("2026-07-01T00:00:00.000Z")); // June has 30 days
    expect(computeNextRun("cron", "30 22 * * *", at("2026-12-31T23:00:00.000Z")))
      .toEqual(at("2027-01-01T22:30:00.000Z")); // year rollover
    expect(computeNextRun("cron", "0 0 * * *", at("2028-02-28T23:59:59.000Z")))
      .toEqual(at("2028-02-29T00:00:00.000Z")); // 2028 is a leap year
  });

  it("accepts boundary minutes/hours (0 0 / 59 23) and leading zeros", () => {
    expect(computeNextRun("cron", "0 0 * * *", at("2026-06-09T23:59:59.999Z")))
      .toEqual(at("2026-06-10T00:00:00.000Z"));
    expect(computeNextRun("cron", "59 23 * * *", at("2026-06-10T23:58:00.000Z")))
      .toEqual(at("2026-06-10T23:59:00.000Z"));
    expect(computeNextRun("cron", "05 04 * * *", at("2026-06-10T00:00:00.000Z")))
      .toEqual(at("2026-06-10T04:05:00.000Z"));
  });

  it("zeroes seconds + milliseconds on the returned instant", () => {
    const next = computeNextRun("cron", "15 6 * * *", at("2026-06-10T06:14:59.123Z"));
    expect(next.getUTCSeconds()).toBe(0);
    expect(next.getUTCMilliseconds()).toBe(0);
  });

  it.each([
    "*/5 * * * *", // step
    "0 1,2 * * *", // list
    "0-30 5 * * *", // range
    "30 5 1 * *", // non-* day-of-month
    "30 5 * 6 *", // non-* month
    "30 5 * * 1", // non-* day-of-week
    "60 5 * * *", // minute out of range
    "30 24 * * *", // hour out of range
    "-1 5 * * *", // negative minute
    "* 5 * * *", // wildcard minute (every minute of the hour — NOT daily)
    "30 5 * *", // 4 fields
    "30 5 * * * *", // 6 fields
    "30  5 * * *", // double space (not the literal "M H * * *" shape)
    "", // empty
  ])("THROWS the deliberate-extension error on unsupported cron shape %j", (spec) => {
    expect(() => computeNextRun("cron", spec, at("2026-06-10T12:00:00.000Z")))
      .toThrow(`unsupported cron spec: ${spec} (only "M H * * *" daily supported)`);
  });
});

describe("computeNextRun — cadence-kind guard", () => {
  it("THROWS on an unknown cadence_kind (ck_scheduled_jobs_cadence_kind should prevent it; fail loud on drift)", () => {
    expect(() => computeNextRun("rrule" as never, "x", at("2026-06-10T12:00:00.000Z")))
      .toThrow(/unsupported cadence_kind/);
  });
});
