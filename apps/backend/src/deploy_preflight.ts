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
