// THE PARITY PROOF: the TS `signAppJwt` produces a BYTE-FOR-BYTE identical JWT to the frozen Python
// `sign_app_jwt`. RS256 (RSA-PKCS#1-v1.5 over SHA-256) is a DETERMINISTIC signature scheme — no
// random salt — so for a fixed (app_id, private key, clock instant) the entire JWT string
// (header64.payload64.signature64) is reproducible across implementations. We assert string
// equality directly (no cross-decrypt dance needed, unlike the AES-GCM oracle).
//
// We also assert the decoded payload semantics (iat=now-60, exp=now+540, iss=appId, alg=RS256) and
// that an invalid PEM throws GitHubPrivateKeyMalformed on BOTH impls.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import {
  APP_JWT_IAT_BACKDATE_SECONDS,
  APP_JWT_TTL_SECONDS,
  GitHubPrivateKeyMalformed,
  signAppJwt,
} from "#backend/integrations/github/app_jwt.js";

import { pySignAppJwt, shutdownGithubCryptoRef } from "./github_crypto_oracle.js";

afterAll(() => shutdownGithubCryptoRef());

// One test RSA-2048 keypair shared by BOTH impls (generated once via `openssl genrsa`). Using the
// SAME key on both sides is what makes the deterministic signature byte-comparable.
const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_PEM = readFileSync(join(HERE, "fixtures", "jwt_test_rsa.pem"), "utf8");

/** base64url-decode (no padding) → JSON.parse, for inspecting JWT segments. */
function decodeSegment(segment: string): Record<string, unknown> {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

// Several (appId, wall-instant) cases. Distinct app ids (varying string length) and instants
// (including a fractional-second instant to prove the `int(...timestamp())` truncation matches).
const CASES: ReadonlyArray<{ readonly label: string; readonly appId: string; readonly nowMs: number }> =
  [
    { label: "round instant, 6-digit id", appId: "123456", nowMs: Date.UTC(2026, 5, 4, 12, 0, 0) },
    { label: "epoch-ish, short id", appId: "7", nowMs: 1_700_000_000_000 },
    { label: "long id", appId: "999999999999", nowMs: Date.UTC(2027, 0, 1, 0, 0, 0) },
    // Fractional-second instant: 123ms past the second. Both sides must truncate identically.
    { label: "fractional second", appId: "424242", nowMs: Date.UTC(2026, 5, 4, 12, 0, 0) + 123 },
    // Non-ASCII iss: GitHub app ids are numeric so this never occurs in prod, but it proves byte-parity
    // is UNCONDITIONAL — PyJWT json.dumps(ensure_ascii=True) escapes the € to €; jsonEnsureAscii matches.
    { label: "non-ASCII iss (ensure_ascii parity)", appId: "uni€code", nowMs: Date.UTC(2026, 0, 1, 0, 0, 0) },
  ];

describe("github app_jwt parity (signAppJwt === frozen sign_app_jwt, byte-for-byte)", () => {
  for (const c of CASES) {
    it(`byte-identical JWT — ${c.label}`, async () => {
      const tsJwt = signAppJwt({
        appId: c.appId,
        privateKeyPem: TEST_PEM,
        clock: new FakeClock({ now: new Date(c.nowMs) }),
      });

      const py = await pySignAppJwt({ appId: c.appId, privateKeyPem: TEST_PEM, nowMs: c.nowMs });
      expect(py.ok).toBe(true);
      if (!py.ok) return; // narrow for the type-checker
      expect(tsJwt).toBe(py.jwt);

      // Decoded payload semantics.
      const [headerSeg, payloadSeg, sigSeg] = tsJwt.split(".");
      expect(sigSeg).toBeTruthy();
      expect(decodeSegment(headerSeg!)).toEqual({ alg: "RS256", typ: "JWT" });

      const nowSeconds = Math.trunc(c.nowMs / 1000);
      const payload = decodeSegment(payloadSeg!);
      expect(payload["iat"]).toBe(nowSeconds - APP_JWT_IAT_BACKDATE_SECONDS);
      expect(payload["exp"]).toBe(nowSeconds + APP_JWT_TTL_SECONDS);
      expect(payload["iss"]).toBe(c.appId);
    });
  }

  it("constants match the frozen Python (TTL=540, backdate=60)", () => {
    expect(APP_JWT_TTL_SECONDS).toBe(9 * 60);
    expect(APP_JWT_IAT_BACKDATE_SECONDS).toBe(60);
  });

  it("an invalid PEM throws GitHubPrivateKeyMalformed on BOTH impls", async () => {
    const badPem = "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----\n";
    const nowMs = Date.UTC(2026, 5, 4, 12, 0, 0);

    expect(() =>
      signAppJwt({ appId: "123456", privateKeyPem: badPem, clock: new FakeClock({ now: new Date(nowMs) }) }),
    ).toThrow(GitHubPrivateKeyMalformed);

    const py = await pySignAppJwt({ appId: "123456", privateKeyPem: badPem, nowMs });
    expect(py.ok).toBe(false);
    if (py.ok) return; // narrow for the type-checker
    expect(py.errType).toBe("GitHubPrivateKeyMalformed");
  });
});
