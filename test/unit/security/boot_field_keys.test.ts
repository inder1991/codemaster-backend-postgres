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
import { afterEach, describe, expect, it, vi } from "vitest";
import { WallClock } from "#platform/clock.js";
import {
  FIELD_KEY_REFRESH_INTERVAL_SECONDS,
  FieldKeyBootError,
  installFieldKeyRegistryAtBoot,
  refreshFieldKeyRegistryOnce,
  startFieldKeyRefreshLoop,
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
  vi.unstubAllEnvs();
});

describe("installFieldKeyRegistryAtBoot — production posture", () => {
  it("(1) PROD + Vault unavailable: throws FieldKeyBootError and installs NOTHING (fail-loud, no silent degradation)", async () => {
    // NODE_ENV=production, no CODEMASTER_FIELD_KEY_SOURCE → the default source is vault; no
    // VAULT_ADDR → the Vault client cannot even be constructed. Boot must REFUSE.
    // (Hermeticity: VaultHttpPort.fromEnv reads the REAL process.env — scrub the host's Vault vars
    // so a developer shell with VAULT_ADDR exported cannot turn this into a live Vault call.)
    vi.stubEnv("VAULT_ADDR", "");
    vi.stubEnv("VAULT_TOKEN", "");
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

// ─── W3.7 (EH4): the periodic key-rotation refresh — a rotated Vault keyset is picked up WITHOUT a
// pod restart. Keys still load ONCE at boot (CS6.1); the refresh loop re-loads the registry every
// ~30min and swaps it atomically via setAuditKeyRegistry ON SUCCESS ONLY — on ANY failure it logs a
// structured WARN and KEEPS the previous registry (a working registry is never degraded). ─────────
describe("refreshFieldKeyRegistryOnce — hot rotation pickup (W3.7 / EH4)", () => {
  const ROTATED_KEY_B64 = Buffer.alloc(32, 9).toString("base64");
  const ROTATED_PAYLOAD = { current_version: "v2", keys: { v1: KEY_B64, v2: ROTATED_KEY_B64 } };

  it("(10) a ROTATED keyset is reloaded and swapped atomically — new writes use v2, OLD v1 rows still decrypt", async () => {
    await installFieldKeyRegistryAtBoot(
      { NODE_ENV: "production" },
      { reader: { kvReadRaw: async () => KEYSET_PAYLOAD } },
    );
    const oldCiphertext = encryptAuditJsonBytea({ probe: "pre-rotation" }, AUDIT_BEFORE_AAD);
    expect(oldCiphertext!.toString("ascii").startsWith("kms2:v1:")).toBe(true);

    // The operator rotates in Vault (adds v2, advances current_version) — the refresh must pick it
    // up in-process: the EH4 class is long-lived pods encrypting under the OLD current_version
    // forever (and failing to DECRYPT rows newer pods wrote under v2) until restarted.
    const result = await refreshFieldKeyRegistryOnce(
      { NODE_ENV: "production" },
      { reader: { kvReadRaw: async () => ROTATED_PAYLOAD } },
    );
    expect(result).toBe("refreshed");

    const newCiphertext = encryptAuditJsonBytea({ probe: "post-rotation" }, AUDIT_BEFORE_AAD);
    expect(newCiphertext!.toString("ascii").startsWith("kms2:v2:")).toBe(true); // rotated current key
    expect(decryptAuditJsonBytea(newCiphertext, AUDIT_BEFORE_AAD)).toEqual({ probe: "post-rotation" });
    // Rotation continuity: the swapped keyset still carries v1, so pre-rotation rows stay readable.
    expect(decryptAuditJsonBytea(oldCiphertext, AUDIT_BEFORE_AAD)).toEqual({ probe: "pre-rotation" });
  });

  it("(11) a refresh FAILURE (source unreachable) keeps the previous registry and WARNs structured — never degrade a working registry", async () => {
    await installFieldKeyRegistryAtBoot(
      { NODE_ENV: "production" },
      { reader: { kvReadRaw: async () => KEYSET_PAYLOAD } },
    );
    const before = getAuditKeyRegistry();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await refreshFieldKeyRegistryOnce(
        { NODE_ENV: "production" },
        { reader: { kvReadRaw: async () => { throw new Error("vault sealed"); } } },
      );
      expect(result).toBe("kept-previous");
      expect(getAuditKeyRegistry()).toBe(before); // the WORKING registry is untouched
      // Still encrypting/decrypting under the boot keys — no degradation window.
      const ct = encryptAuditJsonBytea({ probe: "still-v1" }, AUDIT_BEFORE_AAD);
      expect(ct!.toString("ascii").startsWith("kms2:v1:")).toBe(true);
      const warns = warnSpy.mock.calls.map((c) => String(c[0]));
      const refreshWarns = warns.filter((m) => m.includes("field_key_refresh.failed"));
      expect(refreshWarns).toHaveLength(1); // ONE structured WARN per failed refresh
      expect(refreshWarns[0]).toContain("vault sealed");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("(12) a keyset the loader REJECTS (malformed rotation) keeps the previous registry — same fail-open posture", async () => {
    await installFieldKeyRegistryAtBoot(
      { NODE_ENV: "production" },
      { reader: { kvReadRaw: async () => KEYSET_PAYLOAD } },
    );
    const before = getAuditKeyRegistry();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await refreshFieldKeyRegistryOnce(
        { NODE_ENV: "production" },
        // current_version names a key that is NOT in the keyset — makeKeySet rejects it.
        { reader: { kvReadRaw: async () => ({ current_version: "v9", keys: { v1: KEY_B64 } }) } },
      );
      expect(result).toBe("kept-previous");
      expect(getAuditKeyRegistry()).toBe(before);
      expect(
        warnSpy.mock.calls.map((c) => String(c[0])).some((m) => m.includes("field_key_refresh.failed")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("(13) the refresh cadence is the ADR-0033 / EH4 30 minutes", () => {
    expect(FIELD_KEY_REFRESH_INTERVAL_SECONDS).toBe(1800);
  });
});

describe("startFieldKeyRefreshLoop — supervised interval loop with a dispose handle (W3.7 / EH4)", () => {
  const ROTATED_KEY_B64 = Buffer.alloc(32, 9).toString("base64");

  it("(14) the loop refreshes on its interval and dispose() stops it (RunnerDisposable shape)", async () => {
    await installFieldKeyRegistryAtBoot(
      { NODE_ENV: "production" },
      { reader: { kvReadRaw: async () => KEYSET_PAYLOAD } },
    );
    let reads = 0;
    const disposable = startFieldKeyRefreshLoop({
      env: { NODE_ENV: "production" },
      clock: new WallClock(), // tiny REAL interval — FakeClock.sleep resolves instantly (hot loop)
      intervalSeconds: 0.02,
      jitterSeconds: 0,
      deps: {
        reader: {
          kvReadRaw: async () => {
            reads += 1;
            return { current_version: "v2", keys: { v1: KEY_B64, v2: ROTATED_KEY_B64 } };
          },
        },
      },
    });
    expect(disposable.name).toBe("field-key-refresh-loop");
    try {
      const deadline = Date.now() + 5000;
      while (reads === 0) {
        if (Date.now() > deadline) throw new Error("refresh loop did not refresh within 5s");
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      await disposable.dispose();
    }
    // The loop actually swapped the registry (v2 is current now) …
    const ct = encryptAuditJsonBytea({ probe: "loop" }, AUDIT_BEFORE_AAD);
    expect(ct!.toString("ascii").startsWith("kms2:v2:")).toBe(true);
    // … and dispose() STOPPED it: no further reads land after disposal settles.
    const after = reads;
    await new Promise((r) => setTimeout(r, 100));
    expect(reads).toBe(after);
  }, 10_000);

  it("(15) dispose() interrupts the interval sleep immediately — no refresh ever fires", async () => {
    let reads = 0;
    const disposable = startFieldKeyRefreshLoop({
      env: { NODE_ENV: "production" },
      clock: new WallClock(),
      intervalSeconds: 600, // without the interrupt this dispose would block the 10s test timeout
      deps: { reader: { kvReadRaw: async () => { reads += 1; return KEYSET_PAYLOAD; } } },
    });
    await disposable.dispose();
    expect(reads).toBe(0); // disposed before the first interval elapsed — the loop never refreshed
  }, 10_000);
});

describe("installFieldKeyRegistryAtBoot — keyset file content never leaks into errors (review fix)", () => {
  it("(9) a malformed keyset file fails with a CONTENT-FREE message — key material never reaches boot logs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs6-leak-"));
    try {
      const file = join(dir, "keyset.json");
      // An unquoted value — the V8 SyntaxError shape that embeds an input snippet (i.e. key bytes)
      // into e.message. The boot error must NOT carry it (FileKvReader's sterile-message rule).
      writeFileSync(file, `{"current_version":"v1","keys":{"v1":${KEY_B64.slice(0, 16)}}}`, "utf-8");
      const err = await installFieldKeyRegistryAtBoot({
        NODE_ENV: "development",
        CODEMASTER_FIELD_KEY_SOURCE: "file",
        CODEMASTER_FIELD_KEYSET_FILE: file,
      }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(FieldKeyBootError);
      expect((err as Error).message).toContain("not valid JSON");
      expect((err as Error).message).not.toContain(KEY_B64.slice(0, 8)); // no key bytes, ever
      expect(getAuditKeyRegistry()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
