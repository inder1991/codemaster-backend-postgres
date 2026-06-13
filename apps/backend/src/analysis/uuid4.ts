/**
 * uuid4 minter for static-analysis findings — via the platform randomness seam.
 *
 * Why not `crypto.randomUUID`: the clock/random gate (`scripts/gates/check_clock_random.ts`) bans
 * `crypto.randomUUID` / `crypto.randomBytes` outside the randomness seam. We mint the 122 random
 * bits from the seam's `SystemRandom.tokenBytes(16)` (the one sanctioned crypto-randomness entry
 * point, which delegates to `node:crypto` INSIDE the allow-listed seam) and stamp the RFC4122
 * version (0x4) + variant (0b10) bits. Mirrors the idiom already used at
 * `apps/backend/src/ingest/_workflow_events_repository.ts::uuid4`.
 *
 * Runtime context: these runners execute in the static-analysis ACTIVITY (normal Node runtime), NOT
 * the workflow V8-isolate sandbox — so a non-deterministic finding_id is correct.
 */

import { SystemRandom } from "#platform/randomness.js";

/** Module-shared CSPRNG seam. `tokenBytes` is the sanctioned crypto-randomness entry point. */
const RANDOM = new SystemRandom();

/** Mint a random RFC4122 v4 UUID (canonical lowercase hyphenated) via the platform randomness seam. */
export function uuid4(): string {
  const b = Buffer.from(RANDOM.tokenBytes(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
