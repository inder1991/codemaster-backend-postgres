import { afterEach, describe, expect, it, vi } from "vitest";

import type { VaultKvReadPort } from "#backend/ingest/webhook_secret_provider.js";

import {
  AUTH_SECRETS_VAULT_PATH,
  makeAuthSecretsProvider,
  VaultAuthSecretsProvider,
} from "#backend/api/auth/auth_secrets_provider.js";

const VALID = "0123456789abcdef0123456789abcdef"; // 32 chars

function vault(data: Record<string, string>): VaultKvReadPort {
  return {
    kvRead: async (args) => {
      expect(args.path).toBe(AUTH_SECRETS_VAULT_PATH);
      return data;
    },
  };
}

describe("VaultAuthSecretsProvider", () => {
  it("returns the UTF-8 bytes of the signing key + csrf secret", async () => {
    const p = new VaultAuthSecretsProvider({
      vault: vault({ session_signing_key: VALID, csrf_secret: VALID + "x" }),
    });
    expect(await p.sessionSigningKey()).toEqual(new TextEncoder().encode(VALID));
    expect(await p.csrfSecret()).toEqual(new TextEncoder().encode(VALID + "x"));
  });

  it("throws (fail-loud) when a key is missing", async () => {
    const p = new VaultAuthSecretsProvider({ vault: vault({ csrf_secret: VALID }) });
    await expect(p.sessionSigningKey()).rejects.toThrow(/missing key 'session_signing_key'/);
  });

  it("throws when a secret is shorter than 32 chars", async () => {
    const p = new VaultAuthSecretsProvider({
      vault: vault({ session_signing_key: "tooshort", csrf_secret: VALID }),
    });
    await expect(p.sessionSigningKey()).rejects.toThrow(/must be >= 32/);
  });
});

describe("makeAuthSecretsProvider — openshift env source (P0-A.2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the signing key + csrf secret from env (no Vault) when CODEMASTER_SECRET_SOURCE=openshift", async () => {
    vi.stubEnv("CODEMASTER_SECRET_SOURCE", "openshift");
    vi.stubEnv("CODEMASTER_SESSION_SIGNING_KEY", VALID);
    vi.stubEnv("CODEMASTER_CSRF_SECRET", VALID + "y");
    vi.stubEnv("VAULT_ADDR", ""); // prove no Vault is consulted

    const p = makeAuthSecretsProvider();
    expect(await p.sessionSigningKey()).toEqual(new TextEncoder().encode(VALID));
    expect(await p.csrfSecret()).toEqual(new TextEncoder().encode(VALID + "y"));
  });

  it("fails loud (env source) when an auth secret env var is unset", async () => {
    vi.stubEnv("CODEMASTER_SECRET_SOURCE", "openshift");
    vi.stubEnv("CODEMASTER_SESSION_SIGNING_KEY", VALID);
    vi.stubEnv("CODEMASTER_CSRF_SECRET", ""); // unset → empty

    const p = makeAuthSecretsProvider();
    await expect(p.csrfSecret()).rejects.toThrow();
  });
});
