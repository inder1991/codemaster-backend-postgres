export const meta = {
  name: 'task-0-8-crypto-parity',
  description: 'Port AES-256-GCM kms2 field-encryption (ADR-0033) 1:1 + prove bidirectional cross-impl parity + adversarial AAD/tamper verification',
  phases: [
    { title: 'Build', detail: 'key_registry.ts + aes_gcm_aad.ts + TS unit tests' },
    { title: 'Parity', detail: 'Python crypto driver + oracle + bidirectional cross-impl parity test' },
    { title: 'Verify', detail: 'adversarial refutation of AAD-binding / tamper-rejection / cross-decrypt' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'

const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files_written', 'commands', 'all_green', 'notes'],
  properties: {
    files_written: { type: 'array', items: { type: 'string' } },
    commands: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['cmd', 'passed'],
        properties: { cmd: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } },
      },
    },
    all_green: { type: 'boolean' },
    notes: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'security_properties', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['SECURE_CROSS_IMPL', 'BROKEN', 'INCONCLUSIVE'] },
    security_properties: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['property', 'holds'],
        properties: { property: { type: 'string' }, holds: { type: 'boolean' }, evidence: { type: 'string' } },
      },
    },
    test_is_real: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

const STYLE = `
WORKING DIR: ${REPO}. ABSOLUTE paths. Bash cwd RESETS between calls — prefix every command with \`cd ${REPO} && ...\`.

TS STYLE (ENFORCED — validate-fast runs gates→lint→typecheck→test): ESM \`.js\` import specifiers; \`type\` not \`interface\`; \`Array<T>\` not \`T[]\`; NO \`any\` (use \`unknown\`); named exports only; explicit return types on exported fns; \`import { type X }\`; snake_case filenames (leading \`_\` allowed). camelCase locals, PascalCase types, CAPITALIZED consts.

IMPORT CONVENTION: cross-dir lib imports use Node subpath aliases (package.json "imports"): \`#platform/*\`→libs/platform/src/*, \`#contracts/*\`→libs/contracts/src/*. Same-dir/sub-dir imports stay relative (\`./key_registry.js\`, \`../randomness.js\`). The crypto files live under libs/platform/src/crypto/ — import the sibling randomness seam as \`../randomness.js\`, the local registry as \`./key_registry.js\`.

GUARDRAILS: touch ONLY your assigned files; NO \`eslint --fix\` on the repo; NO git add/commit (orchestrator commits); NO database. Frozen Python source-of-truth: ${REPO}/vendor/codemaster-py (READ-ONLY; venv at vendor/codemaster-py/.venv/bin/python, CPython 3.14). Read a sibling before writing (mirror test/parity/random_oracle.ts + tools/parity/run_random_ref.py for the harness shape).
`

// =================================================================================================
phase('Build')

const BUILD_BRIEF = `Port the ADR-0033 local AES-256-GCM field-encryption crypto layer 1:1 to TypeScript. Security-critical: byte-exact envelope + AAD passthrough or encrypted DB columns become cross-unreadable.
${STYLE}

READ FIRST (the exact source-of-truth): ${REPO}/vendor/codemaster-py/codemaster/security/local_key_field_encryption.py and ${REPO}/vendor/codemaster-py/codemaster/security/key_registry.py. (The plan's "codemaster.kms2.aes_gcm" module is FICTIONAL — ignore it; these two files are the real implementation.) Also read ${REPO}/libs/platform/src/randomness.ts (you'll use SystemRandom for the nonce).

=== FILE 1: ${REPO}/libs/platform/src/crypto/key_registry.ts — port of key_registry.py ===
- \`export type KeySet = { currentVersion: string; keys: ReadonlyMap<string, Uint8Array> }\` with a factory \`export function makeKeySet({ currentVersion, keys }: { currentVersion: string; keys: ReadonlyMap<string, Uint8Array> }): KeySet\` that VALIDATES (mirror KeySet.__post_init__): keys non-empty; currentVersion ∈ keys; every key EXACTLY 32 bytes (AES-256) — throw \`Error\` with the same message shape on violation. Freeze a private copy of the map so post-construction mutation can't leak in.
- \`export class KeyRegistry\`: \`set(keyset: KeySet): void\`; \`current(): { version: string; key: Uint8Array }\` (throws NoCurrentKeyError if unset); \`get(version: string): Uint8Array\` (throws KeyNotFoundError if unset OR version absent — mirror the Python distinction: current() throws NoCurrentKey, get() throws KeyNotFound); \`versions(): ReadonlySet<string>\` (empty set if unset).
- \`export class KeyNotFoundError extends Error\` and \`export class NoCurrentKeyError extends Error\` (constructor sets this.name).
- No threading lock needed (JS is single-threaded); document that 1:1-divergence in a comment.

=== FILE 2: ${REPO}/libs/platform/src/crypto/aes_gcm_aad.ts — port of local_key_field_encryption.py ===
import * as crypto from "node:crypto"; import { SystemRandom } from "../randomness.js"; import { KeyRegistry, KeyNotFoundError, NoCurrentKeyError } from "./key_registry.js".
- Constants: \`export const CIPHERTEXT_PREFIX = "kms:"\`, \`export const CIPHERTEXT_PREFIX_AAD = "kms2:"\`, NONCE_BYTES=12, GCM_TAG_BYTES=16.
- \`export class LocalKeyEncryptionError extends Error\` (name set).
- \`export function encryptField({ plaintext, registry, aad }: { plaintext: Uint8Array; registry: KeyRegistry; aad?: Uint8Array }): string\`:
  * get { version, key } = registry.current() (catch NoCurrentKeyError → throw LocalKeyEncryptionError("no current key loaded")).
  * nonce = new SystemRandom().tokenBytes(12)  // CSPRNG via the sanctioned seam (gate bans raw crypto.randomBytes outside randomness.ts; SystemRandom.tokenBytes wraps it). Python uses os.urandom(12) — same entropy; nonce is random so NOT parity-compared. Document this 1:1-divergence.
  * cipher = crypto.createCipheriv("aes-256-gcm", key, nonce); if aad !== undefined → cipher.setAAD(aad) (BEFORE update); ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]); tag = cipher.getAuthTag() (16 bytes).
  * envelope = Buffer.concat([nonce, ct, tag]).toString("base64")  // EXACTLY Python's base64.b64encode(nonce + ct_and_tag); cryptography returns ct||tag concatenated, Node gives tag separately → concat in that order.
  * prefix = aad !== undefined ? CIPHERTEXT_PREFIX_AAD : CIPHERTEXT_PREFIX; return \`\${prefix}\${version}:\${envelope}\`.
- \`export function decryptField({ ciphertext, registry, aad }: { ciphertext: string; registry: KeyRegistry; aad?: Uint8Array }): Uint8Array\`: mirror decrypt() EXACTLY:
  * Route by prefix, longer FIRST (kms: is a prefix of kms2:): if startsWith("kms2:") → require aad!==undefined else throw LocalKeyEncryptionError("kms2: ciphertext requires aad= argument; caller passed None"); else if startsWith("kms:") → require aad===undefined else throw ("kms: ciphertext was encrypted without aad; caller passed aad= but envelope predates the AAD migration"); else throw ("unexpected prefix; expected 'kms:' or 'kms2:'").
  * Parse "<prefix>vN:<base64>" as Python's split(":", 2) → EXACTLY 3 parts (split at the first TWO colons only; base64 has no colons but be faithful): part0=before 1st colon, version=between 1st and 2nd colon, payload=after 2nd colon. If version empty OR payload empty → "malformed envelope".
  * base64 decode with VALIDATION (Python uses validate=True which rejects non-alphabet chars): validate the payload is strict base64 (e.g. re-encode the decoded bytes and compare, or regex \`^[A-Za-z0-9+/]*={0,2}$\` + length%4===0); on failure throw "invalid base64 in envelope".
  * if decoded.length < 12+16 → "envelope shorter than nonce + tag".
  * nonce = decoded[0..12); rest = decoded[12..) (this is ct||tag); tag = rest[rest.length-16 ..]; ct = rest[0 .. rest.length-16].
  * key = registry.get(version) (catch KeyNotFoundError/NoCurrentKeyError → throw LocalKeyEncryptionError(\`key version '\${version}' not loaded\`)).
  * decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce); if aad!==undefined → decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(tag)); try { return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ct)), decipher.final()])) } catch → throw LocalKeyEncryptionError("auth tag mismatch (tampered or wrong key)").
  * NOTE: for kms: (aad===undefined) do NOT call setAAD (matches Python associated_data=None). For kms2:, setAAD(aad). This prefix↔aad coupling is the security property.

=== FILE 3: ${REPO}/test/unit/crypto/aes_gcm_aad.test.ts (vitest, TS-only — no Python) ===
Helper: build a KeyRegistry with a fixed 32-byte test key (e.g. Uint8Array filled 0x42) at version "1". Assert:
- round-trip kms2: encryptField({plaintext, aad}) then decryptField with SAME aad returns the plaintext (utf8 + binary + empty + 1-byte + a 100KB buffer).
- round-trip kms: (no aad) likewise.
- WRONG aad on a kms2 ciphertext → throws LocalKeyEncryptionError (AAD binding).
- kms2 ciphertext decrypted with aad=undefined → throws (prefix/aad mismatch). kms ciphertext decrypted WITH aad → throws.
- tampered envelope (flip one base64 char / one tag byte) → throws "auth tag mismatch".
- malformed: "kms2:" only, "kms2:1:" empty payload, non-base64 payload, too-short payload → throw.
- key version not loaded: encrypt under version "1", decrypt with a registry holding only version "2" → throws.
- envelope prefix is exactly "kms2:1:" for aad path, "kms:1:" for no-aad; two encrypts of the same input differ (random nonce) but both decrypt.
- KeyRegistry: current()/get() throw the right error types when unset; makeKeySet rejects a 31-byte key + a currentVersion not in keys.

TDD: write the unit test FIRST, confirm RED (modules missing), implement to GREEN. Then \`cd ${REPO} && npx vitest run test/unit/crypto/aes_gcm_aad.test.ts\`, \`npx tsc -p tsconfig.json\`, \`npx eslint libs/platform/src/crypto/*.ts test/unit/crypto/aes_gcm_aad.test.ts\`, and \`npx tsx scripts/gates/check_clock_random.ts\` (MUST stay 0 violations — confirm the nonce-via-SystemRandom choice kept the crypto files gate-clean; if it flags crypto.* you used a raw crypto random call — route it through SystemRandom instead). All green.

Return files_written, every command + pass/fail, all_green, and notes (incl. the 1:1 divergences documented + confirmation the gate stayed at 0 violations).`

const buildRes = await agent(BUILD_BRIEF, { label: 'crypto module + unit tests', phase: 'Build', schema: BUILD_SCHEMA })

// =================================================================================================
phase('Parity')

const PARITY_BRIEF = `Build the bidirectional cross-impl parity proof for the TS AES-256-GCM crypto just built (Phase 1: libs/platform/src/crypto/{key_registry,aes_gcm_aad}.ts). The security guarantee is that ciphertext written by EITHER impl decrypts in the OTHER with the same key+AAD — the dual-format read path depends on it.
${STYLE}

The build agent produced: ${'${BUILD_SUMMARY}'}

Because the nonce is random, ciphertexts CANNOT be byte-compared — parity is proven by CROSS-DECRYPTION (encrypt one side, decrypt the other → plaintext matches).

=== FILE 1: ${REPO}/tools/parity/run_crypto_ref.py — dedicated stateless driver (mirror tools/parity/run_random_ref.py shape; cwd=submodule so \`import codemaster\` resolves the frozen source) ===
Long-lived JSONL stdin→stdout. Drives the REAL frozen codemaster.security crypto. For each request build a fresh KeyRegistry:
  from codemaster.security.key_registry import KeyRegistry, KeySet
  from codemaster.security.local_key_field_encryption import encrypt as enc, decrypt as dec, LocalKeyEncryptionError
  registry = KeyRegistry(); registry.set(KeySet(current_version=version, keys={v: base64.b64decode(kb64) for v,kb64 in keys_map.items()}))
Request kinds (all values base64 for binary safety; aad is base64 or null):
- {"id","op":"encrypt","keys":{"1":"<b64key>"},"version":"1","plaintext":"<b64>","aad":"<b64>"|null} → {"id","ok":true,"ct":"<envelope string>"}
- {"id","op":"decrypt","keys":{...},"version_for_get_is_implicit_in_envelope...},"ciphertext":"<envelope>","aad":"<b64>"|null} → {"id","ok":true,"pt":"<b64 plaintext>"} OR {"id","ok":false,"err":"<LocalKeyEncryptionError msg>"}.
  (For decrypt, the registry must hold whatever key versions the test needs — accept the full "keys" map so the test can simulate wrong-version-not-loaded. The envelope itself carries the version; the Python decrypt() calls registry.get(thatVersion).)
Wrap every call so a LocalKeyEncryptionError (or any exception) becomes {"ok":false,"err":...}; never crash the loop.

=== FILE 2: ${REPO}/test/parity/crypto_oracle.ts — TS spawn/drive helper (mirror test/parity/random_oracle.ts EXACTLY for the spawn+readline+id-correlation pattern) ===
spawn vendor/codemaster-py/.venv/bin/python tools/parity/run_crypto_ref.py (cwd=submodule). Export:
- \`pyEncrypt({ keys, version, plaintext, aad }): Promise<string>\` (keys: Record<string,Buffer/Uint8Array> → base64 in the wire msg; plaintext/aad → base64; returns the ct envelope; throws if py says ok:false).
- \`pyDecrypt({ keys, ciphertext, aad }): Promise<{ ok: true; plaintext: Uint8Array } | { ok: false; err: string }>\` (does NOT throw on ok:false — returns the discriminated result so the test can assert Python ALSO rejects wrong-aad).
- \`shutdownCryptoRef(): void\`.

=== FILE 3: ${REPO}/test/parity/crypto_cross_impl.parity.test.ts — THE security assertion (afterAll(shutdownCryptoRef)) ===
Fixed TEST_KEY = 32 bytes (e.g. a known constant, NOT 0x42 if the unit test uses that — use a distinct known pattern), version "1". Real per-column AADs from the codebase: "core.users.email", "audit.audit_events.before", "cache.cache_tokens.token_ciphertext". Import encryptField/decryptField from #platform/crypto/aes_gcm_aad.js (subpath alias — confirm package.json "imports" resolves #platform/crypto/*; if not, use a relative path and note it). Assert:
1. TS→PY (kms2): for each AAD + several plaintexts (utf8 "alice@example.com", multibyte "café→雪", empty, 1KB binary): ct = encryptField({plaintext, registry(TEST_KEY@1), aad}); pyDecrypt({keys:{"1":TEST_KEY}, ciphertext:ct, aad}) → ok && plaintext bytes EQUAL the original.
2. PY→TS (kms2): ct = pyEncrypt({keys:{"1":TEST_KEY}, version:"1", plaintext, aad}); decryptField({ciphertext:ct, registry, aad}) bytes EQUAL original.
3. AAD binding BOTH directions: PY-encrypt with aad="core.users.email"; decryptField with aad="audit.audit_events.before" → THROWS. TS-encrypt with aad=A; pyDecrypt with aad=B → ok:false.
4. kms: (AAD-free) cross round-trips both directions (encrypt aad=null/undefined, decrypt aad=null/undefined).
5. prefix↔aad mismatch cross-impl: PY kms2 ct + TS decrypt aad=undefined → throws; PY kms ct + TS decrypt aad=set → throws; and the reverse (TS ct → pyDecrypt) → ok:false.
6. Envelope shape: a PY-produced kms2 ct starts with "kms2:1:" and a TS-produced one also "kms2:1:" (same wire format).

TDD: write the test, run it RED-then-GREEN against live Python — \`cd ${REPO} && npx vitest run test/parity/crypto_cross_impl.parity.test.ts\` until FULLY GREEN. Then \`npx tsc -p tsconfig.json\` + \`npx eslint\` your 2 .ts files. If a cross-decrypt FAILS, the bug is byte-order (nonce||ct||tag), AAD encoding (ascii vs utf8 — they're identical for these strings), or base64 — diagnose against the Python source.

Return files_written, the FINAL vitest pass-count line, tsc/eslint results, all_green, and notes stating whether BOTH directions cross-decrypt and AAD binding holds cross-impl.`.replace('${BUILD_SUMMARY}', JSON.stringify(buildRes).slice(0, 900))

const parityRes = await agent(PARITY_BRIEF, { label: 'crypto cross-impl parity', phase: 'Parity', schema: BUILD_SCHEMA })

// =================================================================================================
phase('Verify')

const VERIFY_BRIEF = `You are an ADVERSARIAL security verifier for the just-built TS AES-256-GCM field-encryption (ADR-0033 kms2 envelope). Your job is to REFUTE that it is byte-compatible and AAD-safe vs the frozen Python. Default skeptical — a crypto port that "passes its own test" can still be subtly wrong.
${STYLE}

Built: crypto = ${'${PARITY_SUMMARY}'}

Independently (do NOT trust the build's test) verify each property — drive the LIVE frozen Python directly AND the TS module via a throwaway tsx script (e.g. ${REPO}/tools/parity/_crypto_scratch.ts; DELETE it when done; do not git-add):
1. CROSS-DECRYPT BOTH WAYS round-trips: PY-encrypt(kms2, aad="core.users.email", "alice@example.com") → TS-decrypt(same aad) == plaintext; and TS-encrypt → PY-decrypt. Use the real frozen modules:
   cd ${REPO}/vendor/codemaster-py && .venv/bin/python -c "import base64; from codemaster.security.key_registry import KeyRegistry,KeySet; from codemaster.security.local_key_field_encryption import encrypt,decrypt; k=bytes(range(32)); r=KeyRegistry(); r.set(KeySet(current_version='1',keys={'1':k})); ct=encrypt(b'alice@example.com', registry=r, aad=b'core.users.email'); print(ct)"  → then TS-decrypt that exact ct with the same key+aad and confirm == b'alice@example.com'.
2. AAD BINDING is real (the whole point): a kms2 ct made with aad="core.users.email" MUST FAIL to decrypt under aad="audit.audit_events.before" on BOTH impls (TS throws, Python raises LocalKeyEncryptionError). If it decrypts under the wrong aad, the security property is BROKEN.
3. PREFIX↔AAD coupling: kms2 ct decrypted with no aad → fail; kms ct decrypted with aad → fail; cross-impl in both directions.
4. TAMPER rejection: flip one byte of a PY-produced ct's tag region → TS-decrypt must throw "auth tag mismatch"; and vice versa.
5. WRONG KEY: decrypt a ct with a different 32-byte key → both fail.
6. KEY VERSION not loaded: ct under version "1", registry holds only "2" → both fail with a key-version error.
7. ENVELOPE WIRE FORMAT: confirm PY and TS kms2 envelopes are structurally identical — "kms2:" + version + ":" + base64, where base64 decodes to >= 28 bytes (12 nonce + >=0 ct + 16 tag); decode a PY ct and a TS ct of the SAME 5-byte plaintext and confirm both decode to 12+5+16=33 bytes.
8. TEST-IS-REAL: open test/parity/crypto_cross_impl.parity.test.ts — confirm it actually awaits pyEncrypt/pyDecrypt (spawns the frozen venv python) and asserts byte-equality + rejection (not skipped/.todo/vacuous). Run \`cd ${REPO} && npx vitest run test/parity/crypto_cross_impl.parity.test.ts test/unit/crypto/aes_gcm_aad.test.ts\` and read the pass counts.
9. GATE: \`npx tsx scripts/gates/check_clock_random.ts\` is still 0 violations (the crypto files must not call raw crypto.* random outside the randomness seam).

For ANY property that does NOT hold, give exact reproduction (the ct, the key, the aads, py-vs-ts result). Set verdict=BROKEN if any of properties 1-6 fail; SECURE_CROSS_IMPL only if ALL hold and the test is real. Clean up scratch files.`.replace('${PARITY_SUMMARY}', JSON.stringify(parityRes).slice(0, 900))

const verifyRes = await agent(VERIFY_BRIEF, { label: 'adversarial crypto verify', phase: 'Verify', schema: VERIFY_SCHEMA })

return { build: buildRes, parity: parityRes, verify: verifyRes }
