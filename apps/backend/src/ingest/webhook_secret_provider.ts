// VaultWebhookSecretProvider — 1:1 port of
// vendor/codemaster-py/codemaster/ingest/webhook_secret_provider.py.
//
// Reads the GitHub App webhook secret from Vault path `codemaster/github/app` key `webhook_secret` on
// EVERY call (no in-process cache — the secret rotates rarely, HMAC verification is once per request, and
// the Vault round-trip is sub-ms same-cluster; add a cache only if telemetry shows a hot path).

import { VaultHttpPort } from "#backend/adapters/vault_http.js";

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
