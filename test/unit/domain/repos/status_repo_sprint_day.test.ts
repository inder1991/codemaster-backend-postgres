import { describe, expect, it } from "vitest";

import { computeSprintDay } from "#backend/domain/repos/status_repo.js";

describe("computeSprintDay (days since most-recent Monday, clamped 1..14)", () => {
  it("Monday is day 1", () => {
    // 2026-06-08 is a Monday (UTC)
    expect(computeSprintDay(new Date("2026-06-08T09:00:00.000Z"))).toBe(1);
  });
  it("Wednesday of the same week is day 3", () => {
    expect(computeSprintDay(new Date("2026-06-10T23:59:00.000Z"))).toBe(3);
  });
  it("Sunday counts back to that week's Monday (day 7)", () => {
    expect(computeSprintDay(new Date("2026-06-14T00:00:00.000Z"))).toBe(7);
  });
  it("an explicit sprintStart far in the past clamps to 14", () => {
    expect(
      computeSprintDay(new Date("2026-06-08T00:00:00.000Z"), new Date("2026-05-01T00:00:00.000Z")),
    ).toBe(14);
  });
});
