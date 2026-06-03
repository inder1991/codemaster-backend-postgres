/**
 * Clock seam — 1:1 port of `codemaster/infra/clock.py` (frozen Python, Sprint 0 / Story S0.5b).
 *
 * Production code MUST NOT call `Date.now()`, `new Date()` (zero-arg), `performance.now()`,
 * `process.hrtime(...)`, or `setTimeout` for time directly. Use the injected {@link Clock}
 * instead. The CI gate `scripts/gates/check_clock_random.ts` enforces this and allowlists
 * THIS file as the one place those raw constructs are sanctioned (mirroring the Python gate
 * `scripts/no_wall_clock.py`).
 *
 * Why: every test in every sprint must be deterministic with respect to time. A {@link FakeClock}
 * with `.advance()` makes time-bound tests fast and reliable.
 */

/**
 * A clock interface for time-aware code paths.
 *
 * `Date` is the TypeScript analogue of Python's tz-aware UTC `datetime`: a `Date` is an absolute
 * UTC instant, so `now()` here mirrors `datetime.now(tz=UTC)`. `monotonic()` is in SECONDS to
 * match Python's `time.monotonic()`.
 */
export type Clock = {
  /** Wall-clock UTC instant. */
  now(): Date;
  /** Monotonic time in seconds (for measuring durations). */
  monotonic(): number;
  /** Async sleep. Tests can intercept and advance the clock. */
  sleep(seconds: number): Promise<void>;
};

/** Production implementation. Uses real wall and monotonic clocks. */
export class WallClock implements Clock {
  public now(): Date {
    return new Date();
  }

  public monotonic(): number {
    // `performance.now()` is milliseconds; Python `time.monotonic()` is seconds — divide to match.
    return performance.now() / 1000;
  }

  public async sleep(seconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, seconds * 1000);
    });
  }
}

/**
 * Test implementation. Time advances only when explicitly told to.
 *
 * @example
 * ```ts
 * const clock = new FakeClock({ now: new Date("2026-05-01T00:00:00.000Z") });
 * // ... call code under test ...
 * clock.advance({ seconds: 60 }); // 1 minute later
 * // ... assert code observed time movement ...
 * ```
 *
 * 1:1 divergence from the Python `FakeClock`: the Python version raises on a tz-naive `datetime`
 * (`now.tzinfo is None`). A JS `Date` has no tz-naive concept — it is always an absolute UTC
 * instant — so that guard is N/A here and is intentionally omitted.
 */
export class FakeClock implements Clock {
  // Wall instant stored as epoch-ms (the absolute-instant primitive); `now()` rebuilds a fresh
  // Date from it each call so callers can never alias / mutate our internal state.
  private nowMs: number;
  private monotonicSeconds: number;
  private readonly sleeps: Array<number> = [];

  public constructor({ now, monotonicStart }: { now?: Date; monotonicStart?: number } = {}) {
    // Default mirrors Python `datetime(2026, 1, 1, tzinfo=UTC)`.
    this.nowMs = (now ?? new Date("2026-01-01T00:00:00.000Z")).getTime();
    this.monotonicSeconds = monotonicStart ?? 0;
  }

  public now(): Date {
    // New Date every call — no shared mutable Date leak.
    return new Date(this.nowMs);
  }

  public monotonic(): number {
    return this.monotonicSeconds;
  }

  public async sleep(seconds: number): Promise<void> {
    // Record but do not actually sleep — and do NOT advance. Tests advance the clock explicitly.
    this.sleeps.push(seconds);
  }

  // Test-only API -------------------------------------------------

  /** Jump the wall clock to a new instant (does not touch the monotonic axis). */
  public set({ now }: { now: Date }): void {
    this.nowMs = now.getTime();
  }

  /** Advance BOTH the wall instant and the monotonic clock by `seconds`. */
  public advance({ seconds }: { seconds: number }): void {
    this.nowMs += seconds * 1000;
    this.monotonicSeconds += seconds;
  }

  /** Return durations passed to {@link sleep} since construction, in order. */
  public recordedSleeps(): ReadonlyArray<number> {
    return [...this.sleeps];
  }
}
