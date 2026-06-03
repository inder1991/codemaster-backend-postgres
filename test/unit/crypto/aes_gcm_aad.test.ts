// Behavior tests for the ADR-0033 local AES-256-GCM field-encryption crypto layer — TS port of
// vendor/codemaster-py/codemaster/security/local_key_field_encryption.py + key_registry.py.
//
// Byte-exact envelope + AAD passthrough is security-critical: a drift makes encrypted DB columns
// cross-unreadable between the Python and TS implementations. These tests assert the round-trip,
// the prefix<->aad coupling, malformed-envelope rejection, and the KeyRegistry error surface.
import { describe, it, expect } from "vitest";

import {
  CIPHERTEXT_PREFIX,
  CIPHERTEXT_PREFIX_AAD,
  LocalKeyEncryptionError,
  decryptField,
  encryptField,
} from "#platform/crypto/aes_gcm_aad.js";
import {
  KeyRegistry,
  KeyNotFoundError,
  NoCurrentKeyError,
  makeKeySet,
} from "#platform/crypto/key_registry.js";

/** Build a KeyRegistry holding a single fixed 32-byte test key at the given version. */
function registryWithKey(version: string, fill = 0x42): KeyRegistry {
  const key = new Uint8Array(32).fill(fill);
  const registry = new KeyRegistry();
  registry.set(makeKeySet({ currentVersion: version, keys: new Map([[version, key]]) }));
  return registry;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("encryptField / decryptField round-trip (kms2: AAD-bound)", () => {
  const aad = utf8("core.users.email");

  it("round-trips utf8 plaintext with matching aad", () => {
    const registry = registryWithKey("1");
    const plaintext = utf8("alice@example.com");
    const ct = encryptField({ plaintext, registry, aad });
    expect(decryptField({ ciphertext: ct, registry, aad })).toEqual(plaintext);
  });

  it("round-trips binary plaintext with matching aad", () => {
    const registry = registryWithKey("1");
    const plaintext = new Uint8Array([0x00, 0xff, 0x10, 0x7f, 0x80, 0xab]);
    const ct = encryptField({ plaintext, registry, aad });
    expect(decryptField({ ciphertext: ct, registry, aad })).toEqual(plaintext);
  });

  it("round-trips empty plaintext with matching aad", () => {
    const registry = registryWithKey("1");
    const plaintext = new Uint8Array(0);
    const ct = encryptField({ plaintext, registry, aad });
    expect(decryptField({ ciphertext: ct, registry, aad })).toEqual(plaintext);
  });

  it("round-trips 1-byte plaintext with matching aad", () => {
    const registry = registryWithKey("1");
    const plaintext = new Uint8Array([0x5a]);
    const ct = encryptField({ plaintext, registry, aad });
    expect(decryptField({ ciphertext: ct, registry, aad })).toEqual(plaintext);
  });

  it("round-trips a 100KB plaintext with matching aad", () => {
    const registry = registryWithKey("1");
    const plaintext = new Uint8Array(100 * 1024);
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = (i * 7 + 3) & 0xff;
    const ct = encryptField({ plaintext, registry, aad });
    expect(decryptField({ ciphertext: ct, registry, aad })).toEqual(plaintext);
  });
});

describe("encryptField / decryptField round-trip (kms: no aad)", () => {
  it("round-trips utf8 plaintext without aad", () => {
    const registry = registryWithKey("1");
    const plaintext = utf8("bob@example.com");
    const ct = encryptField({ plaintext, registry });
    expect(decryptField({ ciphertext: ct, registry })).toEqual(plaintext);
  });

  it("round-trips binary + empty + 1-byte + 100KB without aad", () => {
    const registry = registryWithKey("1");
    const big = new Uint8Array(100 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 13 + 1) & 0xff;
    const cases: ReadonlyArray<Uint8Array> = [
      new Uint8Array([0x00, 0xff, 0x7f, 0x80]),
      new Uint8Array(0),
      new Uint8Array([0x01]),
      big,
    ];
    for (const plaintext of cases) {
      const ct = encryptField({ plaintext, registry });
      expect(decryptField({ ciphertext: ct, registry })).toEqual(plaintext);
    }
  });
});

describe("AAD binding (security property)", () => {
  it("throws when decrypting a kms2 ciphertext with the WRONG aad", () => {
    const registry = registryWithKey("1");
    const ct = encryptField({ plaintext: utf8("secret"), registry, aad: utf8("core.users.email") });
    expect(() =>
      decryptField({ ciphertext: ct, registry, aad: utf8("audit.audit_events.before") }),
    ).toThrow(LocalKeyEncryptionError);
  });

  it("throws when a kms2 ciphertext is decrypted with aad=undefined (prefix/aad mismatch)", () => {
    const registry = registryWithKey("1");
    const ct = encryptField({ plaintext: utf8("secret"), registry, aad: utf8("core.users.email") });
    expect(() => decryptField({ ciphertext: ct, registry })).toThrow(LocalKeyEncryptionError);
    expect(() => decryptField({ ciphertext: ct, registry })).toThrow(/requires aad=/);
  });

  it("throws when a kms ciphertext is decrypted WITH aad (prefix/aad mismatch)", () => {
    const registry = registryWithKey("1");
    const ct = encryptField({ plaintext: utf8("secret"), registry });
    expect(() => decryptField({ ciphertext: ct, registry, aad: utf8("core.users.email") })).toThrow(
      LocalKeyEncryptionError,
    );
    expect(() => decryptField({ ciphertext: ct, registry, aad: utf8("core.users.email") })).toThrow(
      /encrypted without aad/,
    );
  });
});

describe("tampering detection", () => {
  it("throws auth tag mismatch when a base64 char is flipped", () => {
    const registry = registryWithKey("1");
    const aad = utf8("core.users.email");
    const ct = encryptField({ plaintext: utf8("tamper-me-please-aaaa"), registry, aad });
    // ct shape: "kms2:1:<base64>". Flip a char in the payload to a different base64-alphabet char.
    const payloadIdx = ct.lastIndexOf(":") + 5; // safely inside the base64 body
    const orig = ct[payloadIdx]!;
    const swap = orig === "A" ? "B" : "A";
    const tampered = ct.slice(0, payloadIdx) + swap + ct.slice(payloadIdx + 1);
    expect(() => decryptField({ ciphertext: tampered, registry, aad })).toThrow(
      /auth tag mismatch/,
    );
  });

  it("throws auth tag mismatch when a tag byte is flipped", () => {
    const registry = registryWithKey("1");
    const aad = utf8("core.users.email");
    const ct = encryptField({ plaintext: utf8("flip-a-tag-byte"), registry, aad });
    const [prefix, version, b64] = ct.split(":");
    const bytes = Buffer.from(b64!, "base64");
    const last = bytes.length - 1;
    bytes[last] = (bytes[last]! ^ 0x01) & 0xff; // flip the last byte (inside the 16-byte GCM tag)
    const tampered = `${prefix}:${version}:${bytes.toString("base64")}`;
    expect(() => decryptField({ ciphertext: tampered, registry, aad })).toThrow(
      /auth tag mismatch/,
    );
  });
});

describe("malformed envelopes", () => {
  const registry = registryWithKey("1");
  const aad = utf8("core.users.email");

  it("throws on unexpected prefix", () => {
    expect(() => decryptField({ ciphertext: "kms3:1:AAAA", registry, aad })).toThrow(
      /unexpected prefix/,
    );
  });

  it("throws on 'kms2:' only (no version, no payload)", () => {
    expect(() => decryptField({ ciphertext: "kms2:", registry, aad })).toThrow(/malformed/);
  });

  it("throws on 'kms2:1:' with empty payload", () => {
    expect(() => decryptField({ ciphertext: "kms2:1:", registry, aad })).toThrow(/malformed/);
  });

  it("throws on 'kms2::<b64>' with empty version", () => {
    expect(() => decryptField({ ciphertext: "kms2::AAAAAAAAAAAAAAAAAAAAAAAA", registry, aad })).toThrow(
      /malformed/,
    );
  });

  it("throws on non-base64 payload", () => {
    expect(() => decryptField({ ciphertext: "kms2:1:not valid base64!!", registry, aad })).toThrow(
      /invalid base64/,
    );
  });

  it("throws on a payload shorter than nonce + tag", () => {
    // "AAAA" decodes to 3 bytes < 12 + 16.
    expect(() => decryptField({ ciphertext: "kms2:1:AAAA", registry, aad })).toThrow(
      /shorter than nonce \+ tag/,
    );
  });
});

describe("key version not loaded", () => {
  it("throws when the decrypting registry lacks the encrypting version", () => {
    const encRegistry = registryWithKey("1");
    const decRegistry = registryWithKey("2"); // only has version "2"
    const aad = utf8("core.users.email");
    const ct = encryptField({ plaintext: utf8("cross-version"), registry: encRegistry, aad });
    expect(() => decryptField({ ciphertext: ct, registry: decRegistry, aad })).toThrow(
      LocalKeyEncryptionError,
    );
    expect(() => decryptField({ ciphertext: ct, registry: decRegistry, aad })).toThrow(
      /key version '1' not loaded/,
    );
  });

  it("throws LocalKeyEncryptionError 'no current key loaded' when encrypting with an unset registry", () => {
    const registry = new KeyRegistry();
    expect(() => encryptField({ plaintext: utf8("x"), registry, aad: utf8("a") })).toThrow(
      /no current key loaded/,
    );
  });
});

describe("envelope prefix shape + nonce randomness", () => {
  it("uses 'kms2:1:' for the aad path and 'kms:1:' for the no-aad path", () => {
    const registry = registryWithKey("1");
    const withAad = encryptField({ plaintext: utf8("x"), registry, aad: utf8("a") });
    const noAad = encryptField({ plaintext: utf8("x"), registry });
    expect(withAad.startsWith(`${CIPHERTEXT_PREFIX_AAD}1:`)).toBe(true);
    expect(noAad.startsWith(`${CIPHERTEXT_PREFIX}1:`)).toBe(true);
    // kms: must NOT match the longer kms2: prefix.
    expect(noAad.startsWith(CIPHERTEXT_PREFIX_AAD)).toBe(false);
  });

  it("produces different envelopes for the same input (random nonce) but both decrypt", () => {
    const registry = registryWithKey("1");
    const aad = utf8("core.users.email");
    const plaintext = utf8("same input, different nonce");
    const a = encryptField({ plaintext, registry, aad });
    const b = encryptField({ plaintext, registry, aad });
    expect(a).not.toEqual(b);
    expect(decryptField({ ciphertext: a, registry, aad })).toEqual(plaintext);
    expect(decryptField({ ciphertext: b, registry, aad })).toEqual(plaintext);
  });
});

describe("KeyRegistry error surface", () => {
  it("current() throws NoCurrentKeyError when unset", () => {
    const registry = new KeyRegistry();
    expect(() => registry.current()).toThrow(NoCurrentKeyError);
  });

  it("get() throws KeyNotFoundError when unset", () => {
    const registry = new KeyRegistry();
    expect(() => registry.get("1")).toThrow(KeyNotFoundError);
  });

  it("get() throws KeyNotFoundError when the version is absent", () => {
    const registry = registryWithKey("1");
    expect(() => registry.get("2")).toThrow(KeyNotFoundError);
  });

  it("versions() returns an empty set when unset and the loaded set when set", () => {
    const registry = new KeyRegistry();
    expect(registry.versions().size).toBe(0);
    registry.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32)]]) }));
    expect([...registry.versions()].sort()).toEqual(["1"]);
  });

  it("current() returns { version, key } after set", () => {
    const registry = registryWithKey("1", 0x11);
    const { version, key } = registry.current();
    expect(version).toBe("1");
    expect(key).toEqual(new Uint8Array(32).fill(0x11));
  });
});

describe("makeKeySet validation", () => {
  it("rejects a 31-byte key", () => {
    expect(() =>
      makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(31)]]) }),
    ).toThrow(/31 bytes/);
  });

  it("rejects a currentVersion not present in keys", () => {
    expect(() =>
      makeKeySet({ currentVersion: "9", keys: new Map([["1", new Uint8Array(32)]]) }),
    ).toThrow(/not in keys/);
  });

  it("rejects an empty keys map", () => {
    expect(() => makeKeySet({ currentVersion: "1", keys: new Map() })).toThrow(/at least one/);
  });

  it("freezes a private copy so post-construction mutation of the input map cannot leak in", () => {
    const input = new Map<string, Uint8Array>([["1", new Uint8Array(32).fill(0x42)]]);
    const keyset = makeKeySet({ currentVersion: "1", keys: input });
    input.set("2", new Uint8Array(32).fill(0x99)); // mutate AFTER construction
    expect(keyset.keys.has("2")).toBe(false);
    expect([...keyset.keys.keys()]).toEqual(["1"]);
  });
});
