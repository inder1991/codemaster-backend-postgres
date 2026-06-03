// Behavior tests for the randomness seam: SeededRandom determinism + range/permutation invariants,
// uuid7 structural layout, and SystemRandom range/length behavior. Bit-exact parity vs the frozen
// Python lives in test/parity/randomness.parity.test.ts; this file asserts the local contract.
import { describe, it, expect } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { SeededRandom, SystemRandom, uuid7 } from "#platform/randomness.js";

describe("SeededRandom", () => {
  it("should produce identical sequences when seeded with the same value", () => {
    const a = new SeededRandom({ seed: 42 });
    const b = new SeededRandom({ seed: 42 });

    const seqA = Array.from({ length: 10 }, () => a.random());
    const seqB = Array.from({ length: 10 }, () => b.random());

    expect(seqA).toEqual(seqB);
  });

  it("should produce different sequences when seeded with different values", () => {
    const a = new SeededRandom({ seed: 42 });
    const b = new SeededRandom({ seed: 43 });

    const seqA = Array.from({ length: 10 }, () => a.random());
    const seqB = Array.from({ length: 10 }, () => b.random());

    expect(seqA).not.toEqual(seqB);
  });

  it("should return random() floats in [0, 1)", () => {
    const rng = new SeededRandom({ seed: 7 });

    for (let n = 0; n < 100; n++) {
      const x = rng.random();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("should return randint within [a, b] inclusive", () => {
    const rng = new SeededRandom({ seed: 99 });

    for (let n = 0; n < 200; n++) {
      const x = rng.randint(-5, 5);
      expect(x).toBeGreaterThanOrEqual(-5);
      expect(x).toBeLessThanOrEqual(5);
      expect(Number.isInteger(x)).toBe(true);
    }
  });

  it("should return a member of the sequence from choice", () => {
    const rng = new SeededRandom({ seed: 3 });
    const pool = ["a", "b", "c", "d"] as const;

    for (let n = 0; n < 50; n++) {
      expect(pool).toContain(rng.choice(pool));
    }
  });

  it("should shuffle into a permutation preserving the multiset", () => {
    const rng = new SeededRandom({ seed: 11 });
    const original = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const shuffled = [...original];

    rng.shuffle(shuffled);

    expect([...shuffled].sort((x, y) => x - y)).toEqual(original);
  });

  it("should return tokenBytes of the requested length", () => {
    const rng = new SeededRandom({ seed: 5 });

    expect(rng.tokenBytes(0)).toHaveLength(0);
    expect(rng.tokenBytes(16)).toHaveLength(16);
    expect(rng.tokenBytes(32)).toHaveLength(32);
  });
});

describe("uuid7", () => {
  it("should return a canonical lowercase 8-4-4-4-12 hyphenated string", () => {
    const u = uuid7({ clock: new FakeClock({ now: new Date(1_735_689_600_000) }) });

    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(u).toBe(u.toLowerCase());
  });

  it("should set the version nibble to 7 (hex index 14, accounting for the first hyphen)", () => {
    const u = uuid7({ clock: new FakeClock({ now: new Date(0) }) });

    // The 13th hex digit lives at string index 14 because index 8 is a hyphen.
    expect(u[14]).toBe("7");
  });

  it("should set the RFC 9562 variant high bits to 0b10", () => {
    const u = uuid7({ clock: new FakeClock({ now: new Date(0) }) });

    // The 17th hex nibble (string index 19, after three hyphens) has high bits 0b10 -> nibble & 0xc === 0x8.
    expect(Number.parseInt(u[19]!, 16) & 0xc).toBe(0x8);
  });

  it("should encode the timestamp prefix as the truncated Unix-ms value", () => {
    const ms = 1_735_689_600_000;
    const clock = new FakeClock({ now: new Date(ms) });

    const u = uuid7({ clock });

    const expectedPrefix = Math.trunc(clock.now().getTime()).toString(16).padStart(12, "0");
    expect(u.replaceAll("-", "").slice(0, 12)).toBe(expectedPrefix);
  });

  it("should share the timestamp prefix but differ overall for two calls at the same instant", () => {
    const clock = new FakeClock({ now: new Date(1_735_689_600_000) });

    const a = uuid7({ clock });
    const b = uuid7({ clock });

    // First 12 hex (timestamp prefix) match; the random tails keep them distinct.
    expect(a.replaceAll("-", "").slice(0, 12)).toBe(b.replaceAll("-", "").slice(0, 12));
    expect(a).not.toBe(b);
  });
});

describe("SystemRandom", () => {
  it("should return random() floats in [0, 1)", () => {
    const rng = new SystemRandom();

    for (let n = 0; n < 100; n++) {
      const x = rng.random();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("should return randint within [a, b] inclusive", () => {
    const rng = new SystemRandom();

    for (let n = 0; n < 200; n++) {
      const x = rng.randint(10, 20);
      expect(x).toBeGreaterThanOrEqual(10);
      expect(x).toBeLessThanOrEqual(20);
    }
  });

  it("should return tokenBytes of the requested length", () => {
    const rng = new SystemRandom();

    expect(rng.tokenBytes(24)).toHaveLength(24);
  });
});
