// Runtime Confluence config resolution (go-live Step 4c, read-side). The token provider's creds
// ({base_url, token, email}) resolve DB (UI) > env > Vault > disabled — the first non-null tier wins —
// so a UI-saved Confluence config (stored field-codec-encrypted in core.confluence_settings) actually
// takes effect at runtime, not just at GET. Mirrors github_config_resolver (4b). Absence degrades only
// Confluence ingestion (no knowledge sync), never boot.

import { VaultHttpPort } from "#backend/adapters/vault_http.js";
import { PostgresConfluenceSettingsRepo } from "#backend/integrations/confluence/confluence_settings_repo.js";
import {
  type ConfluenceVaultReader,
  VAULT_KV_PATH,
} from "#backend/integrations/confluence/token_provider.js";
import { getAuditKeyRegistry } from "#backend/security/audit_field_codec.js";

import { resolveLayered } from "#backend/config/layered_config.js";

export type ConfluenceConfig = {
  readonly baseUrl: string;
  readonly authEmail: string | null;
  readonly token: string;
};

/** env-tier config: CODEMASTER_CONFLUENCE_BASE_URL + _TOKEN (+ optional _AUTH_EMAIL); null unless both
 *  required vars are set. */
export function confluenceConfigFromEnv(env: (name: string) => string | undefined): ConfluenceConfig | null {
  const baseUrl = env("CODEMASTER_CONFLUENCE_BASE_URL");
  const token = env("CODEMASTER_CONFLUENCE_TOKEN");
  if (!baseUrl || !token) {
    return null;
  }
  const email = env("CODEMASTER_CONFLUENCE_AUTH_EMAIL");
  return { baseUrl, token, authEmail: email !== undefined && email !== "" ? email : null };
}

/** Map a Vault KV record (codemaster/confluence/token — keys base_url/token/email) to a config, or null. */
export function confluenceConfigFromVaultData(data: Record<string, string>): ConfluenceConfig | null {
  const baseUrl = data["base_url"];
  const token = data["token"];
  if (!baseUrl || !token) {
    return null;
  }
  const email = data["email"];
  return { baseUrl, token, authEmail: email !== undefined && email !== "" ? email : null };
}

/** DB tier: the UI-saved platform row (field-codec decrypted via the boot registry), or null. The
 *  registry guard keeps unit/test contexts (no registry installed) from opening a DB connection. */
async function confluenceConfigFromDb(): Promise<ConfluenceConfig | null> {
  const dsn = process.env["CODEMASTER_PG_CORE_DSN"];
  const registry = getAuditKeyRegistry();
  if (dsn === undefined || dsn === "" || registry === null) {
    return null;
  }
  const settings = await PostgresConfluenceSettingsRepo.fromDsn({ dsn, registry }).read();
  return settings === null
    ? null
    : { baseUrl: settings.baseUrl, authEmail: settings.authEmail, token: settings.token };
}

/** The {base_url, token, email} record ConfluenceTokenProvider.refreshOnce parses. */
function toSecretRecord(c: ConfluenceConfig): Record<string, string> {
  return {
    base_url: c.baseUrl,
    token: c.token,
    ...(c.authEmail !== null ? { email: c.authEmail } : {}),
  };
}

/**
 * A {@link ConfluenceVaultReader} that resolves the Confluence creds DB > env > Vault > disabled at each
 * read, returning the record the token provider expects. The Vault tier is built LAZILY (only if DB + env
 * both miss), so an openshift-no-Vault pod configured via UI/env never constructs VaultHttpPort. Throws
 * (fail-closed) when no source has creds — the token provider treats a startup throw as fatal (the feature
 * is unconfigured) and a refresh throw as fail-open (keeps the cached token).
 */
export function makeResolvingConfluenceReader(): ConfluenceVaultReader {
  return {
    kvRead: async (): Promise<Record<string, string>> => {
      const resolved = await resolveLayered<ConfluenceConfig>(
        [
          { source: "db", load: confluenceConfigFromDb },
          { source: "env", load: () => Promise.resolve(confluenceConfigFromEnv((n) => process.env[n])) },
          {
            source: "vault",
            load: async () => confluenceConfigFromVaultData(await VaultHttpPort.fromEnv().kvRead({ path: VAULT_KV_PATH })),
          },
        ],
        // A tier outage (e.g. a transient core-DB error) falls through to the next tier (review P1).
        (source, err) => {
          // eslint-disable-next-line no-console
          console.warn(
            `confluence config: the '${source}' tier failed (${err instanceof Error ? err.message : String(err)}) — falling through`,
          );
        },
      );
      if (resolved === null) {
        throw new Error(
          `Confluence not configured: no UI/DB settings, no CODEMASTER_CONFLUENCE_BASE_URL/_TOKEN env, ` +
            `and no Vault secret at ${VAULT_KV_PATH} (base_url + token).`,
        );
      }
      return toSecretRecord(resolved.value);
    },
  };
}
