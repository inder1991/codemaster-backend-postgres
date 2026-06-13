import { afterEach, describe, expect, it, vi } from "vitest";

import { VaultHttpPort } from "#backend/adapters/vault_http.js";
import {
  confluenceConfigFromEnv,
  confluenceConfigFromVaultData,
  makeResolvingConfluenceReader,
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

describe("makeResolvingConfluenceReader — Vault port memoization (review P2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("builds the Vault port ONCE across reads — not a fresh SA login per refresh", async () => {
    // No DB (CODEMASTER_PG_CORE_DSN unset) + no env creds → the Vault tier is reached every read. The port
    // (and its VaultK8sAuth lease cache) must be memoized, else refreshOnce's ~30-min cadence logs in afresh
    // each time. Spy on fromEnv: it must be called at most once across multiple reads.
    vi.stubEnv("CODEMASTER_PG_CORE_DSN", "");
    vi.stubEnv("CODEMASTER_CONFLUENCE_BASE_URL", "");
    vi.stubEnv("CODEMASTER_CONFLUENCE_TOKEN", "");
    vi.stubEnv("CODEMASTER_VAULT_SECRET_SOURCE", "");
    const fakePort = {
      kvRead: () => Promise.resolve({ base_url: "https://vault-confluence", token: "vt" }),
    } as unknown as VaultHttpPort;
    const spy = vi.spyOn(VaultHttpPort, "fromEnv").mockReturnValue(fakePort);

    const reader = makeResolvingConfluenceReader();
    const a = await reader.kvRead({ path: "codemaster/confluence/token" });
    const b = await reader.kvRead({ path: "codemaster/confluence/token" });

    expect(a).toEqual({ base_url: "https://vault-confluence", token: "vt" });
    expect(b).toEqual(a);
    expect(spy).toHaveBeenCalledTimes(1); // memoized — built once, NOT per read
  });
});
