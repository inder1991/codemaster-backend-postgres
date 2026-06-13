import { describe, expect, it } from "vitest";

import {
  assertDeployReady,
  type DeployContract,
  DeployContractError,
  evaluateDeployContract,
  type ObserveDeps,
  observeDeployState,
  type ObservedState,
} from "#backend/deploy_preflight.js";

// A minimal contract exercising one required env secret. The real DEPLOY_CONTRACT is the
// source-of-truth (tested separately); evaluateDeployContract is the pure validator over it.
const ONE_SECRET: DeployContract = {
  secrets: [
    {
      name: "CODEMASTER_PG_CORE_DSN",
      source: "env",
      vaultPath: "secret/data/codemaster/postgres/app",
      key: "dsn",
      required: true,
      format: "dsn",
    },
  ],
  extensions: [],
  schemas: [],
  config: [],
};

describe("evaluateDeployContract", () => {
  it("reports a missing required secret with its Vault path and an actionable fix", () => {
    const observed: ObservedState = {
      secrets: { CODEMASTER_PG_CORE_DSN: undefined },
      extensions: [],
      schemas: [],
      config: {},
    };

    const failures = evaluateDeployContract(ONE_SECRET, observed);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.what).toContain("CODEMASTER_PG_CORE_DSN");
    // The fix must name the exact Vault path + key so an engineer can self-serve.
    expect(failures[0]?.fix).toContain("secret/data/codemaster/postgres/app");
    expect(failures[0]?.fix).toContain("dsn");
  });

  it("passes (no failures) when the required secret is present and well-formed", () => {
    const observed: ObservedState = {
      secrets: { CODEMASTER_PG_CORE_DSN: "postgresql://u:p@host:5432/db" },
      extensions: [],
      schemas: [],
      config: {},
    };

    expect(evaluateDeployContract(ONE_SECRET, observed)).toHaveLength(0);
  });
});

const DB_AND_CONFIG: DeployContract = {
  secrets: [],
  extensions: [{ name: "pg_partman", createSql: "CREATE EXTENSION IF NOT EXISTS pg_partman;" }],
  schemas: ["core"],
  config: [{ env: "CODEMASTER_RUNTIME_MODE", required: true, oneOf: ["postgres", "shadow"] }],
};

describe("evaluateDeployContract — DB + config", () => {
  it("reports a missing required extension with its CREATE EXTENSION fix", () => {
    const failures = evaluateDeployContract(DB_AND_CONFIG, {
      secrets: {},
      extensions: [],
      schemas: ["core"],
      config: { CODEMASTER_RUNTIME_MODE: "postgres" },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.what).toContain("pg_partman");
    expect(failures[0]?.fix).toContain("CREATE EXTENSION IF NOT EXISTS pg_partman");
  });

  it("reports a missing required schema", () => {
    const failures = evaluateDeployContract(DB_AND_CONFIG, {
      secrets: {},
      extensions: ["pg_partman"],
      schemas: [],
      config: { CODEMASTER_RUNTIME_MODE: "postgres" },
    });
    expect(failures.some((f) => f.what.includes("core"))).toBe(true);
  });

  it("reports a config value outside its allowed set", () => {
    const failures = evaluateDeployContract(DB_AND_CONFIG, {
      secrets: {},
      extensions: ["pg_partman"],
      schemas: ["core"],
      config: { CODEMASTER_RUNTIME_MODE: "temporal" },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.what).toContain("CODEMASTER_RUNTIME_MODE");
    expect(failures[0]?.why).toContain("postgres");
  });

  it("passes when extensions, schemas, and config all satisfy the contract", () => {
    expect(
      evaluateDeployContract(DB_AND_CONFIG, {
        secrets: {},
        extensions: ["pg_partman"],
        schemas: ["core"],
        config: { CODEMASTER_RUNTIME_MODE: "shadow" },
      }),
    ).toHaveLength(0);
  });
});

const FILE_AND_ENV: DeployContract = {
  secrets: [
    { name: "CODEMASTER_PG_CORE_DSN", source: "env", vaultPath: "codemaster/postgres/app", key: "dsn", required: true, format: "dsn" },
    { name: "github_app.app_id", source: "file", fileName: "codemaster_github_app", vaultPath: "codemaster/github/app", key: "app_id", required: true },
  ],
  extensions: [{ name: "vector", createSql: "CREATE EXTENSION IF NOT EXISTS vector;" }],
  schemas: ["core"],
  config: [{ env: "CODEMASTER_RUNTIME_MODE", required: true, oneOf: ["postgres", "shadow"] }],
};

function fakeDeps(over: Partial<{ env: Record<string, string>; files: Record<string, Record<string, string>>; exts: Array<string>; schemas: Array<string> }> = {}): ObserveDeps {
  const env = over.env ?? {};
  const files = over.files ?? {};
  return {
    env: (n) => env[n],
    readSecretFile: (f) => Promise.resolve(files[f] ?? null),
    listExtensions: () => Promise.resolve(over.exts ?? []),
    listSchemas: () => Promise.resolve(over.schemas ?? []),
  };
}

describe("observeDeployState", () => {
  it("resolves env secrets from env and file-secret keys from the rendered file", async () => {
    const observed = await observeDeployState(FILE_AND_ENV, fakeDeps({
      env: { CODEMASTER_PG_CORE_DSN: "postgresql://x", CODEMASTER_RUNTIME_MODE: "postgres" },
      files: { codemaster_github_app: { app_id: "123", private_key_pem: "-----BEGIN" } },
      exts: ["vector"],
      schemas: ["core"],
    }));
    expect(observed.secrets["CODEMASTER_PG_CORE_DSN"]).toBe("postgresql://x");
    expect(observed.secrets["github_app.app_id"]).toBe("123");
    expect(observed.extensions).toContain("vector");
    expect(observed.config["CODEMASTER_RUNTIME_MODE"]).toBe("postgres");
  });

  it("leaves a file-secret key undefined when the rendered file is absent", async () => {
    const observed = await observeDeployState(FILE_AND_ENV, fakeDeps({ env: { CODEMASTER_PG_CORE_DSN: "postgresql://x" } }));
    expect(observed.secrets["github_app.app_id"]).toBeUndefined();
  });
});

describe("assertDeployReady", () => {
  it("throws DeployContractError listing EVERY problem at once", async () => {
    // Nothing provided: missing DSN, missing github app_id, missing extension, missing schema, missing config.
    const err = await assertDeployReady(fakeDeps(), FILE_AND_ENV).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(DeployContractError);
    const failures = (err as DeployContractError).failures;
    expect(failures.length).toBeGreaterThanOrEqual(4);
    // The message must be operator-actionable (names a fix).
    expect((err as Error).message).toContain("vector");
  });

  it("resolves when the whole contract is satisfied", async () => {
    await expect(assertDeployReady(fakeDeps({
      env: { CODEMASTER_PG_CORE_DSN: "postgresql://x", CODEMASTER_RUNTIME_MODE: "shadow" },
      files: { codemaster_github_app: { app_id: "123" } },
      exts: ["vector"],
      schemas: ["core"],
    }), FILE_AND_ENV)).resolves.toBeUndefined();
  });
});
