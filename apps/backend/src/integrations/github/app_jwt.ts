/**
 * GitHub App JWT signer — signs a 10-minute RS256 JWT from the App-level private key (PEM in Vault).
 * The JWT bears
 * `iat = now - 60s` (clock-skew margin) and `exp = now + 9m` (under GitHub's 10-min cap). The
 * signed JWT is the App-level credential exchanged for an installation token.
 *
 * BYTE-PARITY with PyJWT: RS256 is RSA-PKCS#1-v1.5 over SHA-256 — a DETERMINISTIC signature scheme
 * (no random salt, unlike RSA-PSS), so for a fixed payload + key + clock the produced JWT string is
 * byte-identical to PyJWT's. The JSON serialization mirrors PyJWT exactly:
 *   - header: `{"alg":"RS256","typ":"JWT"}` — PyJWT builds `{"typ","alg"}` then `json.dumps(...,
 *     sort_keys=True)` (its `sort_headers` default is True), so the on-wire order is ALPHABETICAL
 *     (`alg` before `typ`).
 *   - payload: `{"iat":...,"exp":...,"iss":...}` — PyJWT `json.dumps(..., separators=(",",":"))`
 *     with the default `sort_keys=False`, so it preserves the Python dict's INSERTION order
 *     `iat, exp, iss`. We build the object in that exact order.
 *   - both use compact separators (no spaces) and base64url WITHOUT padding (`=` stripped).
 *
 * Determinism / seam discipline: the wall instant comes from the injected {@link Clock} (never a raw
 * `Date.now()`), and the signature uses `node:crypto` `sign` (PKCS#1 v1.5 is the default padding for
 * an RSA key) — no crypto randomness is involved.
 */

import crypto from "node:crypto";

import { type Clock } from "#platform/clock.js";

/**
 * GitHub caps App JWTs at 10 minutes. We use 9 minutes to leave a 1-minute safety margin against
 * clock skew on either side.
 */
export const APP_JWT_TTL_SECONDS = 9 * 60;

/** Back-date `iat` by this many seconds to tolerate clock skew at GitHub's end. */
export const APP_JWT_IAT_BACKDATE_SECONDS = 60;

/**
 * The private-key PEM cannot be parsed / used to sign. `node:crypto` `sign` throws for a malformed
 * PEM; this error wraps it.
 */
export class GitHubPrivateKeyMalformed extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitHubPrivateKeyMalformed";
  }
}

/**
 * base64url-encode bytes the way PyJWT's `base64url_encode` does: standard base64, then `+`→`-`,
 * `/`→`_`, and ALL `=` padding stripped (PyJWT does `.replace(b"=", b"")`).
 */
function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * `JSON.stringify` then escape every non-ASCII UTF-16 code unit to `\uXXXX` — matching CPython
 * `json.dumps(..., ensure_ascii=True)` (PyJWT's default). For the only inputs this code produces
 * (ASCII header + numeric/ASCII iss) this is a no-op; it makes the JWT byte-identical to PyJWT
 * UNCONDITIONALLY (a non-ASCII iss would otherwise diverge: Python escapes, raw JSON.stringify emits
 * UTF-8). Iterating code units yields surrogate-pair escapes for astral chars, exactly as Python does.
 */
function jsonEnsureAscii(value: Record<string, unknown>): string {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (ch) =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Sign a fresh App JWT.
 *
 * `appId` is the numeric GitHub App ID as a string. `privateKeyPem` is the full PEM (BEGIN/END lines
 * included). `clock` is injected so tests can use a `FakeClock` for deterministic iat/exp.
 */
export function signAppJwt({
  appId,
  privateKeyPem,
  clock,
}: {
  appId: string;
  privateKeyPem: string;
  clock: Clock;
}): string {
  const nowSeconds = clock.now().getTime() / 1000;
  // `int(...timestamp())` in Python truncates toward zero; `Math.trunc` matches (and equals
  // `Math.floor` for the non-negative epoch instants this code ever sees).
  const iat = Math.trunc(nowSeconds - APP_JWT_IAT_BACKDATE_SECONDS);
  const exp = Math.trunc(nowSeconds + APP_JWT_TTL_SECONDS);

  // Header key order matches PyJWT's sorted (sort_headers=True) output: alg before typ.
  const headerJson = JSON.stringify({ alg: "RS256", typ: "JWT" });
  // Payload key order matches the Python dict's INSERTION order (PyJWT sort_keys=False): iat, exp,
  // iss. JSON.stringify with no spaces == PyJWT's separators=(",",":").
  const payloadJson = jsonEnsureAscii({ iat, exp, iss: appId });

  const signingInput = `${base64url(Buffer.from(headerJson, "utf8"))}.${base64url(
    Buffer.from(payloadJson, "utf8"),
  )}`;

  let signature: Buffer;
  try {
    // "RSA-SHA256" + an RSA key ⇒ PKCS#1 v1.5 padding (node's default), identical to PyJWT's
    // `padding.PKCS1v15()` + SHA-256.
    signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), privateKeyPem);
  } catch {
    throw new GitHubPrivateKeyMalformed(
      `private key PEM rejected by node:crypto (length=${privateKeyPem.length})`,
    );
  }

  return `${signingInput}.${base64url(signature)}`;
}
