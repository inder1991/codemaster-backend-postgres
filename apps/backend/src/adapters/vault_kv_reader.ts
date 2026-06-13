// Read a Vault KV-v2 path → its string map, authenticating with a {@link VaultK8sAuth}-style token
// provider. On a 403 (token expired/revoked) it invalidates + retries once with a fresh login. This
// is the `readVaultKv` the bootstrap-secret resolvers (DB creds, field key) consume in vault mode.

/** The token-provider contract (satisfied by VaultK8sAuth). */
export type TokenProvider = {
  token(): Promise<string>;
  invalidate(): void;
};

export type VaultKvReaderDeps = {
  readonly addr: string;
  /** KV-v2 mount (the `secret/` in `secret/data/...`). */
  readonly mount: string;
  readonly auth: TokenProvider;
  /** GET JSON from Vault with `X-Vault-Token`; returns the HTTP status + parsed body. */
  readonly httpGetJson: (url: string, token: string) => Promise<{ status: number; body: unknown }>;
};

/** KV-v2 read shape: `{ data: { data: { <key>: <value> } } }`. */
type KvV2Body = { data?: { data?: unknown } };

/** Build `readVaultKv(path) → Record<string,string>` over the KV-v2 API with token auth + 1 retry. */
export function makeVaultKvReader(
  deps: VaultKvReaderDeps,
): (path: string) => Promise<Record<string, string>> {
  const url = (path: string): string => `${deps.addr}/v1/${deps.mount}/data/${path}`;

  return async (path: string): Promise<Record<string, string>> => {
    let res = await deps.httpGetJson(url(path), await deps.auth.token());
    if (res.status === 403) {
      // Token expired/revoked — re-login once and retry.
      deps.auth.invalidate();
      res = await deps.httpGetJson(url(path), await deps.auth.token());
    }
    if (res.status !== 200) {
      throw new Error(
        `Vault KV read failed (HTTP ${res.status}) for path ${deps.mount}/${path} — ` +
          `check the path is seeded and the role's policy grants read on it`,
      );
    }
    const data = (res.body as KvV2Body).data?.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error(`Vault KV read for ${deps.mount}/${path} returned no data object`);
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string") {
        out[k] = v;
      }
    }
    return out;
  };
}
