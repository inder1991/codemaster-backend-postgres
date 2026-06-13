// Email field codec — two halves:
//   1. AAD-bound AES-256-GCM string encryption. The per-column AAD constant is bound into the GCM tag
//      so a ciphertext for one column can't be moved to another and decrypt cleanly.
//   2. Deterministic SHA-256 fingerprint of the lowercased email for UNIQUE-by-email lookup without
//      exposing plaintext at the index (email_fingerprint column).
//
// Key registry is injected — repo passes the shared field-encryption registry, tests pass a known key.

import { createHash } from "node:crypto";

import { decryptField, encryptField } from "#platform/crypto/aes_gcm_aad.js";
import type { KeyRegistry } from "#platform/crypto/key_registry.js";

/** AAD for `core.local_users.email_ciphertext`. */
export const LOCAL_USER_EMAIL_AAD: Uint8Array = new TextEncoder().encode(
  "core.local_users.email_ciphertext",
);
/** AAD for `core.users.email`. */
export const CORE_USER_EMAIL_AAD: Uint8Array = new TextEncoder().encode("core.users.email");

/** Encrypt a plaintext email string under the given per-column AAD → `kms2:vN:<base64>` envelope. */
export function encryptEmail(plaintext: string, registry: KeyRegistry, aad: Uint8Array): string {
  return encryptField({ plaintext: new TextEncoder().encode(plaintext), registry, aad });
}

/** Decrypt an email envelope under the same per-column AAD. Throws on AAD mismatch / tamper / wrong key. */
export function decryptEmail(ciphertext: string, registry: KeyRegistry, aad: Uint8Array): string {
  return new TextDecoder().decode(decryptField({ ciphertext, registry, aad }));
}

/** SHA-256 hex of the lowercased email — deterministic, never reversible; backs the UNIQUE index. */
export function emailFingerprint(email: string): string {
  return createHash("sha256").update(email.toLowerCase(), "utf-8").digest("hex");
}
