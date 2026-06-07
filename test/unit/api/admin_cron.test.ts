// Unit tests for the structural cron validator backing the notification-rule write contracts.
// NOTE: structural (not croniter-exact) — it accepts standard grammar and rejects malformed input; it does
// NOT bound numeric ranges (e.g. '99 9 * * *' is structurally accepted). See the divergence note in admin.v1.ts.

import { describe, expect, it } from "vitest";

import { isValidCron } from "#contracts/admin.v1.js";

describe("isValidCron (structural; notification-rule schedule_cron)", () => {
  it("accepts standard 5/6-field expressions, steps, ranges, lists, names, and @macros", () => {
    for (const c of [
      "0 9 * * *",
      "*/15 0 * * 1-5",
      "0,30 8-17 * * *",
      "0 0 1 1 *",
      "*/15 * * * MON-FRI",
      "* * * * * *", // 6-field (with seconds)
      "@daily",
      "@HOURLY",
      "@yearly",
    ]) {
      expect(isValidCron(c), c).toBe(true);
    }
  });

  it("rejects empty, wrong field count, bad macros, and illegal atoms", () => {
    for (const c of ["", "   ", "hello", "0 9 * *", "0 9 * * * * *", "@bogus", "a b c d e"]) {
      expect(isValidCron(c), c).toBe(false);
    }
  });
});
