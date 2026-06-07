/**
 * Unit tests for the TS confluence-token metric helpers — the 1:1 port of
 * `vendor/codemaster-py/codemaster/observability/confluence_token_metrics.py`.
 *
 * The OTel meter seam (`#platform/observability/metrics.js::getMeter`) returns a NO-OP Meter when no
 * MeterProvider is registered, so emission is structurally safe before the exporter is wired. These
 * tests therefore assert the SHAPE the module exposes (names + functions don't throw + the injectable
 * clock drives the age-gauge snapshot), not exported metric values — matching how the sibling
 * reconcile/finding-lifecycle metric modules are covered.
 */

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import {
  AGE_SECONDS_NAME,
  ENV_FALLBACK_NAME,
  LAST_REFRESH_TIMESTAMP_NAME,
  observeAgeSecondsForTest,
  recordEnvFallbackUsed,
  recordRefresh,
  REFRESH_TOTAL_NAME,
  resetForTests,
  setClockForTests,
  updateAgeGauge,
} from "#backend/observability/confluence_token_metrics.js";

describe("confluence_token_metrics — metric names (Grafana-stable; verbatim from Python)", () => {
  it("matches the frozen Python constant strings", () => {
    expect(REFRESH_TOTAL_NAME).toBe("codemaster_confluence_token_refresh_total");
    expect(ENV_FALLBACK_NAME).toBe("codemaster_confluence_token_env_fallback_used_total");
    expect(AGE_SECONDS_NAME).toBe("codemaster_confluence_token_age_seconds");
    expect(LAST_REFRESH_TIMESTAMP_NAME).toBe("codemaster_confluence_token_last_refresh_timestamp");
  });
});

describe("confluence_token_metrics — emit functions are no-throw before exporter wiring", () => {
  it("record_refresh accepts success/failure and ignores an unexpected outcome", () => {
    resetForTests();
    expect(() => recordRefresh({ outcome: "success" })).not.toThrow();
    expect(() => recordRefresh({ outcome: "failure" })).not.toThrow();
    // Unexpected outcome is ignored (1:1 with the Python guard) — no throw.
    expect(() => recordRefresh({ outcome: "bogus" })).not.toThrow();
  });

  it("record_env_fallback_used + update_age_gauge are no-throw", () => {
    resetForTests();
    expect(() => recordEnvFallbackUsed()).not.toThrow();
    expect(() => updateAgeGauge({ refreshTimestamp: 1_700_000_000 })).not.toThrow();
  });
});

describe("confluence_token_metrics — age gauge observation", () => {
  it("computes monotone-increasing age from the latest refresh timestamp via the injected clock", () => {
    resetForTests();
    const clock = new FakeClock({ now: new Date("2026-06-03T00:00:00.000Z") });
    setClockForTests(clock);

    // Before any refresh → no observation.
    expect(observeAgeSecondsForTest()).toEqual([]);

    // Record a refresh at "now"; age starts at ~0.
    const refreshTs = clock.now().getTime() / 1000;
    updateAgeGauge({ refreshTimestamp: refreshTs });
    expect(observeAgeSecondsForTest()).toEqual([0]);

    // 90s later, age is 90.
    clock.advance({ seconds: 90 });
    expect(observeAgeSecondsForTest()).toEqual([90]);
  });

  it("reset clears the latest snapshot", () => {
    resetForTests();
    const clock = new FakeClock();
    setClockForTests(clock);
    updateAgeGauge({ refreshTimestamp: clock.now().getTime() / 1000 });
    resetForTests();
    setClockForTests(clock);
    expect(observeAgeSecondsForTest()).toEqual([]);
  });
});
