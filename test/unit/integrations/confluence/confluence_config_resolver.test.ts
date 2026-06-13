import { describe, expect, it } from "vitest";

import {
  confluenceConfigFromEnv,
  confluenceConfigFromVaultData,
} from "#backend/integrations/confluence/confluence_config_resolver.js";

// P0-C parity for Confluence: the env + Vault tiers of the DB > env > Vault resolver. (The DB tier +
// the layered precedence + the lazy-Vault reader are covered by the integration test.)
describe("confluenceConfigFromEnv", () => {
  const env = (m: Record<string, string>) => (n: string) => m[n];

  it("returns config when base_url + token are set (auth_email optional → Cloud)", () => {
    expect(
      confluenceConfigFromEnv(
        env({
          CODEMASTER_CONFLUENCE_BASE_URL: "https://acme.atlassian.net/wiki",
          CODEMASTER_CONFLUENCE_TOKEN: "tok",
          CODEMASTER_CONFLUENCE_AUTH_EMAIL: "bot@acme.com",
        }),
      ),
    ).toEqual({ baseUrl: "https://acme.atlassian.net/wiki", token: "tok", authEmail: "bot@acme.com" });
  });

  it("authEmail null when unset (Server/DC PAT); null when base_url or token missing", () => {
    expect(
      confluenceConfigFromEnv(env({ CODEMASTER_CONFLUENCE_BASE_URL: "https://w", CODEMASTER_CONFLUENCE_TOKEN: "t" })),
    ).toEqual({ baseUrl: "https://w", token: "t", authEmail: null });
    expect(confluenceConfigFromEnv(env({ CODEMASTER_CONFLUENCE_BASE_URL: "https://w" }))).toBeNull();
  });
});

describe("confluenceConfigFromVaultData", () => {
  it("maps the Vault record (base_url/token/email) to config; null when a required key is missing", () => {
    expect(
      confluenceConfigFromVaultData({ base_url: "https://w", token: "t", email: "e@x" }),
    ).toEqual({ baseUrl: "https://w", token: "t", authEmail: "e@x" });
    expect(confluenceConfigFromVaultData({ base_url: "https://w" })).toBeNull();
    expect(confluenceConfigFromVaultData({ base_url: "https://w", token: "t" })).toEqual({
      baseUrl: "https://w",
      token: "t",
      authEmail: null,
    });
  });
});
