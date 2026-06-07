// Unit tests for the cost-cap lowering-grace logic (pure) — 1:1 with compute_applied_at / _next_midnight_utc.

import { describe, expect, it } from "vitest";

import { computeAppliedAt, nextMidnightUtc } from "#backend/api/admin/cost_caps_write.js";

describe("cost-cap lowering grace (parity with compute_applied_at)", () => {
  it("nextMidnightUtc: strictly-later 00:00 UTC (midnight input → +24h)", () => {
    expect(nextMidnightUtc(new Date("2026-06-07T12:34:56.789Z")).toISOString()).toBe("2026-06-08T00:00:00.000Z");
    expect(nextMidnightUtc(new Date("2026-06-07T00:00:00.000Z")).toISOString()).toBe("2026-06-08T00:00:00.000Z");
  });

  it("raises take effect immediately (new >= current → approvedAt)", () => {
    const approved = new Date("2026-06-07T12:00:00.000Z");
    expect(computeAppliedAt({ newCapCents: 1000, currentCapCents: 500, approvedAt: approved })).toEqual(approved);
    expect(computeAppliedAt({ newCapCents: 500, currentCapCents: 500, approvedAt: approved })).toEqual(approved); // equal = raise
  });

  it("lowers wait for max(approvedAt + grace, next_midnight_utc)", () => {
    // midday lower: grace floor (13:00) < next midnight → next midnight wins
    expect(
      computeAppliedAt({ newCapCents: 100, currentCapCents: 500, approvedAt: new Date("2026-06-07T12:00:00.000Z") }).toISOString(),
    ).toBe("2026-06-08T00:00:00.000Z");
    // late-night lower: grace floor (00:30 next day) > next midnight (00:00) → grace floor wins
    expect(
      computeAppliedAt({ newCapCents: 100, currentCapCents: 500, approvedAt: new Date("2026-06-07T23:45:00.000Z") }).toISOString(),
    ).toBe("2026-06-08T00:45:00.000Z");
  });
});
