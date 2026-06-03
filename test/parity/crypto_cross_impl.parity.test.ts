// THE SECURITY PROOF: ciphertext written by EITHER impl (TS or frozen Python) decrypts in the OTHER
// under the same key + AAD. The dual-format read path (kms:/kms2:) depends on this — a drift makes
// encrypted DB columns cross-unreadable between the implementations.
//
// Because the AES-GCM nonce is random, ciphertexts CANNOT be byte-compared. Parity is proven by
// CROSS-DECRYPTION: encrypt on one side, decrypt on the other, assert the plaintext matches; and
// AAD binding is proven by asserting BOTH impls reject a mismatched aad cross-impl.
import { afterAll, describe, expect, it } from "vitest";

import { decryptField, encryptField, LocalKeyEncryptionError } from "#platform/crypto/aes_gcm_aad.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

import { pyDecrypt, pyEncrypt, shutdownCryptoRef } from "./crypto_oracle.js";

afterAll(() => shutdownCryptoRef());

// A distinct known 32-byte pattern (NOT the unit test's 0x42 fill) so the two suites can't mask a
// key-handling bug by coincidentally agreeing on the same key bytes. Bytes 0..31.
const TEST_KEY = new Uint8Array(32);
for (let i = 0; i < TEST_KEY.length; i++) TEST_KEY[i] = i;
const VERSION = "1";

/** The base64-key map the Python oracle expects: version -> raw key bytes. */
const KEYS: Readonly<Record<string, Uint8Array>> = { [VERSION]: TEST_KEY };

/** A TS KeyRegistry holding TEST_KEY at VERSION (the TS half of the cross-impl pair). */
function tsRegistry(): KeyRegistry {
  const registry = new KeyRegistry();
  registry.set(makeKeySet({ currentVersion: VERSION, keys: new Map([[VERSION, TEST_KEY]]) }));
  return registry;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// Real per-column AADs from the codebase (the AAD strings ADR-0033 binds into the auth tag).
const AAD_EMAIL = "core.users.email";
const AAD_AUDIT = "audit.audit_events.before";
const AAD_TOKEN = "cache.cache_tokens.token_ciphertext";
const REAL_AADS = [AAD_EMAIL, AAD_AUDIT, AAD_TOKEN] as const;

/** Representative plaintext payloads: ascii utf8, multibyte, empty, and 1KB binary. */
function plaintexts(): ReadonlyArray<{ readonly label: string; readonly bytes: Uint8Array }> {
  const oneKb = new Uint8Array(1024);
  for (let i = 0; i < oneKb.length; i++) oneKb[i] = (i * 7 + 3) & 0xff;
  return [
    { label: "utf8 ascii", bytes: utf8("alice@example.com") },
    { label: "multibyte", bytes: utf8("café→雪") },
    { label: "empty", bytes: new Uint8Array(0) },
    { label: "1KB binary", bytes: oneKb },
  ];
}

describe("cross-impl AES-256-GCM parity (ADR-0033 dual-format read path)", () => {
  describe("1. TS encrypt -> Python decrypt (kms2: AAD-bound)", () => {
    for (const aadStr of REAL_AADS) {
      for (const { label, bytes } of plaintexts()) {
        it(`aad=${aadStr} plaintext=${label} round-trips`, async () => {
          const aad = utf8(aadStr);
          const ct = encryptField({ plaintext: bytes, registry: tsRegistry(), aad });
          expect(ct.startsWith(`kms2:${VERSION}:`)).toBe(true);
          const result = await pyDecrypt({ keys: KEYS, ciphertext: ct, aad });
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.plaintext).toEqual(bytes);
        });
      }
    }
  });

  describe("2. Python encrypt -> TS decrypt (kms2: AAD-bound)", () => {
    for (const aadStr of REAL_AADS) {
      for (const { label, bytes } of plaintexts()) {
        it(`aad=${aadStr} plaintext=${label} round-trips`, async () => {
          const aad = utf8(aadStr);
          const ct = await pyEncrypt({ keys: KEYS, version: VERSION, plaintext: bytes, aad });
          expect(ct.startsWith(`kms2:${VERSION}:`)).toBe(true);
          const recovered = decryptField({ ciphertext: ct, registry: tsRegistry(), aad });
          expect(recovered).toEqual(bytes);
        });
      }
    }
  });

  describe("3. AAD binding holds cross-impl (BOTH directions reject the wrong aad)", () => {
    it("Python-encrypt(aad=email) then TS-decrypt(aad=audit) THROWS", async () => {
      const ct = await pyEncrypt({
        keys: KEYS,
        version: VERSION,
        plaintext: utf8("secret"),
        aad: utf8(AAD_EMAIL),
      });
      expect(() =>
        decryptField({ ciphertext: ct, registry: tsRegistry(), aad: utf8(AAD_AUDIT) }),
      ).toThrow(LocalKeyEncryptionError);
    });

    it("TS-encrypt(aad=email) then Python-decrypt(aad=audit) -> ok:false", async () => {
      const ct = encryptField({
        plaintext: utf8("secret"),
        registry: tsRegistry(),
        aad: utf8(AAD_EMAIL),
      });
      const result = await pyDecrypt({ keys: KEYS, ciphertext: ct, aad: utf8(AAD_AUDIT) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.err).toMatch(/auth tag mismatch/);
    });
  });

  describe("4. kms: (AAD-free) cross round-trips both directions", () => {
    for (const { label, bytes } of plaintexts()) {
      it(`TS-encrypt(no aad) -> Python-decrypt(no aad): ${label}`, async () => {
        const ct = encryptField({ plaintext: bytes, registry: tsRegistry() });
        expect(ct.startsWith(`kms:${VERSION}:`)).toBe(true);
        const result = await pyDecrypt({ keys: KEYS, ciphertext: ct, aad: undefined });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.plaintext).toEqual(bytes);
      });

      it(`Python-encrypt(no aad) -> TS-decrypt(no aad): ${label}`, async () => {
        const ct = await pyEncrypt({ keys: KEYS, version: VERSION, plaintext: bytes, aad: undefined });
        expect(ct.startsWith(`kms:${VERSION}:`)).toBe(true);
        const recovered = decryptField({ ciphertext: ct, registry: tsRegistry() });
        expect(recovered).toEqual(bytes);
      });
    }
  });

  describe("5. prefix<->aad mismatch is rejected cross-impl", () => {
    it("Python kms2: ct + TS-decrypt(aad=undefined) THROWS (kms2 requires aad)", async () => {
      const ct = await pyEncrypt({
        keys: KEYS,
        version: VERSION,
        plaintext: utf8("x"),
        aad: utf8(AAD_EMAIL),
      });
      expect(() => decryptField({ ciphertext: ct, registry: tsRegistry() })).toThrow(/requires aad=/);
    });

    it("Python kms: ct + TS-decrypt(aad=set) THROWS (kms predates aad)", async () => {
      const ct = await pyEncrypt({ keys: KEYS, version: VERSION, plaintext: utf8("x"), aad: undefined });
      expect(() =>
        decryptField({ ciphertext: ct, registry: tsRegistry(), aad: utf8(AAD_EMAIL) }),
      ).toThrow(/encrypted without aad/);
    });

    it("TS kms2: ct + Python-decrypt(aad=undefined) -> ok:false (kms2 requires aad)", async () => {
      const ct = encryptField({ plaintext: utf8("x"), registry: tsRegistry(), aad: utf8(AAD_EMAIL) });
      const result = await pyDecrypt({ keys: KEYS, ciphertext: ct, aad: undefined });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.err).toMatch(/requires aad=/);
    });

    it("TS kms: ct + Python-decrypt(aad=set) -> ok:false (kms predates aad)", async () => {
      const ct = encryptField({ plaintext: utf8("x"), registry: tsRegistry() });
      const result = await pyDecrypt({ keys: KEYS, ciphertext: ct, aad: utf8(AAD_EMAIL) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.err).toMatch(/encrypted without aad/);
    });
  });

  describe("6. envelope wire format is identical across impls", () => {
    it("a Python-produced kms2 ct and a TS-produced kms2 ct share the 'kms2:1:' prefix", async () => {
      const pyCt = await pyEncrypt({
        keys: KEYS,
        version: VERSION,
        plaintext: utf8("x"),
        aad: utf8(AAD_TOKEN),
      });
      const tsCt = encryptField({ plaintext: utf8("x"), registry: tsRegistry(), aad: utf8(AAD_TOKEN) });
      expect(pyCt.startsWith(`kms2:${VERSION}:`)).toBe(true);
      expect(tsCt.startsWith(`kms2:${VERSION}:`)).toBe(true);
    });
  });
});
