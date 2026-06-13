import { describe, expect, it } from "vitest";

import {
  gitHubCredsFromEnv,
  gitHubCredsFromVaultData,
  gitHubWebhookSecretFromEnv,
  gitHubWebhookSecretFromVaultData,
  resolveGitHubCreds,
  resolveGitHubWebhookSecret,
} from "#backend/integrations/github/github_config_resolver.js";

const CREDS = { appId: "123", privateKeyPem: "-----BEGIN-----" };

// P0-C: GitHub creds + webhook secret resolve DB (UI) > env > Vault > disabled — the FIRST non-null tier
// wins — so UI-saved settings actually take effect at runtime. Creds + webhook are resolved separately.
describe("resolveGitHubCreds", () => {
  it("DB wins when present", async () => {
    const got = await resolveGitHubCreds({
      fromDb: () => Promise.resolve(CREDS),
      fromEnv: () => ({ appId: "env", privateKeyPem: "x" }),
      fromVault: () => Promise.resolve({ appId: "vault", privateKeyPem: "x" }),
    });
    expect(got).toEqual({ value: CREDS, source: "db" });
  });

  it("falls through DB→env→vault", async () => {
    const got = await resolveGitHubCreds({
      fromDb: () => Promise.resolve(null),
      fromEnv: () => null,
      fromVault: () => Promise.resolve(CREDS),
    });
    expect(got).toEqual({ value: CREDS, source: "vault" });
  });

  it("returns null when nothing is configured (disabled)", async () => {
    const got = await resolveGitHubCreds({
      fromDb: () => Promise.resolve(null),
      fromEnv: () => null,
      fromVault: () => Promise.resolve(null),
    });
    expect(got).toBeNull();
  });
});

describe("resolveGitHubWebhookSecret", () => {
  it("DB wins; falls through to vault when DB+env null", async () => {
    expect(
      await resolveGitHubWebhookSecret({
        fromDb: () => Promise.resolve("db-secret"),
        fromEnv: () => "env-secret",
        fromVault: () => Promise.resolve("vault-secret"),
      }),
    ).toEqual({ value: "db-secret", source: "db" });
    expect(
      await resolveGitHubWebhookSecret({
        fromDb: () => Promise.resolve(null),
        fromEnv: () => null,
        fromVault: () => Promise.resolve("vault-secret"),
      }),
    ).toEqual({ value: "vault-secret", source: "vault" });
  });
});

describe("env/vault mappers", () => {
  const env = (m: Record<string, string>) => (n: string) => m[n];

  it("gitHubCredsFromEnv: both vars → creds; missing one → null", () => {
    expect(
      gitHubCredsFromEnv(
        env({ CODEMASTER_GITHUB_APP_ID: "123", CODEMASTER_GITHUB_PRIVATE_KEY_PEM: "-----BEGIN-----" }),
      ),
    ).toEqual(CREDS);
    expect(gitHubCredsFromEnv(env({ CODEMASTER_GITHUB_APP_ID: "123" }))).toBeNull();
  });

  it("gitHubCredsFromVaultData: app_id+private_key_pem → creds (webhook_secret NOT required)", () => {
    expect(gitHubCredsFromVaultData({ app_id: "123", private_key_pem: "-----BEGIN-----" })).toEqual(CREDS);
    expect(gitHubCredsFromVaultData({ app_id: "123" })).toBeNull();
  });

  it("gitHubWebhookSecret mappers read the webhook secret from env / vault data", () => {
    expect(gitHubWebhookSecretFromEnv(env({ CODEMASTER_GITHUB_WEBHOOK_SECRET: "whsec" }))).toBe("whsec");
    expect(gitHubWebhookSecretFromEnv(env({}))).toBeNull();
    expect(gitHubWebhookSecretFromVaultData({ webhook_secret: "whsec" })).toBe("whsec");
    expect(gitHubWebhookSecretFromVaultData({ app_id: "123" })).toBeNull();
  });
});
