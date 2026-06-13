// Print the resolved Postgres DSN to stdout — for the migrate Job's pre-step in vault mode, where
// node-pg-migrate needs CODEMASTER_PG_CORE_DSN in env but the creds live in Vault. The Job runs e.g.
//   export CODEMASTER_PG_CORE_DSN="$(node apps/backend/src/resolve_dsn.js)"; npm run migrate:up
// In openshift mode it just echoes back the env DSN (or the assembled one). No other output on stdout.

import { resolveDbDsn } from "#backend/config/db_credentials.js";
import { makeReadVaultKv } from "#backend/config/vault_reader_factory.js";

import { WallClock } from "#platform/clock.js";

const clock = new WallClock();

resolveDbDsn({
  env: process.env,
  readVaultKv: makeReadVaultKv({ env: process.env, now: () => clock.now().getTime() }),
}).then(
  (dsn) => {
    process.stdout.write(dsn);
    process.exit(0);
  },
  (err: unknown) => {
    console.error(`resolve_dsn: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
