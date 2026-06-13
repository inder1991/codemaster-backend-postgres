// VaultWebhookSecretProvider — reads the GitHub App webhook secret from Vault path `codemaster/github/app`
// key `webhook_secret` on
// EVERY call (no in-process cache — the secret rotates rarely, HMAC verification is once per request, and
// the Vault round-trip is sub-ms same-cluster; add a cache only if telemetry shows a hot path).

import { FileKvReader } from "#backend/adapters/vault_file_kv.js";
import { VaultHttpPort } from "#backend/adapters/vault_http.js";
import { PostgresGitHubAppSettingsRepo } from "#backend/integrations/github/github_app_settings_repo.js";
import {
  gitHubWebhookSecretFromEnv,
  resolveGitHubWebhookSecret,
} from "#backend/integrations/github/github_config_resolver.js";
import { getAuditKeyRegistry } from "#backend/security/audit_field_codec.js";

import type { WebhookSecretProvider } from "#backend/api/github_webhook_routes.js";

const VAULT_PATH = "codemaster/github/app";
const KEY = "webhook_secret";

/** The narrow Vault read surface the provider needs (Python `_VaultReadPort` Protocol). Both
 *  {@link VaultHttpPort} and the in-memory test vault satisfy it via their `kvRead`. */
export type VaultKvReadPort = {
  kvRead(args: { path: string; version?: number }): Promise<Record<string, string>>;
};

/** Reads + UTF-8-encodes the GitHub webhook secret from Vault. */
export class VaultWebhookSecretProvider implements WebhookSecretProvider {
  readonly #vault: VaultKvReadPort;

  public constructor(args: { vault: VaultKvReadPort }) {
    this.#vault = args.vault;
  }

  public async currentSecret(): Promise<Uint8Array> {
    const data = await this.#vault.kvRead({ path: VAULT_PATH });
    const secret = data[KEY];
    if (secret === undefined) {
      throw new Error(
        `Vault path '${VAULT_PATH}' missing key '${KEY}'; rerun helm/local-kind/seed-vault.sh`,
      );
    }
    return new TextEncoder().encode(secret);
  }
}

/**
 * A {@link WebhookSecretProvider} that lazily builds the real {@link VaultHttpPort} on first use (the
 * deferred-Vault pattern) and memoizes it — so the HTTP server boots without `VAULT_ADDR` and only the
 * FIRST webhook needs Vault reachable.
 */
export function makeLazyVaultWebhookSecretProvider(): WebhookSecretProvider {
  let provider: VaultWebhookSecretProvider | undefined;
  return {
    currentSecret: async () => {
      if (provider === undefined) {
        provider = new VaultWebhookSecretProvider({ vault: VaultHttpPort.fromEnv() });
      }
      return provider.currentSecret();
    },
  };
}

/** DB tier of the webhook-secret resolver (review P0-C): the UI-saved platform row's webhook secret
 *  (field-codec decrypted via the boot-installed registry), or null when no DSN/registry/enabled row. */
async function readWebhookSecretFromDb(): Promise<string | null> {
  const dsn = process.env["CODEMASTER_PG_CORE_DSN"];
  const registry = getAuditKeyRegistry();
  if (dsn === undefined || dsn === "" || registry === null) {
    return null;
  }
  const settings = await PostgresGitHubAppSettingsRepo.fromDsn({ dsn, registry }).read();
  return settings === null ? null : settings.webhookSecret;
}

/**
 * Resolves the webhook secret DB (UI) > env > Vault > disabled (review P0-C) — so a UI-saved webhook
 * secret is actually USED for HMAC verification, not just stored. The Vault tier is the existing
 * lazy/agent-file provider (only consulted if DB + env both miss), so openshift configured via UI/env
 * never touches Vault. Throws (fail-closed) when no source has a secret — an unverifiable webhook.
 */
export class ResolvingWebhookSecretProvider implements WebhookSecretProvider {
  readonly #vaultTier: WebhookSecretProvider;

  public constructor(args: { vaultTier: WebhookSecretProvider }) {
    this.#vaultTier = args.vaultTier;
  }

  public async currentSecret(): Promise<Uint8Array> {
    const resolved = await resolveGitHubWebhookSecret({
      fromDb: () => readWebhookSecretFromDb(),
      fromEnv: () => gitHubWebhookSecretFromEnv((n) => process.env[n]),
      fromVault: async () => new TextDecoder("utf-8").decode(await this.#vaultTier.currentSecret()),
    });
    if (resolved === null) {
      throw new Error(
        "GitHub webhook secret not configured: no UI/DB settings, no CODEMASTER_GITHUB_WEBHOOK_SECRET env, " +
          "and no Vault secret at codemaster/github/app (webhook_secret).",
      );
    }
    return new TextEncoder().encode(resolved.value);
  }
}

/**
 * Build the webhook-secret provider: DB (UI) > env > Vault > disabled (review P0-C). The Vault tier
 * honours the ADR-0071 selector — `CODEMASTER_VAULT_SECRET_SOURCE=agent-file` reads the Vault-Agent file,
 * else the lazy Vault HTTP provider. The DB + env tiers short-circuit ahead of it, so a UI/env-configured
 * deploy boots + verifies without touching Vault.
 */
export function makeWebhookSecretProvider(): WebhookSecretProvider {
  const source = process.env["CODEMASTER_VAULT_SECRET_SOURCE"] ?? "vault-api";
  const vaultTier =
    source === "agent-file"
      ? new VaultWebhookSecretProvider({ vault: new FileKvReader() })
      : makeLazyVaultWebhookSecretProvider();
  return new ResolvingWebhookSecretProvider({ vaultTier });
}
