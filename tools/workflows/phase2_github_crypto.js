export const meta = {
  name: 'phase2-github-crypto',
  description: 'Phase 2 integration prerequisites: GitHub App JWT minting (RS256, byte-parity) + webhook HMAC verification (constant-time)',
  phases: [
    { title: 'Port', detail: 'app_jwt.ts (sign_app_jwt) + github_webhook.ts (verify_github_signature)' },
    { title: 'Verify', detail: 'adversarial: JWT byte-identical to PyJWT; HMAC verify matches + is constant-time' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['component', 'files_written', 'commands', 'all_green', 'notes'],
  properties: {
    component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cmd', 'passed'], properties: { cmd: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } } } },
    all_green: { type: 'boolean' }, notes: { type: 'string' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'checks', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['SOUND', 'WEAK', 'INCONCLUSIVE'] },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'pass'], properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } } } },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

const STYLE = `
WORKING DIR: ${REPO}. ABSOLUTE paths. Bash cwd RESETS — prefix every command with \`cd ${REPO} && ...\`.
TS STYLE (ENFORCED — validate-fast = gates→lint→typecheck→test): ESM \`.js\` specifiers; \`type\` not \`interface\`; \`Array<T>\`; NO \`any\`; named exports; explicit return types; \`import { type X }\`; no unused vars; snake_case filenames.
IMPORTS: Node subpath aliases \`#contracts/*\`, \`#platform/*\`, \`#backend/*\`; cross-dir aliases, same-dir relative.
GATE: apps/backend/src/backend/** scanned by check_clock_random — NO raw Date.now/Math.random; the JWT uses the injected #platform Clock; node:crypto SIGN/HMAC functions (sign/createSign/createHmac/timingSafeEqual) are NOT in the gate's banned RANDOM set, so they're fine — but do NOT use crypto random (randomBytes/etc.) here (none needed; RS256 PKCS#1v1.5 is deterministic).
HARNESS: build a DEDICATED driver (mirror tools/parity/run_redact_ref.py + a <sub>_oracle.ts) — the generic oracle can't pass a Clock object (JWT) or raw bytes (HMAC). Drive the REAL frozen Python functions.
GUARDRAILS: touch ONLY your files. NO eslint --fix on the repo; NO git add/commit; NO database; NO new npm deps (use node:crypto). You are the ONLY workflow running; \`npx tsc -p tsconfig.json\` should be clean. Frozen source READ-ONLY at vendor/codemaster-py (venv .venv/bin/python).
RUN BEFORE RETURNING (all must pass): \`cd ${REPO} && npx vitest run <your test>\`, \`npx tsc -p tsconfig.json\`, \`npx eslint <your .ts files>\`, \`npx tsx scripts/gates/check_clock_random.ts\`. Do NOT report all_green:true unless every one passed.
`

phase('Port')

const JWT = `Port GitHub App JWT minting 1:1 to TypeScript — BYTE-PARITY vs PyJWT (RS256 / RSA-PKCS#1-v1.5 is DETERMINISTIC, so the same payload+key+clock yields a byte-identical JWT string).
${STYLE}
READ + CONFIRM signatures: ${REPO}/vendor/codemaster-py/codemaster/integrations/github/app_jwt.py. Entry: \`sign_app_jwt(*, app_id: str, private_key_pem: str, clock: Clock) -> str\`. Payload: iat = int((now - 60s).timestamp()), exp = int((now + 540s).timestamp()), iss = app_id; jwt.encode(payload, private_key_pem, algorithm="RS256"). Constants APP_JWT_TTL_SECONDS=540, APP_JWT_IAT_BACKDATE_SECONDS=60. GitHubPrivateKeyMalformed on invalid PEM.
PORT to ${REPO}/apps/backend/src/backend/integrations/github/app_jwt.ts: \`signAppJwt({ appId, privateKeyPem, clock }: { appId: string; privateKeyPem: string; clock: Clock }): string\` (Clock from #platform/clock.js). Construct the JWT with node:crypto (NO new dep): header {alg:"RS256",typ:"JWT"} → base64url; payload {iat,exp,iss} (KEY ORDER must match PyJWT's JSON — PyJWT uses json.dumps(payload, separators=(",",":")) over the dict in the order iat,exp,iss... CONFIRM PyJWT's exact serialization: it sorts? No — PyJWT json.dumps with default sort_keys=False preserves dict insertion order. Match the Python dict's insertion order EXACTLY: iat, exp, iss) → base64url; signingInput = header64+"."+payload64; signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKeyPem) (PKCS#1 v1.5 default for RSA keys — deterministic) → base64url; return signingInput+"."+signature. Wrap key/sign errors in \`export class GitHubPrivateKeyMalformed extends Error\`. base64url = base64 with +→-, /→_, strip trailing =.
PARITY DRIVER tools/parity/run_github_crypto_ref.py + test/parity/github_crypto_oracle.ts: drive the frozen sign_app_jwt with a FakeClock built from a passed unix-ms instant + a passed app_id + PEM; return the JWT string. Generate a test RSA keypair once (e.g. \`openssl genrsa\` or python cryptography) and use it on BOTH sides.
Test test/parity/app_jwt.parity.test.ts: for several (appId, clock-instant) cases, assert signAppJwt(...) === the Python sign_app_jwt(...) JWT BYTE-FOR-BYTE; assert the decoded payload has iat=now-60, exp=now+540, iss=appId, alg=RS256; assert an invalid PEM throws GitHubPrivateKeyMalformed on both sides.
Return component="jwt", files_written, commands, all_green, notes (PyJWT serialization order confirmed, base64url handling).`

const HMAC = `Port GitHub webhook HMAC-SHA256 signature verification 1:1 to TypeScript (constant-time).
${STYLE}
READ + CONFIRM: ${REPO}/vendor/codemaster-py/codemaster/api/github_webhook.py — \`verify_github_signature(*, body: bytes, header: str, secret: bytes) -> bool\`: if not header or not header.startswith("sha256=") → False; expected = hmac.new(secret, body, sha256).hexdigest(); provided = header after the "sha256=" prefix; return hmac.compare_digest(expected, provided). Constant-time. (The build_router/FastAPI part is OUT OF SCOPE — that's the Fastify port Task 2.4; port ONLY verify_github_signature + GITHUB_SIGNATURE_PREFIX here.)
PORT to ${REPO}/apps/backend/src/backend/api/github_webhook.ts: \`verifyGithubSignature({ body, header, secret }: { body: Uint8Array; header: string | null; secret: Uint8Array }): boolean\` using node:crypto.createHmac("sha256", secret).update(body).digest("hex"), then a CONSTANT-TIME compare (crypto.timingSafeEqual over equal-length Buffers — guard length first, and ensure the early-return false on bad prefix doesn't leak timing beyond what Python's does). export const GITHUB_SIGNATURE_PREFIX = "sha256=".
PARITY DRIVER (reuse/extend the same run_github_crypto_ref.py + github_crypto_oracle.ts as the JWT agent OR your own — coordinate by using a DISTINCT driver file tools/parity/run_webhook_hmac_ref.py + test/parity/webhook_hmac_oracle.ts to avoid collision): drive frozen verify_github_signature with base64-passed body/secret + the header string; return the bool.
Test test/parity/webhook_hmac.parity.test.ts: matrix — valid signature (compute the real hmac, prefix it) → true on both; wrong signature → false; missing "sha256=" prefix → false; null/empty header → false; truncated/over-long provided hex → false; correct hmac but wrong secret → false. Assert the TS bool === Python bool on every case. Add a TS-only assertion that the compare is constant-time (uses timingSafeEqual, not ===).
Return component="hmac", files_written, commands, all_green, notes (constant-time approach, prefix/length-guard handling).`

const [jwtRes, hmacRes] = await parallel([
  () => agent(JWT, { label: 'port:jwt', phase: 'Port', schema: BUILD_SCHEMA }),
  () => agent(HMAC, { label: 'port:hmac', phase: 'Port', schema: BUILD_SCHEMA }),
])

phase('Verify')
const verify = await agent(`ADVERSARIAL verifier for the GitHub crypto prerequisites (App JWT minting + webhook HMAC verification). REFUTE byte-parity / correctness vs frozen Python.
${STYLE}
Ports: jwt=${JSON.stringify(jwtRes).slice(0, 500)} | hmac=${JSON.stringify(hmacRes).slice(0, 500)}
Independently (drive frozen Python + TS via a throwaway ${REPO}/tools/parity/_gh_scratch.ts — DELETE after, no git-add):
1. JWT byte-identity: with a fixed test RSA key + fixed FakeClock instant + appId, confirm TS signAppJwt(...) === Python sign_app_jwt(...) CHARACTER-FOR-CHARACTER (RS256 PKCS#1v1.5 is deterministic — any mismatch = base64url or payload-serialization-order drift). Decode and confirm iat=now-60, exp=now+540, iss, alg=RS256. Invalid PEM → GitHubPrivateKeyMalformed on TS.
2. HMAC: 8 cases (valid, wrong sig, no prefix, null header, empty header, truncated hex, wrong secret, body tampered) → TS bool === Python verify_github_signature bool on every one.
3. Constant-time: confirm the HMAC compare uses timingSafeEqual (not === / startsWith on the digest); confirm a length-mismatched provided hex does not throw (guarded) and returns false.
4. Run \`cd ${REPO} && npx vitest run test/parity/app_jwt.parity.test.ts test/parity/webhook_hmac.parity.test.ts\`; \`npx tsx scripts/gates/check_clock_random.ts\` 0 violations; \`npx tsc -p tsconfig.json\` clean.
verdict=WEAK if the JWT diverges by any byte, any HMAC case mismatches, the compare isn't constant-time, or a test is vacuous; SOUND otherwise. Exact reproduction for failures. Clean up scratch.`, { label: 'verify:gh-crypto', phase: 'Verify', schema: VERIFY_SCHEMA })

return { jwt: jwtRes, hmac: hmacRes, verify }
