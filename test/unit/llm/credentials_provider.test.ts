// Unit coverage of the TTL-refreshing LlmCredentialsProvider (de-stub step 2, part 1) — the failure
// ladder + per-role cache + cheap rotation detection, driven by a FakeClock and a stub settings repo.
//
// The settings repo is a TEST double (this file only) satisfying LlmProviderSettingsRepoPort — it
// counts decrypt calls + scripts per-role return/throw + exposes a settable last_rotated_at so we can
// drive rotation detection. The production path uses the REAL PostgresLlmProviderSettingsRepo.
//
// Cases (the five the task names):
//   - fresh-hit: a second current() inside the TTL window does NO decrypt.
//   - TTL-expiry-refresh: advancing past the TTL forces a re-decrypt.
//   - rotation-detect-invalidates-early: a moved last_rotated_at refetches BEFORE the TTL expires.
//   - transient-fail-returns-stale: a decrypt throw inside the hard-stale window serves the prior
//     cache + logs the bedrock-credentials-refresh-failed rule.
//   - hard-stale-raises: a decrypt that keeps failing past hardStaleSeconds raises
//     LlmCredentialsExpiredError; and an initial-fail (no prior cache) raises immediately.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeClock } from "#platform/clock.js";

import {
  LlmCredentialsProvider,
  type LlmProviderSettingsRepoPort,
} from "#backend/integrations/llm/credentials_provider.js";
import {
  LlmCredentialsExpiredError,
  LlmRoleDisabledError,
  LlmRoleNotConfiguredError,
} from "#backend/integrations/llm/errors.js";
import {
  type LlmProviderRole,
  type LlmProviderSettings,
} from "#backend/integrations/llm/llm_provider_settings_repo.js";

const T0 = new Date("2026-06-04T00:00:00.000Z");

/** A scriptable settings-repo test double. Counts decrypts; per-role settings/throw + rotation ts. */
class StubRepo implements LlmProviderSettingsRepoPort {
  public decryptCalls = 0;
  public rotatedAtCalls = 0;

  private readonly settings = new Map<LlmProviderRole, LlmProviderSettings | null>();
  private readonly throwOnDecrypt = new Map<LlmProviderRole, Error | null>();
  private readonly rotatedAt = new Map<LlmProviderRole, Date | null>();

  public setSettings(role: LlmProviderRole, value: LlmProviderSettings | null): void {
    this.settings.set(role, value);
  }

  public setThrowOnDecrypt(role: LlmProviderRole, err: Error | null): void {
    this.throwOnDecrypt.set(role, err);
  }

  public setRotatedAt(role: LlmProviderRole, value: Date | null): void {
    this.rotatedAt.set(role, value);
  }

  public async readDecryptedSettings(role: LlmProviderRole): Promise<LlmProviderSettings | null> {
    this.decryptCalls += 1;
    const maybeThrow = this.throwOnDecrypt.get(role);
    if (maybeThrow !== undefined && maybeThrow !== null) {
      throw maybeThrow;
    }
    return this.settings.get(role) ?? null;
  }

  public async readLastRotatedAt(args: {
    scope: "platform";
    role: LlmProviderRole;
  }): Promise<Date | null> {
    this.rotatedAtCalls += 1;
    return this.rotatedAt.get(args.role) ?? null;
  }
}

function settings(overrides: Partial<LlmProviderSettings> = {}): LlmProviderSettings {
  return {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    region: "us-east-1",
    apiKey: "sk-token-AAAA",
    enabled: true,
    ...overrides,
  };
}

describe("LlmCredentialsProvider", () => {
  let clock: FakeClock;
  let repo: StubRepo;
  let provider: LlmCredentialsProvider;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clock = new FakeClock({ now: T0 });
    repo = new StubRepo();
    provider = new LlmCredentialsProvider({
      repo,
      clock,
      ttlSeconds: 300,
      hardStaleSeconds: 1800,
    });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns the decrypted credential triple, mapping modelId + region", async () => {
    repo.setSettings("primary", settings({ apiKey: "sk-primary-1", modelId: "m-1", region: "eu" }));

    const creds = await provider.current("primary");

    expect(creds).toEqual({ apiKey: "sk-primary-1", region: "eu", modelId: "m-1" });
  });

  it("maps a NULL region to the empty string", async () => {
    repo.setSettings("primary", settings({ region: null }));

    const creds = await provider.current("primary");

    expect(creds.region).toBe("");
  });

  it("fresh-hit: a second call inside the TTL window does NOT re-decrypt", async () => {
    repo.setSettings("primary", settings());

    await provider.current("primary");
    expect(repo.decryptCalls).toBe(1);

    // 299s later — still inside the 300s TTL.
    clock.advance({ seconds: 299 });
    const creds = await provider.current("primary");

    expect(repo.decryptCalls).toBe(1); // no second decrypt
    expect(creds.apiKey).toBe("sk-token-AAAA");
  });

  it("TTL-expiry-refresh: advancing past the TTL forces a re-decrypt with the new value", async () => {
    repo.setSettings("primary", settings({ apiKey: "sk-old" }));
    await provider.current("primary");
    expect(repo.decryptCalls).toBe(1);

    // Operator updates the row (without changing last_rotated_at — pure TTL-driven refresh).
    repo.setSettings("primary", settings({ apiKey: "sk-new" }));

    // 301s later — past the 300s TTL boundary.
    clock.advance({ seconds: 301 });
    const creds = await provider.current("primary");

    expect(repo.decryptCalls).toBe(2);
    expect(creds.apiKey).toBe("sk-new");
  });

  it("caches roles independently — primary creds never leak into secondary's slot", async () => {
    repo.setSettings("primary", settings({ apiKey: "sk-primary" }));
    repo.setSettings("secondary", settings({ apiKey: "sk-secondary" }));

    const p = await provider.current("primary");
    const s = await provider.current("secondary");

    expect(p.apiKey).toBe("sk-primary");
    expect(s.apiKey).toBe("sk-secondary");
    expect(repo.decryptCalls).toBe(2); // one decrypt per role
  });

  it("rotation-detect-invalidates-early: a moved last_rotated_at refetches BEFORE the TTL expires", async () => {
    repo.setSettings("primary", settings({ apiKey: "sk-v1" }));
    repo.setRotatedAt("primary", new Date("2026-06-04T00:00:00.000Z"));
    const first = await provider.current("primary");
    expect(first.apiKey).toBe("sk-v1");
    expect(repo.decryptCalls).toBe(1);

    // Operator rotates: new token + bumped last_rotated_at. Only 10s elapse — well inside the TTL.
    repo.setSettings("primary", settings({ apiKey: "sk-v2" }));
    repo.setRotatedAt("primary", new Date("2026-06-04T00:00:10.000Z"));
    clock.advance({ seconds: 10 });

    const second = await provider.current("primary");

    // Refetched despite being inside the TTL, because the rotation fingerprint moved.
    expect(second.apiKey).toBe("sk-v2");
    expect(repo.decryptCalls).toBe(2);
  });

  it("transient-fail-returns-stale: a decrypt throw inside the hard-stale window serves the prior cache + logs the rule", async () => {
    repo.setSettings("primary", settings({ apiKey: "sk-cached" }));
    await provider.current("primary");
    expect(repo.decryptCalls).toBe(1);

    // Past the TTL so the next call refreshes; the decrypt now throws (transient Vault blip).
    clock.advance({ seconds: 301 });
    repo.setThrowOnDecrypt("primary", new Error("vault transit unreachable"));

    const creds = await provider.current("primary");

    // Served the prior cache; the caller is unaware.
    expect(creds.apiKey).toBe("sk-cached");
    expect(repo.decryptCalls).toBe(2); // the failing attempt happened

    // Structured WARN keyed on the operator-alert rule, with the role + no plaintext.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg, fields] = warnSpy.mock.calls[0]!;
    expect(msg).toContain("serving stale cache");
    expect(fields).toMatchObject({
      rule: "bedrock-credentials-refresh-failed",
      role: "primary",
      had_cache: true,
    });
    expect(JSON.stringify(fields)).not.toContain("sk-cached");
  });

  it("hard-stale-raises: a decrypt that keeps failing past hardStaleSeconds raises LlmCredentialsExpiredError", async () => {
    repo.setSettings("primary", settings({ apiKey: "sk-cached" }));
    await provider.current("primary");

    // Refresh starts failing.
    clock.advance({ seconds: 301 });
    repo.setThrowOnDecrypt("primary", new Error("vault down"));
    // First failure: within the hard-stale window → serves stale.
    await expect(provider.current("primary")).resolves.toMatchObject({ apiKey: "sk-cached" });

    // Keep failing past the 1800s hard-stale threshold (measured from the first failure instant).
    clock.advance({ seconds: 1801 });
    await expect(provider.current("primary")).rejects.toBeInstanceOf(LlmCredentialsExpiredError);
  });

  it("hard-stale clock resets after a successful refresh", async () => {
    repo.setSettings("primary", settings({ apiKey: "sk-v1" }));
    await provider.current("primary");

    // A transient failure window opens then closes with a success.
    clock.advance({ seconds: 301 });
    repo.setThrowOnDecrypt("primary", new Error("blip"));
    await provider.current("primary"); // serves stale, marks failing-since

    clock.advance({ seconds: 301 });
    repo.setThrowOnDecrypt("primary", null);
    repo.setSettings("primary", settings({ apiKey: "sk-v2" }));
    await provider.current("primary"); // success — clears the failing-since marker

    // A NEW failure window opens; only 10s in, must STILL serve stale (clock was reset by the success).
    clock.advance({ seconds: 301 });
    repo.setThrowOnDecrypt("primary", new Error("blip2"));
    await expect(provider.current("primary")).resolves.toMatchObject({ apiKey: "sk-v2" });
  });

  it("initial-fail (no prior cache) raises LlmCredentialsExpiredError immediately", async () => {
    repo.setThrowOnDecrypt("primary", new Error("vault never reachable"));

    await expect(provider.current("primary")).rejects.toBeInstanceOf(LlmCredentialsExpiredError);
  });

  it("an absent/disabled row (repo returns null) raises LlmRoleNotConfiguredError", async () => {
    repo.setSettings("primary", null);

    await expect(provider.current("primary")).rejects.toBeInstanceOf(LlmRoleNotConfiguredError);
  });

  it("a present-but-disabled settings object raises LlmRoleDisabledError", async () => {
    // Defense-in-depth path: the production repo folds disabled into null, but if a row surfaces with
    // enabled=false the provider must reject it as disabled, not serve it.
    repo.setSettings("primary", settings({ enabled: false }));

    await expect(provider.current("primary")).rejects.toBeInstanceOf(LlmRoleDisabledError);
  });

  it("coalesces concurrent first-calls into a single decrypt via the per-role lock", async () => {
    repo.setSettings("primary", settings({ apiKey: "sk-coalesced" }));

    const [a, b, c] = await Promise.all([
      provider.current("primary"),
      provider.current("primary"),
      provider.current("primary"),
    ]);

    expect(a.apiKey).toBe("sk-coalesced");
    expect(b.apiKey).toBe("sk-coalesced");
    expect(c.apiKey).toBe("sk-coalesced");
    // Exactly one decrypt despite three concurrent callers (double-checked locking under the role lock).
    expect(repo.decryptCalls).toBe(1);
  });
});
