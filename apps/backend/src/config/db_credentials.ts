// Resolve the Postgres DSN from the selected bootstrap-secret source (openshift env | vault path).
// One of the two boot-required secrets. No fallback between sources — the selected source must carry
// the creds, else we fail loud naming exactly what to set/seed (resolveSecretSource enforces the
// switch). The non-secret host/port/database come from the ConfigMap env when assembling from parts.

import { resolveSecretSource } from "./secret_source.js";

/** The Vault KV path the DB creds live at when source=vault (override via CODEMASTER_PG_VAULT_PATH). */
export const DEFAULT_PG_VAULT_PATH = "codemaster/postgres/app";
const DEFAULT_PG_PORT = "5432";

/** Build a libpq URL, URL-encoding the user + password (host/port/db are not encoded). */
export function assembleDsn(parts: {
  user: string;
  password: string;
  host: string;
  port?: string | undefined;
  database: string;
}): string {
  const port = parts.port === undefined || parts.port === "" ? DEFAULT_PG_PORT : parts.port;
  // user/password AND the database path segment are URL-encoded (they may carry reserved chars like @ / :).
  // host/port come from the operator's ConfigMap (trusted, non-secret) and are interpolated as-is —
  // encoding the host would corrupt an IPv6 literal like [::1]. (review P3)
  return `postgresql://${encodeURIComponent(parts.user)}:${encodeURIComponent(parts.password)}@${parts.host}:${port}/${encodeURIComponent(parts.database)}`;
}

export type DbCredentialDeps = {
  readonly env: Record<string, string | undefined>;
  /** Read a Vault KV path → its string map (provided by the K8s-auth client in vault mode). */
  readonly readVaultKv: (path: string) => Promise<Record<string, string>>;
};

/**
 * Resolve the Postgres DSN. openshift: a full `CODEMASTER_PG_CORE_DSN`, else assemble from
 * `CODEMASTER_PG_USER`/`_PASSWORD` (+ `_HOST`/`_PORT`/`_DATABASE` from the ConfigMap). vault: read the
 * KV path → a `dsn` key, else `username`+`password` assembled with the ConfigMap host/port/db.
 */
export async function resolveDbDsn(deps: DbCredentialDeps): Promise<string> {
  const { env } = deps;
  const source = resolveSecretSource(env, "CODEMASTER_PG_SECRET_SOURCE");
  const host = env["CODEMASTER_PG_HOST"];
  const port = env["CODEMASTER_PG_PORT"];
  const database = env["CODEMASTER_PG_DATABASE"];

  if (source === "openshift") {
    const full = env["CODEMASTER_PG_CORE_DSN"];
    if (full !== undefined && full !== "") {
      return full;
    }
    const user = env["CODEMASTER_PG_USER"];
    const password = env["CODEMASTER_PG_PASSWORD"];
    if (user === undefined || password === undefined || host === undefined || database === undefined) {
      throw new Error(
        "DB creds not found (source=openshift): set CODEMASTER_PG_CORE_DSN, or " +
          "CODEMASTER_PG_USER + CODEMASTER_PG_PASSWORD + CODEMASTER_PG_HOST + CODEMASTER_PG_DATABASE",
      );
    }
    return assembleDsn({ user, password, host, port, database });
  }

  // source === "vault"
  const path = env["CODEMASTER_PG_VAULT_PATH"] ?? DEFAULT_PG_VAULT_PATH;
  const kv = await deps.readVaultKv(path);
  if (typeof kv["dsn"] === "string" && kv["dsn"] !== "") {
    return kv["dsn"];
  }
  const user = kv["username"];
  const password = kv["password"];
  if (user === undefined || password === undefined || host === undefined || database === undefined) {
    throw new Error(
      `DB creds not found (source=vault): Vault path ${path} must carry "dsn", or "username"+` +
        `"password" with CODEMASTER_PG_HOST + CODEMASTER_PG_DATABASE set`,
    );
  }
  return assembleDsn({ user, password, host, port, database });
}
