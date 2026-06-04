// GitHub webhook HMAC-SHA256 signature verification — 1:1 port of the frozen Python
// codemaster/api/github_webhook.py::verify_github_signature (constant-time).
//
// Scope: this module owns the verification edge ONLY — `verifyGithubSignature` +
// `GITHUB_SIGNATURE_PREFIX`. The FastAPI `build_router` / endpoint wiring on the Python side is
// OUT OF SCOPE here; that lands as the Fastify port (Task 2.4).
//
// Parity-proven against the source-of-truth in test/parity/webhook_hmac.parity.test.ts: valid
// signature → true on both impls; every CONFORMANT malformed/mismatched case (ASCII hex digests, as
// real GitHub traffic always sends) → false on both.
//
// KNOWN DIVERGENCE (non-conformant, attacker-crafted input only): if the provided digest contains a
// NON-ASCII char, Python `hmac.compare_digest` RAISES TypeError (which surfaces as HTTP 500), whereas
// this port returns false (→ HTTP 401). Neither accepts a forged signature, so there is no auth
// bypass — the divergence is error control-flow on garbage input, and the graceful 401 is the safer
// behavior. We intentionally do NOT replicate Python's raise (matching a crash-on-malformed-input
// would be strictly worse); real `X-Hub-Signature-256` values are always `sha256=` + 64 ASCII hex.
//
// Constant-time contract (the property the seam exists to guarantee — defends against timing oracles
// that would let an attacker recover the digest byte-by-byte):
//   - Python uses `hmac.compare_digest(expected_hex, provided_hex)`, which is timing-safe AND tolerates
//     unequal-length inputs (returns False without raising).
//   - Node's `crypto.timingSafeEqual(a, b)` is timing-safe but THROWS on unequal-length buffers. So we
//     length-guard FIRST: the expected hex digest is always 64 chars; any provided of a different
//     length returns false before `timingSafeEqual` is reached. The length comparison itself is a
//     coarse, content-independent branch (it leaks only the length, exactly as Python's does — a
//     wrong-length provided value short-circuits there in CPython too), so no per-byte timing channel
//     is opened. The byte-level comparison of equal-length digests is delegated to `timingSafeEqual`,
//     never to `===` (which would early-exit on the first differing byte and leak a timing channel).
//
// The bad-prefix early-return is a pure structural check on the header string (no secret material is
// involved — the HMAC has not been computed yet), so it leaks nothing the Python `startswith` guard
// does not already leak.
import { createHmac, timingSafeEqual } from "node:crypto";

/** The mandatory prefix on the `X-Hub-Signature-256` header value. Mirrors the frozen Python
 *  `GITHUB_SIGNATURE_PREFIX` constant verbatim. */
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
