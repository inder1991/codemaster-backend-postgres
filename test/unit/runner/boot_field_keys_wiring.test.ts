// CS6 (EC5) wiring: BOTH live boot surfaces install the field-encryption key registry, decoupled
// from CODEMASTER_AUTH_ROUTES_ENABLED — in production a pod whose key source is unavailable must
// REFUSE to boot (the rejection reaches each entrypoint's fail-loud process.exit(1) catch) BEFORE
// any loop starts / any Temporal connection is attempted. Proven the mode-guard way: production
// env + no Vault → the boot promise rejects with the field-encryption refusal, not a later error.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runBackgroundRunner,
  wireFieldKeyRefreshLoop,
} from "#backend/runner/background_runner_main.js";
import { DisposableRegistry } from "#backend/runner/disposables.js";
import {
  getAuditKeyRegistry,
  resetAuditKeyRegistryForTesting,
} from "#backend/security/audit_field_codec.js";

import { WallClock } from "#platform/clock.js";

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

  it("dev boot (no source set) SKIPS key loading and proceeds to the ordinary config fail-loud — never requires Vault", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VAULT_ADDR", "");
    vi.stubEnv("CODEMASTER_FIELD_KEY_SOURCE", "");
    vi.stubEnv("CODEMASTER_PG_CORE_DSN", "");
    // The boot gets PAST the key step (skipped) and fails on the DSN, exactly as before CS6.
    await expect(runBackgroundRunner("postgres")).rejects.toThrow(/CODEMASTER_PG_CORE_DSN/);
  });
});

// ─── W3.7 (EH4): the runner boot wires the 30-min key-refresh loop with a DISPOSE handle ─────────
describe("wireFieldKeyRefreshLoop — the runner-boot seam for the W3.7 rotation refresh", () => {
  it("installResult='installed' → the refresh loop is registered on the DisposableRegistry and disposeAll stops it", async () => {
    const disposables = new DisposableRegistry();
    wireFieldKeyRefreshLoop({
      installResult: "installed",
      env: { NODE_ENV: "production" },
      clock: new WallClock(),
      disposables,
    });
    // The dispose handle rides the SAME registry runBackgroundRunner's DISPOSE PHASE drains after
    // SIGTERM — without it the 30-min interval sleep would outlive the stopped loops.
    expect(disposables.registeredNames()).toContain("field-key-refresh-loop");
    await disposables.disposeAll(); // must interrupt the in-flight interval sleep and resolve
  }, 10_000);

  it("installResult='skipped' (dev/test no-source) → NO refresh loop is started (nothing to refresh)", async () => {
    const disposables = new DisposableRegistry();
    wireFieldKeyRefreshLoop({
      installResult: "skipped",
      env: { NODE_ENV: "development" },
      clock: new WallClock(),
      disposables,
    });
    expect(disposables.registeredNames()).not.toContain("field-key-refresh-loop");
  });
});
