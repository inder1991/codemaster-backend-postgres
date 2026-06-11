// CS6 (EC5) wiring: BOTH live boot surfaces install the field-encryption key registry, decoupled
// from CODEMASTER_AUTH_ROUTES_ENABLED — in production a pod whose key source is unavailable must
// REFUSE to boot (the rejection reaches each entrypoint's fail-loud process.exit(1) catch) BEFORE
// any loop starts / any Temporal connection is attempted. Proven the mode-guard way: production
// env + no Vault → the boot promise rejects with the field-encryption refusal, not a later error.
import { afterEach, describe, expect, it, vi } from "vitest";

import { runBackgroundRunner } from "#backend/runner/background_runner_main.js";
import { runWorker } from "#backend/worker/main.js";
import {
  getAuditKeyRegistry,
  resetAuditKeyRegistryForTesting,
} from "#backend/security/audit_field_codec.js";

describe("CS6 boot wiring — key registry is loaded at boot, fail-loud in production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetAuditKeyRegistryForTesting();
  });

  it("runBackgroundRunner (postgres mode) in PRODUCTION with no Vault: rejects with the field-encryption refusal", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VAULT_ADDR", "");
    vi.stubEnv("CODEMASTER_FIELD_KEY_SOURCE", "");
    // A DSN is present: if the key install did not fire, the boot would proceed toward sink wiring
    // and the DB instead of this specific refusal.
    vi.stubEnv("CODEMASTER_PG_CORE_DSN", "postgresql://keys-must-fire-first:5432/never");
    await expect(runBackgroundRunner("postgres")).rejects.toThrow(/field-encryption/i);
    expect(getAuditKeyRegistry()).toBeNull();
  });

  it("runWorker (temporal mode) in PRODUCTION with no Vault: rejects with the field-encryption refusal BEFORE any Temporal connect", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VAULT_ADDR", "");
    vi.stubEnv("CODEMASTER_FIELD_KEY_SOURCE", "");
    // No TEMPORAL_ADDRESS either — if the key install did not fire FIRST, the boot would fail on
    // the Temporal production-misconfiguration guard instead; the assertion pins the ordering.
    vi.stubEnv("TEMPORAL_ADDRESS", "");
    await expect(runWorker()).rejects.toThrow(/field-encryption/i);
    expect(getAuditKeyRegistry()).toBeNull();
  });

  it("dev boot (no source set) SKIPS key loading and proceeds to the ordinary config fail-loud — never requires Vault", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VAULT_ADDR", "");
    vi.stubEnv("CODEMASTER_FIELD_KEY_SOURCE", "");
    vi.stubEnv("CODEMASTER_PG_CORE_DSN", "");
    // The boot gets PAST the key step (skipped) and fails on the DSN, exactly as before CS6.
    await expect(runBackgroundRunner("postgres")).rejects.toThrow(/CODEMASTER_PG_CORE_DSN/);
  });
});
