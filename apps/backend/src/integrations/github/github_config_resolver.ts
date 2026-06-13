// Runtime GitHub App config resolution (go-live Step 4b / review P0-C). The token-mint CREDS (app_id +
// private_key_pem) and the WEBHOOK secret each resolve DB (UI) > env > Vault > disabled — the first
// non-null tier wins — so a UI-saved GitHub App (stored field-codec-encrypted in core.github_app_settings)
// actually takes effect at runtime, not just at GET. Creds + webhook are resolved SEPARATELY (the token
// provider never needed the webhook secret; bundling them would over-strictly reject a creds-only Vault
// secret). Absence degrades only GitHub (no PR reviews / no webhook verification), never boot.

import { resolveLayered } from "#backend/config/layered_config.js";

export type GitHubCreds = {
  readonly appId: string;
  readonly privateKeyPem: string;
};

type Layered<T> = {
  readonly fromDb: () => Promise<T | null>;
  readonly fromEnv: () => T | null;
  readonly fromVault: () => Promise<T | null>;
};

async function resolve<T>(s: Layered<T>): Promise<{ value: T; source: string } | null> {
  return resolveLayered<T>(
    [
      { source: "db", load: s.fromDb },
      { source: "env", load: () => Promise.resolve(s.fromEnv()) },
      { source: "vault", load: s.fromVault },
    ],
    // A tier outage (e.g. a transient core-DB error) falls through to the next tier (review P1) — surface
    // it so a degraded resolution isn't silent.
    (source, err) => {
      // eslint-disable-next-line no-console
      console.warn(
        `github config: the '${source}' tier failed (${err instanceof Error ? err.message : String(err)}) — falling through to the next tier`,
      );
    },
  );
}

/** Resolve the GitHub App token-mint creds DB > env > Vault > disabled; reports the winning source. */
export async function resolveGitHubCreds(
  sources: Layered<GitHubCreds>,
): Promise<{ value: GitHubCreds; source: string } | null> {
  return resolve(sources);
}

/** Resolve the GitHub webhook HMAC secret DB > env > Vault > disabled; reports the winning source. */
export async function resolveGitHubWebhookSecret(
  sources: Layered<string>,
): Promise<{ value: string; source: string } | null> {
  return resolve(sources);
}

/** env-tier creds: CODEMASTER_GITHUB_APP_ID + _PRIVATE_KEY_PEM, or null unless BOTH are set. */
export function gitHubCredsFromEnv(env: (name: string) => string | undefined): GitHubCreds | null {
  const appId = env("CODEMASTER_GITHUB_APP_ID");
  const privateKeyPem = env("CODEMASTER_GITHUB_PRIVATE_KEY_PEM");
  if (!appId || !privateKeyPem) {
    return null;
  }
  return { appId, privateKeyPem };
}

/** Map a Vault KV record (codemaster/github/app) to creds, or null when a key is missing. */
export function gitHubCredsFromVaultData(data: Record<string, string>): GitHubCreds | null {
  const appId = data["app_id"];
  const privateKeyPem = data["private_key_pem"];
  if (!appId || !privateKeyPem) {
    return null;
  }
  return { appId, privateKeyPem };
}

/** env-tier webhook secret: CODEMASTER_GITHUB_WEBHOOK_SECRET, or null when unset/empty. */
export function gitHubWebhookSecretFromEnv(env: (name: string) => string | undefined): string | null {
  const secret = env("CODEMASTER_GITHUB_WEBHOOK_SECRET");
  return secret === undefined || secret === "" ? null : secret;
}

/** Extract the webhook secret from a Vault KV record (codemaster/github/app), or null when absent. */
export function gitHubWebhookSecretFromVaultData(data: Record<string, string>): string | null {
  const secret = data["webhook_secret"];
  return secret === undefined || secret === "" ? null : secret;
}
