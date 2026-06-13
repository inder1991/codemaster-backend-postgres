// Composition seam for vault-mode: build the `readVaultKv` the bootstrap resolvers consume, wiring
// the Step-2 VaultK8sAuth (SA login) + KV reader over real fetch + the SA-token file. The HTTP/token
// IO is injectable for tests; production uses fetch + the projected SA token. In openshift mode this
// reader is never called — but if it is (misconfig), it fails loud (VAULT_ADDR unset).

import { readFile } from "node:fs/promises";

import { VaultK8sAuth } from "#backend/adapters/vault_k8s_auth.js";
import { makeVaultKvReader } from "#backend/adapters/vault_kv_reader.js";

const DEFAULT_SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";

export type VaultReaderFactoryDeps = {
  readonly env: Record<string, string | undefined>;
  /** ms-clock from the platform WallClock (`() => clock.now().getTime()`). */
  readonly now: () => number;
  readonly readSaToken?: () => Promise<string>;
  readonly httpPostJson?: (url: string, body: unknown) => Promise<{ status: number; body: unknown }>;
  readonly httpGetJson?: (url: string, token: string) => Promise<{ status: number; body: unknown }>;
};

async function fetchPostJson(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function fetchGetJson(url: string, token: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(url, { headers: { "X-Vault-Token": token } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** Build `readVaultKv(path) → Record<string,string>` for vault mode (SA login + KV-v2 read). */
export function makeReadVaultKv(
  deps: VaultReaderFactoryDeps,
): (path: string) => Promise<Record<string, string>> {
  const { env } = deps;
  const addr = env["VAULT_ADDR"];
  if (addr === undefined || addr === "") {
    return () =>
      Promise.reject(
        new Error("vault secret source selected but VAULT_ADDR is not set — set it or use CODEMASTER_SECRET_SOURCE=openshift"),
      );
  }

  const saTokenPath = env["CODEMASTER_VAULT_SA_TOKEN_PATH"] ?? DEFAULT_SA_TOKEN_PATH;
  const authPath = env["CODEMASTER_VAULT_K8S_AUTH_PATH"];
  const auth = new VaultK8sAuth({
    addr,
    role: env["CODEMASTER_VAULT_K8S_ROLE"] ?? "codemaster",
    readToken: deps.readSaToken ?? (async () => (await readFile(saTokenPath, "utf-8")).trim()),
    httpPostJson: deps.httpPostJson ?? fetchPostJson,
    now: deps.now,
    ...(authPath === undefined || authPath === "" ? {} : { authPath }),
  });

  return makeVaultKvReader({
    addr,
    mount: env["CODEMASTER_VAULT_KV_MOUNT"] ?? "secret",
    auth,
    httpGetJson: deps.httpGetJson ?? fetchGetJson,
  });
}
