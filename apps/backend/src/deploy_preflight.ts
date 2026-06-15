// Deploy-contract preflight (turnkey-deployment plan, Phase 1): a declarative source of truth for
// everything a first deploy MUST have — secrets, DB extensions/schemas, required config — plus a
// pure validator that turns the observed runtime state into actionable failures (each names the
// exact missing thing AND the one-line fix). The composition root runs it BEFORE the HTTP bind,
// beside {@link assertSchemaRevision}, so a misconfigured pod exits 1 with a self-serve remediation
// list instead of going Ready-but-dead. evaluateDeployContract is IO-free (inject ObservedState) so
// it is exhaustively unit-testable; the thin IO wrapper that reads env / queries the DB lives apart.

import {
  FIELD_KEYSET_ENV,
  type FieldKeySource,
  resolveFieldKeySource,
} from "#backend/security/boot_field_keys.js";

/** Where a secret is delivered to the app: an env var, or a Vault-Agent-rendered file. */
export type SecretSource = "env" | "file";

/** Lightweight well-formedness check applied when a secret IS present. */
export type SecretFormat = "dsn" | "pem" | "nonempty" | "keyset";

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
  /** BLOCKING bootstrap secrets — the pod must not start without them (DB creds, field key). */
  readonly secrets: ReadonlyArray<SecretReq>;
  /** NON-BLOCKING feature secrets (LLM/GitHub/Confluence) — reported by getConfigStatus, set later
   *  via UI/env/Vault; their absence degrades only that feature, never boot. */
  readonly advisory: ReadonlyArray<SecretReq>;
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
    // "keyset": observed value is the env keyset JSON (openshift) or the "present" sentinel (file/vault);
    // presence suffices here — the loader's boot self-check does the deep keyset validation.
    case "nonempty":
    case "keyset":
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
  // BLOCKING: the two bootstrap secrets (DB creds + field-encryption key). The pod must not start
  // without them. Provisioned from the selected source (openshift|vault); never UI-set.
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
      name: "field_encryption.keys",
      source: "file",
      fileName: "codemaster_field_encryption_keys",
      vaultPath: "codemaster/field-encryption/keys",
      // WHOLE-SECRET: the KV payload IS the keyset ({current_version, keys:{...}}) — the loader reads it
      // via kvReadRaw (the nested keys object must survive). NOT a flat key=value: seeding it as
      // `keys="<json>"` produces no top-level current_version → the loader crashloops (the P0 seed bug).
      // The seeder pipes the full JSON via stdin; the observer checks current_version (see below).
      format: "keyset",
      required: true,
      gates: "field-level encryption keyset — the root of trust for all UI-saved secrets",
    },
  ],
  // NON-BLOCKING feature secrets: GitHub / Confluence / auth-session. Set later via UI, env, or
  // Vault; absence degrades only that feature, never boot. Reported by getConfigStatus.
  advisory: [
    {
      name: "github_app.app_id",
      source: "file",
      fileName: "codemaster_github_app",
      vaultPath: "codemaster/github/app",
      key: "app_id",
      required: false,
      gates: "GitHub App authentication (no PR reviews until configured)",
    },
    {
      name: "github_app.private_key_pem",
      source: "file",
      fileName: "codemaster_github_app",
      vaultPath: "codemaster/github/app",
      key: "private_key_pem",
      required: false,
      format: "pem",
      gates: "GitHub App authentication (clone + post review)",
    },
    {
      name: "github_app.webhook_secret",
      source: "file",
      fileName: "codemaster_github_app",
      vaultPath: "codemaster/github/app",
      key: "webhook_secret",
      required: false,
      gates: "inbound webhook HMAC verification",
    },
    // Confluence is a TWO-key secret at one Vault path: the provider (ConfluenceTokenProvider.refreshOnce)
    // REQUIRES base_url AND token, so config-status must track BOTH — else it reports "configured" with only
    // the token seeded while the runtime throws "missing base_url" (review: configured-but-broken).
    {
      name: "confluence.base_url",
      source: "file",
      fileName: "codemaster_confluence_token",
      vaultPath: "codemaster/confluence/token",
      key: "base_url",
      required: false,
      gates: "Confluence ingestion (knowledge corpus)",
    },
    {
      name: "confluence.token",
      source: "file",
      fileName: "codemaster_confluence_token",
      vaultPath: "codemaster/confluence/token",
      key: "token",
      required: false,
      gates: "Confluence ingestion (knowledge corpus)",
    },
    // Two keys at the one codemaster/api/auth path — the seeder groups by path into a single `vault kv
    // put session_signing_key=… csrf_secret=…` (review P1). openshift mode reads these from env (P0-A.2b).
    // ADVISORY (required:false) is CORRECT: when neither env nor Vault provides them the app AUTO-GENERATES
    // + persists them in core.auth_secrets at boot (review P0) — they're optional, NOT bootstrap secrets.
    {
      name: "api_auth.session_signing_key",
      source: "file",
      fileName: "codemaster_api_auth",
      vaultPath: "codemaster/api/auth",
      key: "session_signing_key",
      required: false,
      gates: "session signing key (auth routes) — auto-generated + persisted if unset",
    },
    {
      name: "api_auth.csrf_secret",
      source: "file",
      fileName: "codemaster_api_auth",
      vaultPath: "codemaster/api/auth",
      key: "csrf_secret",
      required: false,
      gates: "CSRF secret (auth routes) — auto-generated + persisted if unset",
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
  /** Read a Vault KV path (flattened to strings) via SA-auth — used to ACTUALLY validate the field-encryption
   *  keyset in vault mode (presence of a top-level current_version) instead of inferring it from VAULT_ADDR.
   *  Undefined in unit/test contexts → the vault branch falls back to VAULT_ADDR-presence. */
  readonly readVaultKv?: (path: string) => Promise<Record<string, string>>;
};

/** Resolve the field-key source from the observe deps' env reader, swallowing a garbage-source throw
 *  (the boot loader fails loud on that separately) → null, which the observer treats as the file path. */
function resolveFieldKeySourceSafe(env: (name: string) => string | undefined): FieldKeySource | null {
  try {
    return resolveFieldKeySource(
      {
        NODE_ENV: env("NODE_ENV"),
        CODEMASTER_FIELD_KEY_SOURCE: env("CODEMASTER_FIELD_KEY_SOURCE"),
        CODEMASTER_SECRET_SOURCE: env("CODEMASTER_SECRET_SOURCE"),
      },
      false,
    );
  } catch {
    return null;
  }
}

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
  // Observe BOTH tiers: blocking secrets (validated) + advisory feature secrets (reported by
  // getConfigStatus). Advisory presence here is the env/file/Vault view; DB-set config is layered in
  // by the feature repos (Step 4).
  for (const s of [...contract.secrets, ...contract.advisory]) {
    // field_encryption.keys is observed per the RESOLVED field-key source (P0-A), not always as a file:
    // openshift → the CODEMASTER_FIELD_ENCRYPTION_KEYSET env var; vault → presence-by-VAULT_ADDR (the
    // SA-auth read happens at boot, not here); vault-agent/file → the rendered file (the declared source).
    let source: SecretSource = s.source;
    let envName = s.name;
    if (s.name === "field_encryption.keys") {
      const fk = resolveFieldKeySourceSafe(deps.env);
      if (fk === "env") {
        source = "env";
        envName = FIELD_KEYSET_ENV;
      } else if (fk === "vault") {
        if (deps.env("VAULT_ADDR") === undefined) {
          secrets[s.name] = undefined;
        } else if (deps.readVaultKv !== undefined) {
          // ACTUALLY read the keyset via SA-auth (review): a bad path/policy/malformed keyset now FAILS
          // deploy:check with the path named, instead of passing on mere VAULT_ADDR presence. The flattened
          // read keeps top-level current_version (a string); the nested keys object is the boot loader's
          // deeper check. A read error → report missing (actionable) + log the specific cause.
          try {
            const kv = await deps.readVaultKv(s.vaultPath);
            const cv = kv["current_version"];
            secrets[s.name] = typeof cv === "string" && cv !== "" ? "present" : undefined;
          } catch (err) {
            console.warn(
              `deploy preflight: field-encryption keyset read from Vault path '${s.vaultPath}' failed ` +
                `(${err instanceof Error ? err.message : String(err)}) — check the path, the role's read ` +
                `policy, and that the keyset is seeded.`,
            );
            secrets[s.name] = undefined;
          }
        } else {
          // No Vault reader injected (unit/test) → legacy presence-by-VAULT_ADDR.
          secrets[s.name] = "present";
        }
        continue;
      } else {
        // file / vault-agent / null: the rendered file IS the whole keyset ({current_version, keys:{...}}).
        // parseRenderedSecret drops the nested keys OBJECT, so presence = a top-level current_version
        // string — NOT a `keys` field (seeding `keys="<json>"` is the P0 bug the loader rejects at boot).
        const data = s.fileName === undefined ? null : await readFileOnce(s.fileName);
        const cv = data?.["current_version"];
        secrets[s.name] = typeof cv === "string" && cv !== "" ? "present" : undefined;
        continue;
      }
    }
    if (source === "env") {
      secrets[s.name] = deps.env(envName);
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

/**
 * Parse a Vault-Agent-rendered secret file's contents into a string→string map (the
 * `.Data.data | toJSON` shape), or null when the content is not a JSON object. Non-string values
 * are dropped (KV secret material is always strings). Pure — the fs read is the caller's.
 */
export function parseRenderedSecret(raw: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string") {
      out[k] = v;
    }
  }
  return out;
}

// ─── Partition runway preflight (F1 / P0-1) ───────────────────────────────────────────────────────
// pg_partman premakes future partitions only for parents registered in partman.part_config; once a
// parent's furthest future partition is reached, rows fall into its *_default partition and retention
// stops. This check (operator/CI deploy:check ONLY — NOT the boot crashloop path) flags a registered
// parent whose runway is about to lapse, so a stalled run_maintenance is caught before the cliff.

/** Days of remaining partition runway below which a parent is flagged. */
export const DEFAULT_PARTITION_RUNWAY_MIN_DAYS = 7;

/** A registered pg_partman parent + the upper bound (ms epoch) of its furthest future partition; null
 *  when the parent has NO range child partition at all (only its *_default). */
export type PartitionRunwayObservation = {
  readonly parent: string;
  readonly furthestBoundMs: number | null;
};

/**
 * Flag every registered parent whose furthest future partition is absent or within `minDays` of `nowMs`.
 * Pure — the catalog query lives in the IO wrapper. Boundary is fail-closed (exactly minDays out → short).
 */
export function evaluatePartitionRunways(
  observations: ReadonlyArray<PartitionRunwayObservation>,
  nowMs: number,
  minDays: number,
): Array<DeployFailure> {
  const minMs = minDays * 86_400_000;
  const failures: Array<DeployFailure> = [];
  for (const o of observations) {
    if (o.furthestBoundMs === null) {
      failures.push({
        what: `partitioned table ${o.parent} has NO future partition`,
        why: "pg_partman run_maintenance is not premaking partitions; rows will fall into the *_default partition",
        fix: "ensure the daily partition-maintenance job runs (partman.run_maintenance), then verify part_config",
      });
      continue;
    }
    if (o.furthestBoundMs - nowMs <= minMs) {
      const days = Math.floor((o.furthestBoundMs - nowMs) / 86_400_000);
      failures.push({
        what: `partitioned table ${o.parent} runway is ${days}d (< ${minDays}d)`,
        why: "the furthest premade partition is about to be reached; new rows will soon fall into *_default",
        fix: "run/repair the daily partition-maintenance job (partman.run_maintenance) so it premakes ahead",
      });
    }
  }
  return failures;
}

/** IO seam for the runway check: the furthest future partition bound per registered pg_partman parent. */
export type RunwayObserveDeps = {
  readonly listPartitionRunways: () => Promise<ReadonlyArray<PartitionRunwayObservation>>;
  readonly now: () => Date;
};

/**
 * Observe + evaluate partition runways; throw {@link DeployContractError} if any registered parent is
 * within `minDays` of its cliff. Wired into deploy_check (operator/CI) ONLY — never the boot path, so a
 * stalled maintenance job never crashloops a serving pod.
 */
export async function assertPartitionRunwaysHealthy(
  deps: RunwayObserveDeps,
  minDays: number = DEFAULT_PARTITION_RUNWAY_MIN_DAYS,
): Promise<void> {
  const observations = await deps.listPartitionRunways();
  const failures = evaluatePartitionRunways(observations, deps.now().getTime(), minDays);
  if (failures.length > 0) {
    throw new DeployContractError(failures);
  }
}

/** The observed embedding-dimension state: the configured EMBEDDING_DIM and the DB's recorded widths. */
export type EmbeddingDimensionObservation = {
  readonly configuredDim: number;
  readonly activeGenerationDim: number | null;
  readonly activeEmbeddingDimension: number | null;
  readonly columnDims: ReadonlyArray<{ readonly column: string; readonly dim: number }>;
};

/**
 * Flag any disagreement between the configured EMBEDDING_DIM and the DB's recorded widths (the active
 * generation's embedding_dimension, embedder_runtime_state.active_embedding_dimension, and every pgvector
 * column typmod). Pure — the catalog queries live in the IO wrapper. Catches a missed/partial
 * `set-embedding-dimension` at deploy:check time instead of as a lazy runtime failure in retrieval.
 */
export function evaluateEmbeddingDimension(obs: EmbeddingDimensionObservation): Array<DeployFailure> {
  const failures: Array<DeployFailure> = [];
  const fix =
    "set CODEMASTER_EMBEDDING_DIMENSION and run `npm run set-embedding-dimension -- <dim>` against the " +
    "owner DSN BEFORE ingesting (greenfield); env, active generation, and columns must agree";
  if (obs.activeGenerationDim !== null && obs.activeGenerationDim !== obs.configuredDim) {
    failures.push({
      what: `active generation embeds at ${obs.activeGenerationDim}-dim but CODEMASTER_EMBEDDING_DIMENSION=${obs.configuredDim}`,
      why: "the embedder cache rejects an active generation whose dimension != the configured EMBEDDING_DIM — retrieval fails",
      fix,
    });
  }
  if (obs.activeEmbeddingDimension !== null && obs.activeEmbeddingDimension !== obs.configuredDim) {
    failures.push({
      what: `embedder_runtime_state.active_embedding_dimension=${obs.activeEmbeddingDimension} != EMBEDDING_DIM ${obs.configuredDim}`,
      why: "the recorded corpus width disagrees with the configured dimension",
      fix,
    });
  }
  for (const c of obs.columnDims) {
    if (c.dim !== obs.configuredDim) {
      failures.push({
        what: `pgvector column ${c.column} is vector(${c.dim}) but EMBEDDING_DIM=${obs.configuredDim}`,
        why: "writing a configured-width vector into a different-width column fails with a dimension mismatch",
        fix,
      });
    }
  }
  return failures;
}

/** IO seam for the embedding-dimension check: the configured dim + the DB's recorded widths. */
export type EmbeddingDimensionObserveDeps = {
  readonly observeEmbeddingDimension: () => Promise<EmbeddingDimensionObservation>;
};

/**
 * Observe + evaluate embedding-dimension consistency; throw {@link DeployContractError} on any mismatch.
 * Wired into deploy_check (operator/CI) like the runway check — NOT the boot path (no crashloop).
 */
export async function assertEmbeddingDimensionConsistent(
  deps: EmbeddingDimensionObserveDeps,
): Promise<void> {
  const failures = evaluateEmbeddingDimension(await deps.observeEmbeddingDimension());
  if (failures.length > 0) {
    throw new DeployContractError(failures);
  }
}

/** A non-blocking feature-config item's state, for /config-status (never carries the secret value). */
export type ConfigStatusItem = {
  readonly key: string;
  /** configured = a value is present + active; disabled = saved in the UI but enabled=false (creds exist
   *  but the feature is turned off — distinct from pending so the checklist doesn't imply it's live OR
   *  unconfigured); pending = not yet set in any source. */
  readonly state: "configured" | "disabled" | "pending";
  /** Where the value came from: "db" (UI-saved, overrides env/file), "env"/"file" (the observed tier),
   *  or "none" (pending). */
  readonly source: SecretSource | "db" | "none";
  readonly gates?: string;
};

/**
 * Report the state of each NON-BLOCKING advisory feature secret (GitHub/Confluence/auth) from the
 * observed env/file/Vault view. Drives the UI setup-checklist + the operator's /config-status. Never
 * returns secret values — only presence/source. The pod is ready regardless of these.
 */
export function getConfigStatus(
  contract: DeployContract,
  observed: ObservedState,
): Array<ConfigStatusItem> {
  return contract.advisory.map((s) => {
    const value = observed.secrets[s.name];
    const present = value !== undefined && value !== "";
    return {
      key: s.name,
      state: present ? "configured" : "pending",
      source: present ? s.source : "none",
      ...(s.gates === undefined ? {} : { gates: s.gates }),
    };
  });
}
