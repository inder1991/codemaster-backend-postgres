import { describe, it, expect } from "vitest";

import { WallClock, FakeClock } from "../../../libs/platform/src/clock.js";

describe("WallClock", () => {
  it("should return a Date close to real now when now() is called", () => {
    const clock = new WallClock();

    const observed = clock.now();

    // Within a few seconds of the harness's own wall clock — proves it reads the real clock.
    const driftMs = Math.abs(observed.getTime() - Date.now());
    expect(driftMs).toBeLessThan(5000);
  });

  it("should be non-decreasing across two reads when monotonic() is called twice", () => {
    const clock = new WallClock();

    const first = clock.monotonic();
    const second = clock.monotonic();

    expect(second).toBeGreaterThanOrEqual(first);
  });
});

describe("FakeClock", () => {
  it("should default now() to 2026-01-01T00:00:00.000Z when no now is supplied", () => {
    const clock = new FakeClock();

    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("should default monotonic() to 0 when no start is supplied", () => {
    const clock = new FakeClock();

    expect(clock.monotonic()).toBe(0);
  });

  it("should honor an explicit constructor now and monotonicStart", () => {
    const clock = new FakeClock({ now: new Date("2030-03-15T12:00:00.000Z"), monotonicStart: 5 });

    expect(clock.now().toISOString()).toBe("2030-03-15T12:00:00.000Z");
    expect(clock.monotonic()).toBe(5);
  });

  it("should not move now() when nothing advances the clock", () => {
    const clock = new FakeClock();

    const before = clock.now().toISOString();
    const after = clock.now().toISOString();

    expect(after).toBe(before);
    expect(after).toBe("2026-01-01T00:00:00.000Z");
  });

  it("should move now() forward by 60s AND monotonic() by 60 when advance({seconds:60})", () => {
    const clock = new FakeClock();

    clock.advance({ seconds: 60 });

    expect(clock.now().toISOString()).toBe("2026-01-01T00:01:00.000Z");
    expect(clock.monotonic()).toBe(60);
  });

  it("should jump the wall clock without touching monotonic when set({now}) is called", () => {
    const clock = new FakeClock();

    clock.set({ now: new Date("2030-03-15T12:00:00.000Z") });

    expect(clock.now().toISOString()).toBe("2030-03-15T12:00:00.000Z");
    // set() is a wall-clock jump only — monotonic is a separate duration axis and stays put.
    expect(clock.monotonic()).toBe(0);
  });

  it("should record sleep durations in order without advancing the clock when sleep() is awaited", async () => {
    const clock = new FakeClock();

    await clock.sleep(1.5);
    await clock.sleep(2);

    expect(clock.recordedSleeps()).toEqual([1.5, 2]);
    // Recording is not advancing — both axes are untouched by sleep().
    expect(clock.monotonic()).toBe(0);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("should return equal-but-distinct Date objects (no aliasing) when now() is called twice", () => {
    const clock = new FakeClock();

    const a = clock.now();
    const b = clock.now();

    expect(a.getTime()).toBe(b.getTime());
    // Mutating one returned Date must NOT leak into the clock's internal state or the other read.
    expect(a).not.toBe(b);
    a.setTime(0);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});
