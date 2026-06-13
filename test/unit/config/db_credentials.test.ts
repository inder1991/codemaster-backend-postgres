import { describe, expect, it } from "vitest";

import { assembleDsn, resolveDbDsn } from "#backend/config/db_credentials.js";

describe("assembleDsn", () => {
  it("builds a postgresql:// URL from parts", () => {
    expect(assembleDsn({ user: "u", password: "p", host: "h", port: "5432", database: "d" })).toBe(
      "postgresql://u:p@h:5432/d",
    );
  });

  it("URL-encodes user + password special chars", () => {
    expect(
      assembleDsn({ user: "a@b", password: "p/s:s@x", host: "h", port: "5432", database: "d" }),
    ).toBe("postgresql://a%40b:p%2Fs%3As%40x@h:5432/d");
  });

  it("defaults the port to 5432 when omitted", () => {
    expect(assembleDsn({ user: "u", password: "p", host: "h", database: "d" })).toBe(
      "postgresql://u:p@h:5432/d",
    );
  });
});

const noVault = () => Promise.reject(new Error("vault should not be read in openshift mode"));

describe("resolveDbDsn — openshift source", () => {
  it("returns the full DSN env when set", async () => {
    const dsn = await resolveDbDsn({
      env: { CODEMASTER_PG_CORE_DSN: "postgresql://x:y@h:5432/d" },
      readVaultKv: noVault,
    });
    expect(dsn).toBe("postgresql://x:y@h:5432/d");
  });

  it("assembles from PG_USER/PG_PASSWORD + host/db when no full DSN", async () => {
    const dsn = await resolveDbDsn({
      env: {
        CODEMASTER_PG_USER: "u",
        CODEMASTER_PG_PASSWORD: "p",
        CODEMASTER_PG_HOST: "h",
        CODEMASTER_PG_DATABASE: "d",
      },
      readVaultKv: noVault,
    });
    expect(dsn).toBe("postgresql://u:p@h:5432/d");
  });

  it("throws naming the env vars when neither DSN nor parts are present", async () => {
    await expect(resolveDbDsn({ env: {}, readVaultKv: noVault })).rejects.toThrow(
      /CODEMASTER_PG_CORE_DSN|CODEMASTER_PG_USER/,
    );
  });
});

describe("resolveDbDsn — vault source", () => {
  const vaultEnv = { CODEMASTER_SECRET_SOURCE: "vault" };

  it("uses a dsn key from the Vault path", async () => {
    const dsn = await resolveDbDsn({
      env: vaultEnv,
      readVaultKv: () => Promise.resolve({ dsn: "postgresql://v:v@h:5432/d" }),
    });
    expect(dsn).toBe("postgresql://v:v@h:5432/d");
  });

  it("assembles from username+password (Vault) + host/db (env)", async () => {
    const dsn = await resolveDbDsn({
      env: { ...vaultEnv, CODEMASTER_PG_HOST: "h", CODEMASTER_PG_DATABASE: "d" },
      readVaultKv: () => Promise.resolve({ username: "vu", password: "vp" }),
    });
    expect(dsn).toBe("postgresql://vu:vp@h:5432/d");
  });

  it("throws naming the Vault path when the secret lacks usable keys", async () => {
    await expect(
      resolveDbDsn({ env: vaultEnv, readVaultKv: () => Promise.resolve({}) }),
    ).rejects.toThrow(/codemaster\/postgres\/app/);
  });
});
