// Standalone deploy-contract preflight (NO HTTP server). Runs the SAME assertDeployReady the boot
// path runs, prints the remediation list, and exits 0 (ready) / 1 (unmet) — so an operator can
// validate secrets + DB extensions/schemas + config BEFORE rolling the app (a Helm test / pre-deploy
// gate). In the image: `node apps/backend/src/deploy_check.js` (override the deployment command,
// same pattern as the migrate Job).

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { assertDeployReady, assertPartitionRunwaysHealthy, DeployContractError } from "#backend/deploy_preflight.js";
import { makeObserveDeps, makeRunwayObserveDeps } from "#backend/deploy_preflight_io.js";

async function main(): Promise<void> {
  const dsn = process.env["CODEMASTER_PG_CORE_DSN"];
  if (dsn === undefined || dsn === "") {
    console.error(
      "deploy-check: CODEMASTER_PG_CORE_DSN is not set — cannot reach the database to check extensions/schemas.",
    );
    process.exit(1);
  }

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: dsn }) }),
  });
  try {
    await assertDeployReady(makeObserveDeps({ db }));
    // F1 (P0-1): registered pg_partman parents must have runway ahead — a stalled run_maintenance is
    // caught here (operator/CI), not silently at the partition cliff. NOT in the boot path (no crashloop).
    await assertPartitionRunwaysHealthy(makeRunwayObserveDeps({ db }));
    console.info(
      "✓ deploy preflight passed — secrets, extensions, schemas, config, and partition runways all healthy.",
    );
  } finally {
    await db.destroy();
  }
}

main().then(
  () => {
    process.exit(0);
  },
  (err: unknown) => {
    // DeployContractError already carries the full, operator-actionable remediation list.
    console.error(
      err instanceof DeployContractError
        ? err.message
        : `deploy-check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  },
);
