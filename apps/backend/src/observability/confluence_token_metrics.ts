/**
 * Confluence-token OTel metric helpers. Module-level lazy instrument construction through the
 * `#platform/observability/metrics.js::getMeter` seam (a NO-OP Meter when no MeterProvider is
 * registered, so emission is safe before the exporter is wired), bounded-cardinality labels,
 * fail-quietly.
 *
 * Cardinality discipline: `outcome` ∈ {success, failure} (2 values). NO installation_id / tenant labels.
 *
 * Clock note: the wall-time read for the age gauge routes through an injected {@link Clock} (default
 * {@link WallClock}; the check_clock_random gate bans raw `Date`). Tests set a {@link FakeClock} via
 * {@link setClockForTests} for a deterministic, monotone-increasing age.
 */

import { type Clock, WallClock } from "#platform/clock.js";
import {
  getMeter,
  type Counter,
  type ObservableResult,
} from "#platform/observability/metrics.js";

// ─── Counter / gauge names (Grafana-query-stable; renaming requires ADR) ─────────────────────────

export const REFRESH_TOTAL_NAME = "codemaster_confluence_token_refresh_total";
export const ENV_FALLBACK_NAME = "codemaster_confluence_token_env_fallback_used_total";
export const AGE_SECONDS_NAME = "codemaster_confluence_token_age_seconds";
export const LAST_REFRESH_TIMESTAMP_NAME = "codemaster_confluence_token_last_refresh_timestamp";

// ─── Module-level instrument cache (lazy-init on first use) ──────────────────────────────────────

let refreshTotal: Counter | null = null;
let envFallback: Counter | null = null;
// Gauge values updated via callback; we hold the latest snapshot in module-level state and OTel reads
// them via observable-gauge callback.
let latestRefreshTimestamp = 0.0;
let gaugesRegistered = false;
// The injectable wall-clock seam for the age computation (default WallClock; FakeClock in tests).
let clock: Clock = new WallClock();

const METER_NAME = "codemaster.confluence_token";

/** Increment the refresh counter. `outcome` ∈ {success, failure}. */
export function recordRefresh({ outcome }: { outcome: string }): void {
  if (outcome !== "success" && outcome !== "failure") {
    // Unexpected outcome — ignore silently (no throw).
    return;
  }
  if (refreshTotal === null) {
    refreshTotal = getMeter(METER_NAME).createCounter(REFRESH_TOTAL_NAME);
  }
  refreshTotal.add(1, { outcome });
}

/**
 * Increment when the worker startup falls back to env vars instead of reading from Vault (1:1 with
 * `record_env_fallback_used`). Steady-state production = 0. Emitted by the worker-bootstrap layer (the
 * composition root), which is out of scope for this port — exported here for that caller to wire.
 */
export function recordEnvFallbackUsed(): void {
  if (envFallback === null) {
    envFallback = getMeter(METER_NAME).createCounter(ENV_FALLBACK_NAME);
  }
  envFallback.add(1, {});
}

/**
 * Update the latest-successful-refresh timestamp in module state. The observable gauges read this via
 * callback so OTel always reflects the freshest values without a producer loop. `refreshTimestamp` is
 * Unix epoch SECONDS.
 */
export function updateAgeGauge({ refreshTimestamp }: { refreshTimestamp: number }): void {
  latestRefreshTimestamp = refreshTimestamp;
  ensureGaugesRegistered();
}

/** Lazy-register the observable gauges with their callbacks. Idempotent. */
function ensureGaugesRegistered(): void {
  if (gaugesRegistered) return;
  const meter = getMeter(METER_NAME);
  meter
    .createObservableGauge(AGE_SECONDS_NAME)
    .addCallback((result) => observeAgeSeconds(result));
  meter
    .createObservableGauge(LAST_REFRESH_TIMESTAMP_NAME)
    .addCallback((result) => observeLastRefreshTimestamp(result));
  gaugesRegistered = true;
}

/**
 * OTel callback: compute age at observation time so the gauge is monotone-increasing between refreshes.
 * Emits nothing until the first refresh.
 */
function observeAgeSeconds(result: ObservableResult): void {
  if (latestRefreshTimestamp === 0.0) return;
  const age = clock.now().getTime() / 1000 - latestRefreshTimestamp;
  result.observe(age, {});
}

function observeLastRefreshTimestamp(result: ObservableResult): void {
  if (latestRefreshTimestamp === 0.0) return;
  result.observe(latestRefreshTimestamp, {});
}

// ─── Test-only API ────────────────────────────────────────────────────────────────────────────────

/** Test-only — reset module state between tests. */
export function resetForTests(): void {
  refreshTotal = null;
  envFallback = null;
  latestRefreshTimestamp = 0.0;
  gaugesRegistered = false;
  clock = new WallClock();
}

/** Test-only — inject a deterministic clock for the age-gauge computation. */
export function setClockForTests(c: Clock): void {
  clock = c;
}

/**
 * Test-only — drive the age-gauge callback and return the observed values (a deterministic oracle since
 * the no-op OTel Meter does not invoke the callback). Returns [] before the first refresh.
 */
export function observeAgeSecondsForTest(): ReadonlyArray<number> {
  const observed: Array<number> = [];
  observeAgeSeconds({ observe: (value: number) => observed.push(value) } as ObservableResult);
  return observed;
}
