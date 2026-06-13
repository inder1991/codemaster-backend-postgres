// IO wrapper for the deploy preflight: builds the real {@link ObserveDeps} from a live DB pool, the
// Vault-Agent secrets dir, and the process environment. Kept apart from deploy_preflight.ts so the
// evaluator + contract stay pure (no kysely / fs imports) and exhaustively unit-testable.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { sql, type Kysely } from "kysely";

import { DEFAULT_VAULT_SECRETS_DIR } from "./adapters/vault_file_kv.js";
import { type ObserveDeps, parseRenderedSecret } from "./deploy_preflight.js";

/**
 * Build the real preflight IO deps. `db` is any Kysely over the core pool; `secretsDir` defaults to
 * the Vault-Agent mount (env override honored); `env` defaults to process.env (injectable for tests).
 */
export function makeObserveDeps(args: {
  db: Kysely<unknown>;
  secretsDir?: string;
  env?: Record<string, string | undefined>;
}): ObserveDeps {
  const env = args.env ?? process.env;
  const secretsDir =
    args.secretsDir ?? env["CODEMASTER_VAULT_SECRETS_DIR"] ?? DEFAULT_VAULT_SECRETS_DIR;

  return {
    env: (name) => env[name],
    readSecretFile: async (fileName) => {
      try {
        return parseRenderedSecret(await readFile(join(secretsDir, fileName), "utf-8"));
      } catch {
        // ENOENT (secret not rendered) or any read error → treat as absent; the validator reports it.
        return null;
      }
    },
    listExtensions: async () => {
      const r = await sql<{ extname: string }>`SELECT extname FROM pg_catalog.pg_extension`.execute(
        args.db,
      );
      return r.rows.map((row) => row.extname);
    },
    listSchemas: async () => {
      const r = await sql<{ nspname: string }>`SELECT nspname FROM pg_catalog.pg_namespace`.execute(
        args.db,
      );
      return r.rows.map((row) => row.nspname);
    },
  };
}
