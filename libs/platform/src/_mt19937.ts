/**
 * Internal MT19937 core — a faithful re-implementation of CPython's `_randommodule.c`
 * (the C `_random.Random` engine) plus the higher-level helpers from `Lib/random.py`.
 *
 * This is the engine that makes {@link SeededRandom} bit-for-bit identical to CPython's
 * `random.Random(seed)`: same `init_by_array` seeding, same `genrand_uint32` tempering, same
 * `genrand_res53` 53-bit double construction, and the same `_randbelow_with_getrandbits`
 * rejection sampling. The frozen Python `codemaster/adapters/embeddings_port.py` builds
 * deterministic vectors via `SeededRandom(seed=N).uniform(-1, 1)`, so any drift here would
 * silently corrupt those vectors — hence the cross-impl parity harness that pins it.
 *
 * State discipline: `mt` is a `Uint32Array(624)` and every write is masked back to uint32 via
 * `>>> 0`; the 32-bit multiplies use `Math.imul(...) >>> 0` because plain `*` overflows the
 * 53-bit float mantissa and would diverge from C's modular arithmetic.
 *
 * Internal infra (leading-underscore filename); not part of the public platform surface.
 */

/* eslint-disable security/detect-object-injection --
 * Every index here is a loop counter or an algorithm-derived offset into a fixed-size `Uint32Array`
 * (or a length-bounded shuffle index) — never an attacker-controlled object key. The rule's threat
 * model (untrusted property names reaching a prototype) does not apply to numeric typed-array access.
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000; // most significant w-r bits
const LOWER_MASK = 0x7fffffff; // least significant r bits

/** CPython's MT19937 engine, state-compatible with `random.Random` after seeding. */
export class Mt19937 {
  private readonly mt = new Uint32Array(N);
  private mti = N + 1;

  /** `init_genrand` — seed from a single uint32 (also used as the base for `init_by_array`). */
  private initGenrand(s: number): void {
    this.mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = this.mt[i - 1]!;
      // mt[i] = (1812433253 * (prev ^ (prev >> 30)) + i) mod 2^32
      this.mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.mti = N;
  }

  /** `init_by_array` — seed from a uint32 key array (CPython's path for integer seeds). */
  private initByArray(key: ReadonlyArray<number>): void {
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    let k = Math.max(N, key.length);
    for (; k; k--) {
      const prev = this.mt[i - 1]!;
      // mt[i] = (mt[i] ^ ((prev ^ (prev >> 30)) * 1664525)) + key[j] + j
      this.mt[i] = ((this.mt[i]! ^ Math.imul(prev ^ (prev >>> 30), 1664525)) + key[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1]!;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (k = N - 1; k; k--) {
      const prev = this.mt[i - 1]!;
      // mt[i] = (mt[i] ^ ((prev ^ (prev >> 30)) * 1566083941)) - i
      this.mt[i] = ((this.mt[i]! ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1]!;
        i = 1;
      }
    }
    this.mt[0] = 0x80000000; // MSB is 1, assuring a non-zero initial array
  }

  /**
   * Seed exactly as CPython `random_seed` does for a non-negative integer: take `abs(n)` and split
   * it into LITTLE-ENDIAN uint32 words, then run `init_by_array`. `n === 0` keys as `[0]`.
   */
  public seed(n: number | bigint): void {
    let v = typeof n === "bigint" ? (n < 0n ? -n : n) : BigInt(Math.abs(Math.trunc(n)));
    const key: Array<number> = [];
    if (v === 0n) {
      key.push(0);
    } else {
      while (v > 0n) {
        key.push(Number(v & 0xffffffffn));
        v >>= 32n;
      }
    }
    this.initByArray(key);
  }

  /** `genrand_uint32` — the tempered 32-bit output (regenerates the state vector as needed). */
  public genrandUint32(): number {
    if (this.mti >= N) {
      let y: number;
      for (let kk = 0; kk < N - M; kk++) {
        y = ((this.mt[kk]! & UPPER_MASK) | (this.mt[kk + 1]! & LOWER_MASK)) >>> 0;
        this.mt[kk] = (this.mt[kk + M]! ^ (y >>> 1) ^ ((y & 1) === 1 ? MATRIX_A : 0)) >>> 0;
      }
      for (let kk = N - M; kk < N - 1; kk++) {
        y = ((this.mt[kk]! & UPPER_MASK) | (this.mt[kk + 1]! & LOWER_MASK)) >>> 0;
        this.mt[kk] = (this.mt[kk + (M - N)]! ^ (y >>> 1) ^ ((y & 1) === 1 ? MATRIX_A : 0)) >>> 0;
      }
      y = ((this.mt[N - 1]! & UPPER_MASK) | (this.mt[0]! & LOWER_MASK)) >>> 0;
      this.mt[N - 1] = (this.mt[M - 1]! ^ (y >>> 1) ^ ((y & 1) === 1 ? MATRIX_A : 0)) >>> 0;
      this.mti = 0;
    }

    let y = this.mt[this.mti]!;
    this.mti++;
    // Tempering.
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /**
   * `genrand_res53` — a uniform double in [0, 1) with 53 bits of resolution, built from two
   * tempered uint32 words. This is exactly Python's `random()`, bit-for-bit (the IEEE-754 result
   * is identical because the arithmetic is exact in double precision).
   */
  public randomDouble(): number {
    const a = this.genrandUint32() >>> 5; // top 27 bits
    const b = this.genrandUint32() >>> 6; // top 26 bits
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  /**
   * `getrandbits(k)` — k uniformly random bits. Returns a `number` for `k <= 32` (the only width
   * the seam's `randint`/`token_bytes` consumers ever request) and a `bigint` for wider requests.
   */
  public getrandbits(k: number): number | bigint {
    if (k <= 32) {
      // For k == 32 this is `>>> 0` (the full word); for k < 32 it keeps the high k bits.
      return this.genrandUint32() >>> (32 - k);
    }
    let result = 0n;
    let shift = 0n;
    let remaining = k;
    while (remaining > 0) {
      const take = Math.min(remaining, 32);
      const word = this.genrandUint32() >>> (32 - take);
      result |= BigInt(word >>> 0) << shift;
      shift += 32n;
      remaining -= 32;
    }
    return result;
  }

  /**
   * `_randbelow_with_getrandbits(n)` — uniform integer in [0, n) via rejection sampling on
   * `getrandbits(bit_length(n))`. The bit length is computed by shifting (NOT `clz32` hand-waving)
   * so `n = 256` yields `k = 9` and `getrandbits(9) ∈ [0, 511]` with rejection of values ≥ 256 —
   * this MUST match CPython or `randint`/`token_bytes` diverge.
   */
  public randbelow(n: number): number {
    if (n <= 0) return 0;
    let k = 0;
    let t = n;
    while (t > 0) {
      t >>= 1;
      k++;
    }
    let r = this.getrandbits(k) as number;
    while (r >= n) {
      r = this.getrandbits(k) as number;
    }
    return r;
  }

  // Higher-level helpers used by SeededRandom -----------------------------

  /** Uniform integer in [a, b], inclusive (Python `randint`). */
  public randint(a: number, b: number): number {
    return a + this.randbelow(b - a + 1);
  }

  /** Uniform float in [a, b] (Python `uniform`: `a + (b - a) * random()`). */
  public uniform(a: number, b: number): number {
    return a + (b - a) * this.randomDouble();
  }

  /** Pick one element (Python `choice`: `seq[_randbelow(len(seq))]`). */
  public choice<T>(seq: ReadonlyArray<T>): T {
    return seq[this.randbelow(seq.length)]!;
  }

  /** Fisher-Yates shuffle in place (Python `shuffle`: descending i, j = _randbelow(i + 1)). */
  public shuffle<T>(x: Array<T>): void {
    for (let i = x.length - 1; i >= 1; i--) {
      const j = this.randbelow(i + 1);
      const tmp = x[i]!;
      x[i] = x[j]!;
      x[j] = tmp;
    }
  }

  /** `n` deterministic bytes, each `randbelow(256)` (mirrors the frozen `SeededRandom.token_bytes`). */
  public tokenBytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.randbelow(256);
    return out;
  }
}
