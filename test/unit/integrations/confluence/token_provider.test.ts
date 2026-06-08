/**
 * Unit tests for the TS ConfluenceTokenProvider — the 1:1 port of
 * `vendor/codemaster-py/codemaster/integrations/confluence/token_provider.py` (frozen Python,
 * FOLLOW-UP-confluence-vault-token / S15.X).
 *
 * Vault-backed single-token credential provider:
 *   - Startup fail-HARD (constructor/from_vault raises on Vault error or schema violation).
 *   - Runtime refresh failure is fail-OPEN (keep serving the cached token).
 *   - 30-min refresh loop ± jitter (the loop itself is NOT exercised here; refresh is driven directly).
 *
 * The injected seams are the {@link InMemoryVault} (a fake Vault KV) + {@link FakeClock} + a seeded
 * {@link SeededRandom} for deterministic jitter. No real Vault, no real sleeps.
 */

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { SeededRandom } from "#platform/randomness.js";

import { InMemoryVault } from "#backend/adapters/vault_port.js";
import {
  ConfluenceTokenProvider,
  PermanentConfluenceTokenError,
  TransientConfluenceTokenError,
  VAULT_KV_PATH,
} from "#backend/integrations/confluence/token_provider.js";

/** An empty Vault — the secret path is never written, so kvRead throws VaultPathNotFound. */
function emptyVault(): InMemoryVault {
  return new InMemoryVault();
}

async function seededVault(secret: Record<string, string>): Promise<InMemoryVault> {
  const v = new InMemoryVault();
  await v.kvWrite({ path: VAULT_KV_PATH, data: secret });
  return v;
}

function makeProvider(
  vault: InMemoryVault,
  opts: { clock?: FakeClock } = {},
): Promise<ConfluenceTokenProvider> {
  return ConfluenceTokenProvider.fromVault({
    vault,
    clock: opts.clock ?? new FakeClock(),
    jitterRng: new SeededRandom({ seed: 42 }),
  });
}

describe("ConfluenceTokenProvider — from_vault happy path", () => {
  it("reads token + base_url from Vault and exposes them", async () => {
    const vault = await seededVault({
      base_url: "https://confluence.acme.com/wiki/",
      token: "ATATT-classic",
    });
    const provider = await makeProvider(vault);

    expect(await provider.getToken()).toBe("ATATT-classic");
    // base_url is rstripped of trailing slashes (1:1 with the Python `.rstrip("/")`).
    expect(provider.baseUrl).toBe("https://confluence.acme.com/wiki");
    expect(provider.authEmail).toBeNull();
    expect(provider.consecutiveFailures).toBe(0);
  });

  it("exposes the optional Cloud email when present (Basic-auth selection)", async () => {
    const vault = await seededVault({
      base_url: "https://acme.atlassian.net/wiki",
      token: "ATATT-cloud",
      email: "svc@acme.com",
    });
    const provider = await makeProvider(vault);
    expect(provider.authEmail).toBe("svc@acme.com");
  });

  it("ignores a non-string / empty email (stays Bearer)", async () => {
    const vault = await seededVault({
      base_url: "https://acme.atlassian.net/wiki",
      token: "ATATT",
      email: "",
    });
    const provider = await makeProvider(vault);
    expect(provider.authEmail).toBeNull();
  });
});

describe("ConfluenceTokenProvider — startup fail-hard", () => {
  it("raises TransientConfluenceTokenError when the Vault read fails", async () => {
    const vault = emptyVault(); // path never written → kvRead throws VaultPathNotFound
    await expect(makeProvider(vault)).rejects.toBeInstanceOf(TransientConfluenceTokenError);
  });

  it("raises PermanentConfluenceTokenError when required keys are missing", async () => {
    const vault = await seededVault({ base_url: "https://x/wiki" }); // no `token`
    await expect(makeProvider(vault)).rejects.toBeInstanceOf(PermanentConfluenceTokenError);
  });

  it("raises PermanentConfluenceTokenError when values are empty", async () => {
    const vault = await seededVault({ base_url: "", token: "" });
    await expect(makeProvider(vault)).rejects.toBeInstanceOf(PermanentConfluenceTokenError);
  });
});

describe("ConfluenceTokenProvider — refresh updates the token (runtime)", () => {
  it("a successful refresh rotates the cached token", async () => {
    const vault = await seededVault({ base_url: "https://x/wiki", token: "tok-v1" });
    const provider = await makeProvider(vault);
    expect(await provider.getToken()).toBe("tok-v1");

    // Rotate the Vault secret, then drive a manual refresh (the loop's body, without scheduling).
    await vault.kvWrite({ path: VAULT_KV_PATH, data: { base_url: "https://x/wiki", token: "tok-v2" } });
    await provider.refreshOnceForTest();

    expect(await provider.getToken()).toBe("tok-v2");
    expect(provider.consecutiveFailures).toBe(0);
  });

  it("runtime refresh failure is fail-OPEN: keeps serving the cached token", async () => {
    const vault = await seededVault({ base_url: "https://x/wiki", token: "tok-cached" });
    const provider = await makeProvider(vault);

    // Now make Vault unreachable and drive a runtime refresh — it must NOT throw and must keep the token.
    vault.simulateUnreachable(true);
    await provider.refreshOnceForTest();

    expect(await provider.getToken()).toBe("tok-cached");
    expect(provider.consecutiveFailures).toBe(1);
  });

  it("runtime validation failure (missing key) is fail-OPEN", async () => {
    const vault = await seededVault({ base_url: "https://x/wiki", token: "tok-cached" });
    const provider = await makeProvider(vault);

    await vault.kvWrite({ path: VAULT_KV_PATH, data: { base_url: "https://x/wiki" } }); // drop `token`
    await provider.refreshOnceForTest();

    expect(await provider.getToken()).toBe("tok-cached");
    expect(provider.consecutiveFailures).toBe(1);
  });
});
