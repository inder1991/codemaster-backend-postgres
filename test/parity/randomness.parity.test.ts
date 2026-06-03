// THE PROOF: drive identical ordered call-lists through the TS SeededRandom and the frozen Python
// SeededRandom and assert bit-exact agreement. random()/uniform() are compared via their IEEE-754
// byte patterns (no decimal rounding), so any divergence in seeding or the Mersenne-Twister stream
// shows up immediately. uniform(-1, 1) is the embeddings_port-load-bearing path.
import { afterAll, describe, expect, it } from "vitest";

import { FakeClock } from "../../libs/platform/src/clock.js";
import { SeededRandom, uuid7 } from "../../libs/platform/src/randomness.js";
import {
  doubleToHex,
  seededRef,
  shutdownRandomRef,
  uuid7Ref,
  type SeededCall,
} from "./random_oracle.js";

afterAll(() => shutdownRandomRef());

const SEEDS = [0, 1, 42, 2024, 4_294_967_295] as const;
const CHOICE_POOL = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] as const;

/** Build the SAME ordered call-list both impls will replay, interleaving methods so the test proves
 * cross-method stream consistency (the MT stream is shared across all methods, not per-method). */
function buildCallList(): ReadonlyArray<SeededCall> {
  const calls: Array<SeededCall> = [];
  // 20x random() — bit-exact float comparison.
  for (let n = 0; n < 20; n++) calls.push({ m: "random" });
  // 20x randint over a wide non-negative range and 20x over a signed range.
  for (let n = 0; n < 20; n++) calls.push({ m: "randint", a: 0, b: 1_000_000 });
  for (let n = 0; n < 20; n++) calls.push({ m: "randint", a: -50, b: 50 });
  // 20x uniform(-1, 1) — the embeddings_port vector path; MUST be bit-exact.
  for (let n = 0; n < 20; n++) calls.push({ m: "uniform", a: -1, b: 1 });
  // choice / shuffle / token_bytes interleaved to prove the stream stays in lockstep across kinds.
  for (let n = 0; n < 10; n++) calls.push({ m: "choice", seq: CHOICE_POOL });
  calls.push({ m: "shuffle", seq: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] });
  calls.push({ m: "token_bytes", n: 32 });
  // randint(0, 2) repeated forces the _randbelow rejection-sampling path (getrandbits(2) >= 3 retry).
  for (let n = 0; n < 20; n++) calls.push({ m: "randint", a: 0, b: 2 });
  return calls;
}

/** Replay a call-list on the TS SeededRandom and encode results the same way the Python driver does. */
function runTs(seed: number, calls: ReadonlyArray<SeededCall>): ReadonlyArray<Record<string, unknown>> {
  const rng = new SeededRandom({ seed });
  return calls.map((call) => {
    switch (call.m) {
      case "random":
        return { f: doubleToHex(rng.random()) };
      case "uniform":
        return { f: doubleToHex(rng.uniform(call.a, call.b)) };
      case "randint":
        return { i: rng.randint(call.a, call.b) };
      case "choice":
        return { c: rng.choice(call.seq) };
      case "shuffle": {
        const copy = [...call.seq];
        rng.shuffle(copy);
        return { s: copy };
      }
      case "token_bytes":
        return { b: Buffer.from(rng.tokenBytes(call.n)).toString("hex") };
    }
  });
}

describe("SeededRandom ↔ frozen Python random.Random bit-exact parity", () => {
  for (const seed of SEEDS) {
    it(`should match the frozen Python stream bit-for-bit when seeded with ${seed}`, async () => {
      const calls = buildCallList();
      const py = await seededRef({ seed, calls });
      const ts = runTs(seed, calls);

      expect(ts.length).toBe(py.length);
      for (let idx = 0; idx < calls.length; idx++) {
        // Compare the encoded results structurally; floats are already hex so this is bit-exact.
        expect(ts[idx], `call #${idx} (${calls[idx]!.m}) diverged at seed ${seed}`).toEqual(py[idx]);
      }
    }, 30_000);
  }

  it("should drive the embeddings_port uniform(-1, 1) path bit-for-bit (1024-wide vector)", async () => {
    // Mirrors RecordingEmbeddingsClient: a fresh SeededRandom per text, 1024 uniform draws.
    const seed = 12_345;
    const calls: ReadonlyArray<SeededCall> = Array.from({ length: 1024 }, () => ({
      m: "uniform" as const,
      a: -1,
      b: 1,
    }));
    const py = await seededRef({ seed, calls });
    const ts = runTs(seed, calls);
    expect(ts).toEqual(py);
  }, 30_000);
});

describe("uuid7 ↔ frozen Python uuid7 timestamp-prefix parity", () => {
  // Whole-second instants -> zero float ambiguity in int(now.timestamp() * 1000).
  const INSTANTS = [0, 1_000_000_000_000, 1_735_689_600_000] as const;

  for (const ms of INSTANTS) {
    it(`should share the 48-bit timestamp prefix + version + variant with Python at ms=${ms}`, async () => {
      const tsUuid = uuid7({ clock: new FakeClock({ now: new Date(ms) }) });
      const pyUuid = (await uuid7Ref({ ms })).uuid;

      const tsHex = tsUuid.replaceAll("-", "");
      const pyHex = pyUuid.replaceAll("-", "");

      // First 12 hex = 48-bit Unix-ms timestamp prefix — deterministic from `ms`.
      expect(tsHex.slice(0, 12)).toBe(pyHex.slice(0, 12));
      // Version nibble (hex index 12) is "7" on both.
      expect(tsHex[12]).toBe("7");
      expect(pyHex[12]).toBe("7");
      // Variant high bits 0b10: hex index 16 nibble & 0xc === 0x8 on both.
      expect(Number.parseInt(tsHex[16]!, 16) & 0xc).toBe(0x8);
      expect(Number.parseInt(pyHex[16]!, 16) & 0xc).toBe(0x8);

      // The 74 random bits use crypto (NOT seeded) on both sides, so the tails MUST differ by design
      // (run_id is ephemeral execution identity, parity-excluded by value).
      expect(tsHex.slice(13)).not.toBe(pyHex.slice(13));
    }, 30_000);
  }
});
