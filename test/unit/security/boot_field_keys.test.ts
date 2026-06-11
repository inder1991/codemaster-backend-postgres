// CS6 (EC5 — cutover-safety, part A): field-encryption key registry installed AT BOOT, decoupled
// from CODEMASTER_AUTH_ROUTES_ENABLED. Today the ONLY loader call is runServer's auth-gated block
// (api/server.ts:66-76), so every worker/runner pod boots with a NULL registry and the first
// audit-emitting code path (reapStuckRuns, mutex janitor, retention crons, …) throws
// LocalKeyEncryptionError — re-wedging the ADR-0064 stuck-review class. installFieldKeyRegistryAtBoot
// is the new boot seam:
//   * production (NODE_ENV=production): the registry MUST load (default source: vault) — any
//     failure throws FieldKeyBootError; the entrypoint's fail-loud .catch turns that into
//     process.exit(1). No silent degradation.
//   * dev/test: an EXPLICIT source (CODEMASTER_FIELD_KEY_SOURCE=vault|vault-agent|file) loads
//     fail-loud; NO source → skip (registry stays null; the codec stays fail-closed — never a
//     silent unencrypted write).
//   * startup self-check: an encrypt→decrypt probe round-trips through the installed registry.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  FieldKeyBootError,
  installFieldKeyRegistryAtBoot,
} from "#backend/security/boot_field_keys.js";
import {
  AUDIT_BEFORE_AAD,
  decryptAuditJsonBytea,
  encryptAuditJsonBytea,
  getAuditKeyRegistry,
  resetAuditKeyRegistryForTesting,
} from "#backend/security/audit_field_codec.js";

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const KEYSET_PAYLOAD = { current_version: "v1", keys: { v1: KEY_B64 } };

afterEach(() => {
  resetAuditKeyRegistryForTesting();
});

describe("installFieldKeyRegistryAtBoot — production posture", () => {
  it("(1) PROD + Vault unavailable: throws FieldKeyBootError and installs NOTHING (fail-loud, no silent degradation)", async () => {
    // NODE_ENV=production, no CODEMASTER_FIELD_KEY_SOURCE → the default source is vault; no
    // VAULT_ADDR → the Vault client cannot even be constructed. Boot must REFUSE.
    const err = await installFieldKeyRegistryAtBoot({ NODE_ENV: "production" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FieldKeyBootError);
    expect((err as Error).message).toMatch(/field-encryption/i);
    expect(getAuditKeyRegistry()).toBeNull();
  });

  it("(2) PROD + a working key source: installs the registry and the self-check round-trip holds", async () => {
    const result = await installFieldKeyRegistryAtBoot(
      { NODE_ENV: "production" },
      { reader: { kvReadRaw: async () => KEYSET_PAYLOAD } },
    );
    expect(result).toBe("installed");
    expect(getAuditKeyRegistry()).not.toBeNull();
    // The global codec now encrypts fail-closed under the installed keys.
    const ct = encryptAuditJsonBytea({ probe: "x" }, AUDIT_BEFORE_AAD);
    expect(ct!.toString("ascii").startsWith("kms2:")).toBe(true);
    expect(decryptAuditJsonBytea(ct, AUDIT_BEFORE_AAD)).toEqual({ probe: "x" });
  });

  it("(3) PROD + a keyset the loader rejects: throws FieldKeyBootError (the self-check never installs garbage)", async () => {
    const err = await installFieldKeyRegistryAtBoot(
      { NODE_ENV: "production" },
      { reader: { kvReadRaw: async () => ({ current_version: "v9", keys: { v1: KEY_B64 } }) } },
    ).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FieldKeyBootError);
    expect(getAuditKeyRegistry()).toBeNull();
  });
});

describe("installFieldKeyRegistryAtBoot — dev/test posture", () => {
  it("(4) dev with NO source: skips — registry stays null, codec stays fail-closed (never silent-unencrypted)", async () => {
    const result = await installFieldKeyRegistryAtBoot({ NODE_ENV: "development" });
    expect(result).toBe("skipped");
    expect(getAuditKeyRegistry()).toBeNull();
    expect(() => encryptAuditJsonBytea({ x: 1 }, AUDIT_BEFORE_AAD)).toThrow(/keys not loaded/);
  });

  it("(5) dev + CODEMASTER_FIELD_KEY_SOURCE=file: loads the keyset JSON from CODEMASTER_FIELD_KEYSET_FILE without Vault", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs6-keys-"));
    try {
      const file = join(dir, "keyset.json");
      writeFileSync(file, JSON.stringify(KEYSET_PAYLOAD), "utf-8");
      const result = await installFieldKeyRegistryAtBoot({
        NODE_ENV: "development",
        CODEMASTER_FIELD_KEY_SOURCE: "file",
        CODEMASTER_FIELD_KEYSET_FILE: file,
      });
      expect(result).toBe("installed");
      expect(getAuditKeyRegistry()).not.toBeNull();
      const ct = encryptAuditJsonBytea({ probe: "file" }, AUDIT_BEFORE_AAD);
      expect(decryptAuditJsonBytea(ct, AUDIT_BEFORE_AAD)).toEqual({ probe: "file" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(6) dev + source=file but CODEMASTER_FIELD_KEYSET_FILE unset: throws — an EXPLICIT source must never silently degrade", async () => {
    const err = await installFieldKeyRegistryAtBoot({
      NODE_ENV: "development",
      CODEMASTER_FIELD_KEY_SOURCE: "file",
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FieldKeyBootError);
    expect(getAuditKeyRegistry()).toBeNull();
  });

  it("(7) dev + source=vault-agent: loads the agent-rendered keyset file from CODEMASTER_VAULT_SECRETS_DIR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs6-agent-"));
    try {
      // The Agent renders `codemaster/field-encryption/keys` under the FileKvReader sanitization
      // rule (non-alphanumerics → '_'), consistent with every other agent-file secret.
      writeFileSync(join(dir, "codemaster_field_encryption_keys"), JSON.stringify(KEYSET_PAYLOAD), "utf-8");
      const result = await installFieldKeyRegistryAtBoot({
        NODE_ENV: "development",
        CODEMASTER_FIELD_KEY_SOURCE: "vault-agent",
        CODEMASTER_VAULT_SECRETS_DIR: dir,
      });
      expect(result).toBe("installed");
      expect(getAuditKeyRegistry()).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(8) a garbage CODEMASTER_FIELD_KEY_SOURCE refuses boot naming the valid values", async () => {
    const err = await installFieldKeyRegistryAtBoot({
      NODE_ENV: "development",
      CODEMASTER_FIELD_KEY_SOURCE: "keychain",
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FieldKeyBootError);
    expect((err as Error).message).toContain("vault-agent");
  });
});
