/**
 * ADR-0033 — local AES-256-GCM field encryption.
 *
 * Replaces Vault Transit (a network round-trip per encrypt/decrypt) with in-process AES-256-GCM
 * using keys from the {@link KeyRegistry} (populated at startup from Vault KV).
 *
 * Envelope formats (byte-exact across implementations — this is security-critical: a drift makes
 * encrypted DB columns cross-unreadable between the implementations):
 *
 *     kms:vN:<base64(  12-byte nonce || ciphertext || 16-byte GCM tag )>
 *     kms2:vN:<base64( 12-byte nonce || ciphertext || 16-byte GCM tag )>
 *
 * `kms:` is the original AAD-free envelope (Phase 2). `kms2:` is the AAD-bound envelope: callers
 * pass a per-column `aad` constant (e.g. `"core.users.email"` as bytes) which is bound into the
 * AES-GCM auth tag. An attacker with DB write access cannot move a ciphertext between columns and
 * have it decrypt cleanly.
 *
 * The version marker `vN` lets a single pod decrypt rows under any in-memory key version,
 * supporting hot key rotation without downtime.
 *
 * This module is the crypto layer ONLY. It does not read Vault, does not manage key rotation, and
 * does not interact with the database.
 */

import * as crypto from "node:crypto";

import { SystemRandom } from "../randomness.js";

import {
  KeyNotFoundError,
  type KeyRegistry,
  NoCurrentKeyError,
} from "./key_registry.js";

/** Original AAD-free envelope prefix. */
export const CIPHERTEXT_PREFIX = "kms:";
/** AAD-bound envelope prefix (B3 fix, 2026-05-18). */
export const CIPHERTEXT_PREFIX_AAD = "kms2:";

const NONCE_BYTES = 12; // AES-GCM standard nonce length.
const GCM_TAG_BYTES = 16; // AES-GCM auth tag size for the standard mode.
const ENVELOPE_PARTS = 3; // "<prefix>" + version + base64 payload.

/** Strict base64 alphabet (mirrors Python `base64.b64decode(..., validate=True)`). */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Raised on any local-key encrypt/decrypt failure.
 *
 * Fail-closed: writes do not commit ciphertext; reads do not return plaintext. The public message
 * is generic to avoid leaking oracle information to callers. Mirrors Python's
 * `LocalKeyEncryptionError`.
 */
export class LocalKeyEncryptionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LocalKeyEncryptionError";
  }
}

/**
 * Encrypt with the registry's current key version, optionally binding `aad` (associated data) into
 * the auth tag.
 *
 * With `aad` non-undefined, the resulting ciphertext can ONLY be decrypted by a caller passing the
 * same `aad` bytes. The recommended pattern is to pass `"<schema>.<table>.<column>"` as ASCII bytes
 * so an attacker with DB write access cannot move ciphertexts between columns.
 *
 * Returns `kms:vN:<base64(nonce||ct||tag)>` when `aad` is undefined and `kms2:vN:...` when set. The
 * differing prefix lets the dual-format read path route correctly during the migration window.
 *
 * DIVERGENCE (nonce source): Python uses `os.urandom(12)`. Here the nonce comes
 * from `new SystemRandom().tokenBytes(12)` — the sanctioned CSPRNG seam (the clock/random gate bans
 * raw `node:crypto` random calls outside randomness.ts; `SystemRandom.tokenBytes` wraps
 * `crypto.randomBytes`). Same 96-bit OS-CSPRNG entropy. The nonce is random, so it is NOT
 * parity-compared against the Python output — only the envelope structure is byte-exact.
 */
export function encryptField({
  plaintext,
  registry,
  aad,
}: {
  plaintext: Uint8Array;
  registry: KeyRegistry;
  aad?: Uint8Array;
}): string {
  let version: string;
  let key: Uint8Array;
  try {
    ({ version, key } = registry.current());
  } catch (e) {
    if (e instanceof NoCurrentKeyError) {
      throw new LocalKeyEncryptionError("no current key loaded");
    }
    throw e;
  }

  const nonce = new SystemRandom().tokenBytes(NONCE_BYTES);
  let ct: Buffer;
  let tag: Buffer;
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    if (aad !== undefined) {
      cipher.setAAD(aad); // MUST be set before update().
    }
    ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
    tag = cipher.getAuthTag(); // 16-byte GCM tag.
  } catch {
    throw new LocalKeyEncryptionError("encrypt failed");
  }

  // Python's `cryptography` returns ct||tag concatenated; Node gives the tag separately, so we
  // concat in exactly that order to produce a byte-identical envelope.
  const envelope = Buffer.concat([nonce, ct, tag]).toString("base64");
  const prefix = aad !== undefined ? CIPHERTEXT_PREFIX_AAD : CIPHERTEXT_PREFIX;
  return `${prefix}${version}:${envelope}`;
}

/**
 * Decrypt an envelope produced by {@link encryptField}.
 *
 * The caller MUST pass the same `aad` value used during encrypt. Passing the wrong `aad` (including
 * undefined when the ciphertext was AAD-bound, or vice versa) surfaces as auth-tag mismatch —
 * indistinguishable from a tampered ciphertext, which is the correct fail-safe behaviour.
 *
 * Routes by prefix: `kms:` → no AAD; `kms2:` → AAD required. A mismatch between the prefix and the
 * `aad` argument raises immediately. The prefix↔aad coupling is the security property: `kms:`
 * envelopes never call `setAAD` (matching Python `associated_data=None`); `kms2:` always do.
 */
export function decryptField({
  ciphertext,
  registry,
  aad,
}: {
  ciphertext: string;
  registry: KeyRegistry;
  aad?: Uint8Array;
}): Uint8Array {
  // Route by prefix; cross-check against the caller's aad expectation. IMPORTANT: `kms:` is a
  // prefix of `kms2:`, so check the longer prefix FIRST.
  if (ciphertext.startsWith(CIPHERTEXT_PREFIX_AAD)) {
    if (aad === undefined) {
      throw new LocalKeyEncryptionError(
        "kms2: ciphertext requires aad= argument; caller passed None",
      );
    }
  } else if (ciphertext.startsWith(CIPHERTEXT_PREFIX)) {
    if (aad !== undefined) {
      throw new LocalKeyEncryptionError(
        "kms: ciphertext was encrypted without aad; " +
          "caller passed aad= but envelope predates the AAD migration",
      );
    }
  } else {
    throw new LocalKeyEncryptionError("unexpected prefix; expected 'kms:' or 'kms2:'");
  }

  // Parse "<prefix>vN:<base64>" — exactly ENVELOPE_PARTS colon-delimited parts. Mirrors Python's
  // `split(":", 2)`: split on the FIRST TWO colons only (base64 has no colons, but be faithful).
  const parts = splitMax(ciphertext, ":", 2);
  if (parts.length !== ENVELOPE_PARTS || !parts[1] || !parts[2]) {
    throw new LocalKeyEncryptionError("malformed envelope");
  }
  const version = parts[1];
  const envelopeB64 = parts[2];

  // Strict base64 validation (mirrors Python `validate=True`, which rejects non-alphabet chars).
  if (envelopeB64.length % 4 !== 0 || !BASE64_RE.test(envelopeB64)) {
    throw new LocalKeyEncryptionError("invalid base64 in envelope");
  }
  const envelopeBytes = Buffer.from(envelopeB64, "base64");
  // Round-trip guard: Node's base64 decoder is lenient about trailing junk; re-encoding and
  // comparing makes the validation as strict as Python's.
  if (envelopeBytes.toString("base64") !== envelopeB64) {
    throw new LocalKeyEncryptionError("invalid base64 in envelope");
  }

  if (envelopeBytes.length < NONCE_BYTES + GCM_TAG_BYTES) {
    throw new LocalKeyEncryptionError("envelope shorter than nonce + tag");
  }

  const nonce = envelopeBytes.subarray(0, NONCE_BYTES);
  const ctAndTag = envelopeBytes.subarray(NONCE_BYTES); // ct || tag
  const tag = ctAndTag.subarray(ctAndTag.length - GCM_TAG_BYTES);
  const ct = ctAndTag.subarray(0, ctAndTag.length - GCM_TAG_BYTES);

  let key: Uint8Array;
  try {
    key = registry.get(version);
  } catch (e) {
    if (e instanceof KeyNotFoundError || e instanceof NoCurrentKeyError) {
      throw new LocalKeyEncryptionError(`key version '${version}' not loaded`);
    }
    throw e;
  }

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    if (aad !== undefined) {
      decipher.setAAD(aad);
    }
    decipher.setAuthTag(Buffer.from(tag));
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ct)), decipher.final()]));
  } catch {
    throw new LocalKeyEncryptionError("auth tag mismatch (tampered or wrong key)");
  }
}

/**
 * Split `s` on `sep` into at most `maxSplits + 1` parts, with the remainder kept whole in the last
 * part — mirrors Python's `str.split(sep, maxsplit)`. JS `String.prototype.split` has no maxsplit
 * that preserves the tail, so this is implemented manually.
 */
function splitMax(s: string, sep: string, maxSplits: number): Array<string> {
  const out: Array<string> = [];
  let rest = s;
  for (let i = 0; i < maxSplits; i++) {
    const idx = rest.indexOf(sep);
    if (idx === -1) break;
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
  }
  out.push(rest);
  return out;
}
