// GitHub webhook HMAC-SHA256 signature verification (constant-time).
//
// Owns the verification edge ONLY — `verifyGithubSignature` + `GITHUB_SIGNATURE_PREFIX`.
//
// KNOWN DIVERGENCE (non-conformant, attacker-crafted input only): if the provided digest contains a
// NON-ASCII char, this port returns false (→ HTTP 401) instead of raising. Neither path accepts a forged
// signature — the graceful 401 is the safer behavior; real `X-Hub-Signature-256` values are always
// `sha256=` + 64 ASCII hex.
//
// Constant-time contract (defends against timing oracles that would let an attacker recover the digest
// byte-by-byte): Node's `crypto.timingSafeEqual(a, b)` is timing-safe but THROWS on unequal-length
// buffers. So we length-guard FIRST: the expected hex digest is always 64 chars; any provided of a
// different length returns false before `timingSafeEqual` is reached (content-independent branch — no
// per-byte timing channel). The byte-level comparison of equal-length digests is delegated to
// `timingSafeEqual`, never to `===`.
//
// The bad-prefix early-return is a pure structural check (no secret material involved, HMAC not yet
// computed) — leaks nothing.
import { createHmac, timingSafeEqual } from "node:crypto";

/** The mandatory prefix on the `X-Hub-Signature-256` header value. */
export const GITHUB_SIGNATURE_PREFIX = "sha256=";

/**
 * Constant-time HMAC-SHA256 verification of a GitHub webhook signature.
 *
 * `header` is the full `X-Hub-Signature-256` value, including the `sha256=` prefix. A null / empty /
 * malformed (wrong-prefix) header returns false. The hex-digest comparison is delegated to
 * `crypto.timingSafeEqual` over equal-length buffers (timing-attack safe), with a length guard ahead
 * of it so an unequal-length provided value returns false instead of throwing.
 *
 * @param body   the raw request body bytes the signature covers.
 * @param header the full `X-Hub-Signature-256` header value, or null when absent.
 * @param secret the shared webhook secret bytes.
 * @returns true iff the signature is well-formed and matches; false otherwise.
 */
export function verifyGithubSignature({
  body,
  header,
  secret,
}: {
  body: Uint8Array;
  header: string | null;
  secret: Uint8Array;
}): boolean {
  if (!header || !header.startsWith(GITHUB_SIGNATURE_PREFIX)) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const provided = header.slice(GITHUB_SIGNATURE_PREFIX.length);
  // timingSafeEqual throws on unequal-length buffers; guard the length first. The expected hex is
  // always 64 chars, so a different-length provided value can never match — return false without
  // opening a per-byte timing channel (the length check is content-independent).
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, "ascii"), Buffer.from(provided, "ascii"));
}
