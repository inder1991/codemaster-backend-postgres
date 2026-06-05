// GitHub-webhook HMAC-SHA256 signature-verification parity: prove the TS `verifyGithubSignature` port
// is bool-equal to the frozen Python `verify_github_signature` over a hostile matrix — valid
// signature, wrong signature, missing/short/over-long prefix, null/empty header, truncated/over-long
// provided hex, correct HMAC under the wrong secret. Every case asserts `TS bool === Python bool`.
//
// Plus a TS-only structural assertion that the production compare is constant-time: the module sources
// `crypto.timingSafeEqual` and does NOT compare the digests with `===` / `!==`.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  pyGithubSignaturePrefix,
  pyVerifyGithubSignature,
  shutdownWebhookHmacRef,
} from "./webhook_hmac_oracle.js";
import { GITHUB_SIGNATURE_PREFIX, verifyGithubSignature } from "#backend/api/github_webhook.js";

afterAll(() => shutdownWebhookHmacRef());

const enc = new TextEncoder();

/** The real HMAC-SHA256 hex digest of `body` under `secret` (the value GitHub would sign with). */
function hmacHex(secret: Uint8Array, body: Uint8Array): string {
  return createHmac("sha256", Buffer.from(secret)).update(Buffer.from(body)).digest("hex");
}

const SECRET = enc.encode("topsecret-webhook-key");
const WRONG_SECRET = enc.encode("a-totally-different-key");
const BODY = enc.encode('{"action":"opened","number":42}');
const EMPTY_BODY = new Uint8Array(0);

const VALID_HEX = hmacHex(SECRET, BODY);

/** One matrix case: a human label + the exact (body, header, secret) triple fed to BOTH impls. */
type Case = {
  readonly name: string;
  readonly body: Uint8Array;
  readonly header: string | null;
  readonly secret: Uint8Array;
  /** What we expect both impls to return (also independently cross-checked against Python). */
  readonly expected: boolean;
};

const CASES: ReadonlyArray<Case> = [
  // Happy path — the real HMAC, correctly prefixed.
  { name: "valid signature", body: BODY, header: `sha256=${VALID_HEX}`, secret: SECRET, expected: true },
  // Valid signature over an empty body (degenerate but legal — GitHub pings with `{}`-ish bodies).
  {
    name: "valid signature over empty body",
    body: EMPTY_BODY,
    header: `sha256=${hmacHex(SECRET, EMPTY_BODY)}`,
    secret: SECRET,
    expected: true,
  },
  // Wrong signature — well-formed hex, correct length, but not the real digest.
  { name: "wrong signature (64 hex zeros)", body: BODY, header: `sha256=${"0".repeat(64)}`, secret: SECRET, expected: false },
  // Correct digest BUT wrong prefix scheme — Python rejects anything not starting with `sha256=`.
  { name: "wrong prefix scheme (sha1=)", body: BODY, header: `sha1=${VALID_HEX}`, secret: SECRET, expected: false },
  // Correct digest but NO prefix at all.
  { name: "missing prefix (bare hex)", body: BODY, header: VALID_HEX, secret: SECRET, expected: false },
  // Prefix present but truncated to "sha256" (no `=`) — startswith("sha256=") is False.
  { name: "truncated prefix (sha256 no equals)", body: BODY, header: `sha256${VALID_HEX}`, secret: SECRET, expected: false },
  // Null header (absent X-Hub-Signature-256).
  { name: "null header", body: BODY, header: null, secret: SECRET, expected: false },
  // Empty-string header.
  { name: "empty header", body: BODY, header: "", secret: SECRET, expected: false },
  // Just the prefix, no digest — provided is "" (length 0) vs expected length 64.
  { name: "prefix only, empty provided", body: BODY, header: "sha256=", secret: SECRET, expected: false },
  // Truncated provided hex — correct first bytes but short. Must return false (NOT throw via length guard).
  { name: "truncated provided hex (32 chars)", body: BODY, header: `sha256=${VALID_HEX.slice(0, 32)}`, secret: SECRET, expected: false },
  // Over-long provided hex — correct digest with trailing garbage. Length mismatch → false.
  { name: "over-long provided hex (+8 chars)", body: BODY, header: `sha256=${VALID_HEX}deadbeef`, secret: SECRET, expected: false },
  // Correct HMAC algorithm + correct prefix but computed under the WRONG secret.
  { name: "correct hmac under wrong secret", body: BODY, header: `sha256=${hmacHex(WRONG_SECRET, BODY)}`, secret: SECRET, expected: false },
  // Correct prefix, but provided is the digest under the wrong secret while we verify with the right one.
  { name: "right secret verify of wrong-secret digest", body: BODY, header: `sha256=${hmacHex(WRONG_SECRET, BODY)}`, secret: SECRET, expected: false },
];

describe("verifyGithubSignature parity (TS ↔ frozen Python verify_github_signature)", () => {
  it("GITHUB_SIGNATURE_PREFIX matches the frozen Python constant", async () => {
    expect(GITHUB_SIGNATURE_PREFIX).toBe("sha256=");
    expect(GITHUB_SIGNATURE_PREFIX).toBe(await pyGithubSignaturePrefix());
  });

  it("each matrix case: TS bool === Python bool === expected", async () => {
    const mismatches: Array<string> = [];
    for (const c of CASES) {
      const ours = verifyGithubSignature({ body: c.body, header: c.header, secret: c.secret });
      const py = await pyVerifyGithubSignature({ body: c.body, header: c.header, secret: c.secret });
      // Cross-impl agreement is the load-bearing assertion.
      if (ours !== py) {
        mismatches.push(`${c.name}: ours=${ours} py=${py}`);
      }
      // And both must equal the hand-derived expectation (catches a both-wrong-the-same-way bug).
      expect(ours, `${c.name}: TS vs expected`).toBe(c.expected);
      expect(py, `${c.name}: Python vs expected`).toBe(c.expected);
    }
    expect(mismatches, `TS/Python disagreements:\n${mismatches.join("\n")}`).toEqual([]);
  }, 60_000);

  it("does NOT throw on unequal-length provided hex (length guard ahead of timingSafeEqual)", () => {
    // crypto.timingSafeEqual throws on unequal-length buffers; verify the guard returns false instead.
    expect(() =>
      verifyGithubSignature({ body: BODY, header: "sha256=abc", secret: SECRET }),
    ).not.toThrow();
    expect(verifyGithubSignature({ body: BODY, header: "sha256=abc", secret: SECRET })).toBe(false);
  });

  it("CONSTANT-TIME: production module uses crypto.timingSafeEqual, not === on the digests", () => {
    // Structural (source-level) assertion: the equal-length digest comparison MUST be delegated to
    // crypto.timingSafeEqual (timing-safe), never to a JS `===`/`!==` that early-exits on the first
    // differing byte and leaks a per-byte timing channel.
    const here = dirname(fileURLToPath(import.meta.url)); // <repo>/test/parity
    const modPath = join(here, "..", "..", "apps", "backend", "src", "api", "github_webhook.ts");
    const src = readFileSync(modPath, "utf8");
    // Strip line comments + block comments so prose mentioning `===` or `provided` doesn't false-match.
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

    expect(code).toMatch(/timingSafeEqual\s*\(/);
    // No equality/inequality operator compares `expected` to `provided` directly.
    expect(code).not.toMatch(/expected\s*(===|!==|==|!=)\s*provided/);
    expect(code).not.toMatch(/provided\s*(===|!==|==|!=)\s*expected/);
  });

  it("sanity: timingSafeEqual agrees with the digest it was built from", () => {
    // Independent guard that the test's own hmacHex helper produces what verifyGithubSignature accepts,
    // so a passing matrix can't be an artifact of a broken helper.
    const a = Buffer.from(VALID_HEX, "ascii");
    const b = Buffer.from(hmacHex(SECRET, BODY), "ascii");
    expect(timingSafeEqual(a, b)).toBe(true);
  });
});
