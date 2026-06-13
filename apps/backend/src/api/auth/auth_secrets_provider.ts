// Auth-secrets provider — the session HMAC signing key + CSRF double-submit secret, read from Vault.
//
// Follows ADR-0071's Vault-read seam (invariant 3: no secrets in env vars): CODEMASTER_VAULT_SECRET_SOURCE=
// agent-file reads the Vault-Agent-rendered file (FileKvReader), else the lazy Vault HTTP API.
//
// Expected Vault layout (to be seeded — these are NOT in the dev seed-vault.sh yet):
//   secret/codemaster/api/auth  { session_signing_key: "<>=32 chars>", csrf_secret: "<>=32 chars>" }

import { FileKvReader } from "#backend/adapters/vault_file_kv.js";
import { VaultHttpPort } from "#backend/adapters/vault_http.js";
import type { AuthSecrets } from "#backend/api/auth/auth_secrets_repo.js";

import type { VaultKvReadPort } from "#backend/ingest/webhook_secret_provider.js";

export const AUTH_SECRETS_VAULT_PATH = "codemaster/api/auth";
const SIGNING_KEY = "session_signing_key";
const CSRF_KEY = "csrf_secret";
// Both secrets must be >= 32 chars.
const MIN_SECRET_LENGTH = 32;

function readKey(data: Record<string, string>, key: string): Uint8Array {
  // `key` here is one of two hardcoded module constants, never request-derived.
  // eslint-disable-next-line security/detect-object-injection
  const value = data[key];
  if (value === undefined) {
    throw new Error(
      `Vault path '${AUTH_SECRETS_VAULT_PATH}' missing key '${key}'; seed it (>=${MIN_SECRET_LENGTH} chars)`,
    );
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `Vault '${AUTH_SECRETS_VAULT_PATH}.${key}' is ${value.length} chars; must be >= ${MIN_SECRET_LENGTH}`,
    );
  }
  return new TextEncoder().encode(value);
}

/** Reads the session signing key + CSRF secret from one Vault KV secret. */
export class VaultAuthSecretsProvider {
  readonly #vault: VaultKvReadPort;

  public constructor(args: { vault: VaultKvReadPort }) {
    this.#vault = args.vault;
  }

  public async sessionSigningKey(): Promise<Uint8Array> {
    return readKey(await this.#vault.kvRead({ path: AUTH_SECRETS_VAULT_PATH }), SIGNING_KEY);
  }

  public async csrfSecret(): Promise<Uint8Array> {
    return readKey(await this.#vault.kvRead({ path: AUTH_SECRETS_VAULT_PATH }), CSRF_KEY);
  }
}

/** openshift-mode reader: the session signing key + CSRF secret come from env vars (a k8s Secret),
 *  mapped onto the same record shape {@link VaultAuthSecretsProvider} reads — so the >=32-char + missing-key
 *  validation in {@link readKey} applies identically. Never touches Vault. */
function envAuthSecretsReader(): VaultKvReadPort {
  return {
    kvRead: () => {
      const signing = process.env["CODEMASTER_SESSION_SIGNING_KEY"];
      const csrf = process.env["CODEMASTER_CSRF_SECRET"];
      const data: Record<string, string> = {
        ...(signing !== undefined && signing !== "" ? { [SIGNING_KEY]: signing } : {}),
        ...(csrf !== undefined && csrf !== "" ? { [CSRF_KEY]: csrf } : {}),
      };
      return Promise.resolve(data);
    },
  };
}

/**
 * Source-select the auth-secrets provider by env (ADR-0071), mirroring makeWebhookSecretProvider.
 * `agent-file` reads the Vault-Agent-rendered file; anything else lazily builds the Vault HTTP port (so the
 * server boots without VAULT_ADDR and only the first read touches Vault).
 */
/** The configured (non-DB) reader: env (openshift) / agent-file / lazy Vault HTTP API. */
function selectBaseAuthReader(): VaultKvReadPort {
  // openshift mode (the bootstrap-secret switch): the auth secrets come from env (a k8s Secret), never
  // Vault — so the API server boots with no VAULT_ADDR. (vault mode keeps the ADR-0071 agent-file/API selector.)
  if (process.env["CODEMASTER_SECRET_SOURCE"] === "openshift") {
    return envAuthSecretsReader();
  }
  const source = process.env["CODEMASTER_VAULT_SECRET_SOURCE"] ?? "vault-api";
  if (source === "agent-file") {
    return new FileKvReader();
  }
  // Lazy Vault HTTP: defer building the port until the first read.
  let port: VaultHttpPort | undefined;
  return {
    kvRead: async (args) => {
      port ??= VaultHttpPort.fromEnv();
      return port.kvRead(args);
    },
  };
}

/**
 * Source-select the auth-secrets provider, resolving env/Vault > DB(auto-generated). When neither env
 * (openshift) nor Vault supplies BOTH keys, the `dbFallback` (PostgresAuthSecretsRepo.ensure — auto-generate
 * + persist field-codec-encrypted, race-safe) provides them — so the pod boots on only the DB + the
 * field-encryption key, and these are NOT operator bootstrap secrets (review P0). Without a dbFallback
 * (tests / no DB) the configured source must supply both keys, or readKey throws.
 */
export function makeAuthSecretsProvider(opts?: {
  dbFallback?: () => Promise<AuthSecrets>;
}): VaultAuthSecretsProvider {
  const base = selectBaseAuthReader();
  const dbFallback = opts?.dbFallback;
  if (dbFallback === undefined) {
    return new VaultAuthSecretsProvider({ vault: base });
  }
  // Memoized so the two accessors (signing key + csrf) resolve — and ensure — exactly once per boot.
  let cached: Record<string, string> | undefined;
  const resolving: VaultKvReadPort = {
    kvRead: async (args) => {
      if (cached !== undefined) {
        return cached;
      }
      let baseData: Record<string, string> = {};
      try {
        baseData = await base.kvRead(args);
      } catch {
        // Configured source unavailable (Vault down / path missing) → fall back to the persisted DB secrets.
      }
      if (typeof baseData[SIGNING_KEY] === "string" && typeof baseData[CSRF_KEY] === "string") {
        cached = baseData; // operator-provided env/Vault wins
        return cached;
      }
      const db = await dbFallback();
      // env/Vault overrides DB for any key it DID provide; DB fills the rest (incl. the all-absent case).
      cached = { [SIGNING_KEY]: db.sessionSigningKey, [CSRF_KEY]: db.csrfSecret, ...baseData };
      return cached;
    },
  };
  return new VaultAuthSecretsProvider({ vault: resolving });
}
