// Deploy-contract preflight (turnkey-deployment plan, Phase 1): a declarative source of truth for
// everything a first deploy MUST have — secrets, DB extensions/schemas, required config — plus a
// pure validator that turns the observed runtime state into actionable failures (each names the
// exact missing thing AND the one-line fix). The composition root runs it BEFORE the HTTP bind,
// beside {@link assertSchemaRevision}, so a misconfigured pod exits 1 with a self-serve remediation
// list instead of going Ready-but-dead. evaluateDeployContract is IO-free (inject ObservedState) so
// it is exhaustively unit-testable; the thin IO wrapper that reads env / queries the DB lives apart.

/** Where a secret is delivered to the app: an env var, or a Vault-Agent-rendered file. */
export type SecretSource = "env" | "file";

/** Lightweight well-formedness check applied when a secret IS present. */
export type SecretFormat = "dsn" | "pem" | "nonempty";

/** One required (or optional) secret in the deploy contract. */
export type SecretReq = {
  /** Env var name (source=env) or sanitized file name (source=file) the app reads. */
  readonly name: string;
  readonly source: SecretSource;
  /** The Vault KV path to seed (the operator-facing fix). */
  readonly vaultPath: string;
  /** The key within the Vault secret (for source=env / multi-key file secrets). */
  readonly key?: string;
  /** For source=file: the Agent-rendered filename under secretsDir (sanitized KV path). */
  readonly fileName?: string;
  readonly required: boolean;
  readonly format?: SecretFormat;
  /** Human note: which feature this secret gates (sharpens the failure message). */
  readonly gates?: string;
}

/** A required Postgres extension + the SQL to install it (self-managed PG — owner decision). */
export type ExtensionReq = {
  readonly name: string;
  readonly createSql: string;
}

/** One required (or optional) config value. */
export type ConfigReq = {
  readonly env: string;
  readonly required: boolean;
  readonly default?: string;
  /** If set, the value must be one of these (e.g. runtime mode postgres|shadow). */
  readonly oneOf?: ReadonlyArray<string>;
}

/** The declarative deploy contract — the single source of truth (doc + chart + seeder derive from it). */
export type DeployContract = {
  readonly secrets: ReadonlyArray<SecretReq>;
  readonly extensions: ReadonlyArray<ExtensionReq>;
  readonly schemas: ReadonlyArray<string>;
  readonly config: ReadonlyArray<ConfigReq>;
}

/** The observed runtime state the validator judges the contract against (produced by the IO wrapper). */
export type ObservedState = {
  /** Secret name → resolved value (undefined = absent). */
  readonly secrets: Record<string, string | undefined>;
  /** Extension names present in the DB. */
  readonly extensions: ReadonlyArray<string>;
  /** Schema names present in the DB. */
  readonly schemas: ReadonlyArray<string>;
  /** Env var → value (undefined = unset). */
  readonly config: Record<string, string | undefined>;
}

/** A single actionable preflight failure: what is wrong, why it matters, and the exact fix. */
export type DeployFailure = {
  readonly what: string;
  readonly why: string;
  readonly fix: string;
}

function vaultFix(s: SecretReq): string {
  const keyPart = s.key === undefined ? "" : ` (key: ${s.key})`;
  return `seed Vault path ${s.vaultPath}${keyPart}`;
}

/** True when a present secret value satisfies its declared format. */
function formatOk(value: string, format: SecretFormat | undefined): boolean {
  switch (format) {
    case "dsn":
      return value.includes("://");
    case "pem":
      return value.includes("-----BEGIN");
    case "nonempty":
    case undefined:
      return value.length > 0;
  }
}

/**
 * Validate the observed state against the contract; return one {@link DeployFailure} per problem
 * (empty array = ready). Pure — no IO. The composition root throws on a non-empty result.
 */
export function evaluateDeployContract(
  contract: DeployContract,
  observed: ObservedState,
): Array<DeployFailure> {
  const failures: Array<DeployFailure> = [];

  for (const s of contract.secrets) {
    const value = observed.secrets[s.name];
    if (value === undefined || value === "") {
      if (s.required) {
        failures.push({
          what: `required secret ${s.name} is missing`,
          why: s.gates ?? `the app requires ${s.name} at boot`,
          fix: vaultFix(s),
        });
      }
      continue;
    }
    if (!formatOk(value, s.format)) {
      failures.push({
        what: `secret ${s.name} is malformed (expected ${s.format})`,
        why: s.gates ?? `${s.name} must be a valid ${s.format}`,
        fix: vaultFix(s),
      });
    }
  }

  for (const ext of contract.extensions) {
    if (!observed.extensions.includes(ext.name)) {
      failures.push({
        what: `required Postgres extension ${ext.name} is not installed`,
        why: `the schema baseline + runtime depend on ${ext.name}`,
        fix: `on the (self-managed) Postgres, run: ${ext.createSql}`,
      });
    }
  }

  for (const schema of contract.schemas) {
    if (!observed.schemas.includes(schema)) {
      failures.push({
        what: `required schema "${schema}" is missing`,
        why: `the migrations create it; a missing schema means migrations have not run`,
        fix: `run the migrate job (npm run migrate:up) against this database`,
      });
    }
  }

  for (const c of contract.config) {
    const value = observed.config[c.env];
    if (value === undefined || value === "") {
      if (c.required && c.default === undefined) {
        failures.push({
          what: `required config ${c.env} is unset`,
          why: `${c.env} has no safe default and must be provided`,
          fix: `set ${c.env} (Helm: config.* / extraEnv)`,
        });
      }
      continue;
    }
    if (c.oneOf !== undefined && !c.oneOf.includes(value)) {
      failures.push({
        what: `config ${c.env}="${value}" is not allowed`,
        why: `${c.env} must be one of: ${c.oneOf.join(", ")}`,
        fix: `set ${c.env} to one of: ${c.oneOf.join(", ")}`,
      });
    }
  }

  return failures;
}

/**
 * THE deploy contract — the single source of truth a first deploy is validated against. The doc,
 * the Helm chart, and the seeding helper all derive from this. Conditional/auth-gated secrets
 * (field-encryption keyset, api/auth) are marked optional here because the eager key-load already
 * fails loud when auth routes are on; the UNCONDITIONAL hard requirements below are what a turnkey
 * deploy most often misses.
 */
export const DEPLOY_CONTRACT: DeployContract = {
  secrets: [
    {
      name: "CODEMASTER_PG_CORE_DSN",
      source: "env",
      vaultPath: "codemaster/postgres/app",
      key: "dsn",
      required: true,
      format: "dsn",
      gates: "the primary application database — nothing works without it",
    },
    {
      name: "CODEMASTER_PG_MAINT_DSN",
      source: "env",
      vaultPath: "codemaster/postgres/maint",
      key: "dsn",
      required: false,
      format: "dsn",
      gates: "partition maintenance (pg_partman) — unset means partitions stop being maintained",
    },
    {
      name: "github_app.app_id",
      source: "file",
      fileName: "codemaster_github_app",
      vaultPath: "codemaster/github/app",
      key: "app_id",
      required: true,
      gates: "GitHub App authentication — no PR reviews are possible without it",
    },
    {
      name: "github_app.private_key_pem",
      source: "file",
      fileName: "codemaster_github_app",
      vaultPath: "codemaster/github/app",
      key: "private_key_pem",
      required: true,
      format: "pem",
      gates: "GitHub App authentication (clone + post review)",
    },
    {
      name: "github_app.webhook_secret",
      source: "file",
      fileName: "codemaster_github_app",
      vaultPath: "codemaster/github/app",
      key: "webhook_secret",
      required: true,
      gates: "inbound webhook HMAC verification",
    },
    {
      name: "field_encryption.keys",
      source: "file",
      fileName: "codemaster_field_encryption_keys",
      vaultPath: "codemaster/field-encryption/keys",
      key: "keys",
      required: false,
      gates: "field-level encryption keyset (eager-loaded at boot when auth routes are on)",
    },
    {
      name: "api_auth",
      source: "file",
      fileName: "codemaster_api_auth",
      vaultPath: "codemaster/api/auth",
      required: false,
      gates: "session / auth-route secrets (required only when auth routes are enabled)",
    },
  ],
  extensions: [
    { name: "pg_partman", createSql: "CREATE EXTENSION IF NOT EXISTS pg_partman WITH SCHEMA partman;" },
    { name: "vector", createSql: "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;" },
  ],
  schemas: ["core", "audit", "cache", "telemetry", "partman"],
  config: [
    { env: "CODEMASTER_RUNTIME_MODE", required: false, default: "postgres", oneOf: ["postgres", "shadow"] },
    {
      env: "CODEMASTER_EMBEDDINGS_PROVIDER",
      required: false,
      default: "platform",
      oneOf: ["platform", "openai_compat"],
    },
  ],
};

/** IO seams the observer needs (injected for tests; real wiring reads env + Vault files + the DB). */
export type ObserveDeps = {
  /** Read an env var (real: name => process.env[name]). */
  readonly env: (name: string) => string | undefined;
  /** Read a Vault-Agent-rendered secret file by its sanitized filename; null when absent. */
  readonly readSecretFile: (fileName: string) => Promise<Record<string, string> | null>;
  /** Installed Postgres extension names. */
  readonly listExtensions: () => Promise<ReadonlyArray<string>>;
  /** Present schema names. */
  readonly listSchemas: () => Promise<ReadonlyArray<string>>;
};

/** Resolve the {@link ObservedState} the validator judges against. Reads each rendered file at most once. */
export async function observeDeployState(
  contract: DeployContract,
  deps: ObserveDeps,
): Promise<ObservedState> {
  const fileCache = new Map<string, Record<string, string> | null>();
  const readFileOnce = async (fileName: string): Promise<Record<string, string> | null> => {
    if (!fileCache.has(fileName)) {
      fileCache.set(fileName, await deps.readSecretFile(fileName));
    }
    return fileCache.get(fileName) ?? null;
  };

  const secrets: Record<string, string | undefined> = {};
  for (const s of contract.secrets) {
    if (s.source === "env") {
      secrets[s.name] = deps.env(s.name);
      continue;
    }
    const data = s.fileName === undefined ? null : await readFileOnce(s.fileName);
    if (data === null) {
      secrets[s.name] = undefined;
    } else if (s.key !== undefined) {
      secrets[s.name] = data[s.key];
    } else {
      // Presence-only file secret (keys vary): satisfied if the file rendered with any content.
      secrets[s.name] = Object.keys(data).length > 0 ? "present" : undefined;
    }
  }

  const [extensions, schemas] = await Promise.all([deps.listExtensions(), deps.listSchemas()]);

  const config: Record<string, string | undefined> = {};
  for (const c of contract.config) {
    config[c.env] = deps.env(c.env);
  }

  return { secrets, extensions, schemas, config };
}

/** The deploy contract is not satisfied — the pod MUST NOT serve. Carries the full failure list. */
export class DeployContractError extends Error {
  public readonly failures: ReadonlyArray<DeployFailure>;
  public constructor(failures: ReadonlyArray<DeployFailure>) {
    super(formatDeployFailures(failures));
    this.name = "DeployContractError";
    this.failures = failures;
  }
}

/** Render failures as one operator-facing remediation list (what / why / fix, numbered). */
export function formatDeployFailures(failures: ReadonlyArray<DeployFailure>): string {
  const lines = failures.map(
    (f, i) => `  ${i + 1}. ${f.what}\n     why: ${f.why}\n     fix: ${f.fix}`,
  );
  return (
    `deploy preflight failed — ${failures.length} unmet requirement(s); refusing to serve:\n` +
    lines.join("\n")
  );
}

/**
 * Observe + validate the deploy contract; throw {@link DeployContractError} (listing EVERY problem
 * at once) if anything is unmet. The composition root awaits this before the HTTP bind.
 */
export async function assertDeployReady(
  deps: ObserveDeps,
  contract: DeployContract = DEPLOY_CONTRACT,
): Promise<void> {
  const observed = await observeDeployState(contract, deps);
  const failures = evaluateDeployContract(contract, observed);
  if (failures.length > 0) {
    throw new DeployContractError(failures);
  }
}
