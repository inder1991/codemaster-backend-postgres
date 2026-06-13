import { describe, expect, it } from "vitest";

import {
  type DeployContract,
  evaluateDeployContract,
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
