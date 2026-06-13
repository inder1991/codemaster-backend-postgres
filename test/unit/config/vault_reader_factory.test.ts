import { describe, expect, it } from "vitest";

import { makeReadVaultKv } from "#backend/config/vault_reader_factory.js";

// Composes Step 2 (VaultK8sAuth login + KV reader) into the `readVaultKv` Step 1's resolvers consume.
describe("makeReadVaultKv", () => {
  it("returns a reader that fails clearly when VAULT_ADDR is unset", async () => {
    const read = makeReadVaultKv({ env: {}, now: () => 0 });
    await expect(read("codemaster/postgres/app")).rejects.toThrow(/VAULT_ADDR/);
  });

  it("logs in with the SA JWT then reads the KV path with the issued token", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const gets: Array<{ url: string; token: string }> = [];
    const read = makeReadVaultKv({
      env: { VAULT_ADDR: "https://vault:8200", CODEMASTER_VAULT_K8S_ROLE: "codemaster" },
      now: () => 0,
      readSaToken: () => Promise.resolve("sa-jwt"),
      httpPostJson: (url, body) => {
        posts.push({ url, body });
        return Promise.resolve({ status: 200, body: { auth: { client_token: "vt-1", lease_duration: 3600 } } });
      },
      httpGetJson: (url, token) => {
        gets.push({ url, token });
        return Promise.resolve({ status: 200, body: { data: { data: { dsn: "postgresql://v/d" } } } });
      },
    });

    const out = await read("codemaster/postgres/app");

    expect(out).toEqual({ dsn: "postgresql://v/d" });
    expect(posts[0]?.url).toBe("https://vault:8200/v1/auth/kubernetes/login");
    expect(posts[0]?.body).toEqual({ role: "codemaster", jwt: "sa-jwt" });
    expect(gets[0]?.url).toBe("https://vault:8200/v1/secret/data/codemaster/postgres/app");
    expect(gets[0]?.token).toBe("vt-1");
  });
});
