// Canonical combined entrypoint — the HTTP API + the Postgres background runtime run in ONE
// process/pod (the production deployment shape for the TS backend). The runner is replica-safe: the
// outbox drain + scheduler use FOR UPDATE SKIP LOCKED leasing, so extra replicas partition the work.
//
// FAIL-LOUD: the HTTP API listen happens first, then the resolved boot task runs (it blocks for the
// process lifetime). If it rejects — at startup OR a runtime crash — the process exits non-zero so
// Kubernetes restarts the pod and the fault is visible to alerting. No silently-degraded pod.
//
// WHICH task boots is the PURE resolveBootTasks seam (boot_tasks.ts): CODEMASTER_RUNTIME_MODE
// unset/"postgres" (DEFAULT) → the Postgres background runner (runner + scheduler + outbox-drain
// loops); "shadow" → the same runner in observe-only mode; "temporal" is REFUSED (the Temporal
// runtime was torn out). The runner's thunk dynamic-imports its module graph, so the entrypoint
// stays lean. (loop_health.ts is deliberately importable here: a leaf with zero runtime imports.)
//
// PROBES (CS3.2; audit C5/H7/XH11/RT2): this composition root wires the REAL dependency checks into
// /readyz — pre-CS3.2 runServer() got NO checks, so /readyz was permanently ready and a pod with a
// dead DB / sealed Vault / crashed loop kept receiving traffic forever. Composition:
//   * postgres  — a cheap SELECT 1 over THE shared ADR-0062 pool; wired when the core DSN is set.
//   * vault     — the unauthenticated GET /v1/sys/health probe; wired when VAULT_ADDR is set.
//   * runtime-loops — the SHARED LoopHealthRegistry (CS3.1), created HERE and threaded BOTH into
//     runBackgroundRunner (whose runSupervisedLoops feeds it) AND into /readyz.
// /healthz takes NO dependency checks — liveness is wedge-only (app.ts); a TOTAL loop loss needs no
// wedge signal because runBackgroundRunner re-throws and the fail-loud handler below exits the
// process, so the platform restarts the pod.

import { runServer, type RunServerDeps } from "#backend/api/server.js";
import {
  makePostgresCheck,
  makeRuntimeLoopsCheck,
  makeVaultCheck,
} from "#backend/api/dependency_checks.js";
import { FetchVaultHttpClient } from "#backend/adapters/vault_http.js";
import { parseRuntimeMode, resolveBootTasks } from "#backend/boot_tasks.js";
import { LoopHealthRegistry } from "#backend/runner/loop_health.js";

import { WallClock } from "#platform/clock.js";
import { getPool } from "#platform/db/database.js";

async function main(): Promise<void> {
  // Resolve the boot composition BEFORE any I/O — a garbage/temporal CODEMASTER_RUNTIME_MODE value
  // (or a still-set removed cutover boolean) refuses boot here (fail-loud), before the HTTP bind.
  // (parseRuntimeMode is pure; resolveBootTasks re-parses the same env below — one source of truth.)
  parseRuntimeMode(process.env);
  const clock = new WallClock();

  // CS3.2: ONE shared LoopHealthRegistry per pod — the SAME instance runSupervisedLoops feeds
  // (crash → markDown) and /readyz queries (the 'runtime-loops' check below). Before the runner
  // registers its supervised set the registry is empty → vacuously ready (required-ness is DECLARED
  // by register(), never assumed), so the boot window cannot wedge readiness.
  const loopHealth = new LoopHealthRegistry({ clock });

  const tasks = resolveBootTasks(process.env, {
    runBackgroundRunner: async (runnerMode) => {
      const { runBackgroundRunner } = await import("#backend/runner/background_runner_main.js");
      await runBackgroundRunner(runnerMode, { loopHealth });
    },
  });

  // Resolve the DB DSN from the selected bootstrap-secret source (CODEMASTER_SECRET_SOURCE:
  // openshift env | vault SA-read) and publish it to the env, so every downstream reader (the shared
  // pool, the preflight, the runner) sees ONE resolved value. The DB is the hard boot requirement —
  // a resolution failure (no creds in the chosen source) propagates to the fail-loud exit handler.
  {
    const { resolveDbDsn } = await import("#backend/config/db_credentials.js");
    const { makeReadVaultKv } = await import("#backend/config/vault_reader_factory.js");
    process.env["CODEMASTER_PG_CORE_DSN"] = await resolveDbDsn({
      env: process.env,
      readVaultKv: makeReadVaultKv({ env: process.env, now: () => clock.now().getTime() }),
    });
  }

  // CS3.2 readiness deps (each wired only when its target exists in this pod's env — never fail
  // readiness on a dependency this pod does not have by design).
  const dsn = process.env["CODEMASTER_PG_CORE_DSN"];
  const vaultAddr = process.env["VAULT_ADDR"];
  const serverDeps: RunServerDeps = {
    ...(dsn !== undefined && dsn !== ""
      ? { postgresCheck: makePostgresCheck({ pool: getPool(dsn), clock }) }
      : {}),
    ...(vaultAddr !== undefined && vaultAddr !== ""
      ? { vaultCheck: makeVaultCheck({ addr: vaultAddr, http: new FetchVaultHttpClient(), clock }) }
      : {}),
    dependencyChecks: [makeRuntimeLoopsCheck({ loopHealth })],
  };

  // CS5: schema-revision preflight — BEFORE the HTTP bind and BEFORE the runner starts a loop. A DB
  // behind (or diverged from) the image's compiled-in migration sequence rejects here → the
  // fail-loud handler below exits 1; the pod never serves traffic or claims jobs against a schema it
  // was not built for (XH7's silent-drift class). A DSN-less boot has no DB to preflight.
  if (dsn !== undefined && dsn !== "") {
    const { Kysely, PostgresDialect } = await import("kysely");
    const { assertSchemaRevision } = await import("#backend/schema_preflight.js");
    const { assertDeployReady } = await import("#backend/deploy_preflight.js");
    const { makeObserveDeps } = await import("#backend/deploy_preflight_io.js");
    // A Kysely facade over the SHARED ADR-0062 pool — never destroyed here (destroy would end the
    // pool the API + runner share for the process lifetime).
    const db = new Kysely({ dialect: new PostgresDialect({ pool: getPool(dsn) }) });
    // Turnkey deploy-contract preflight FIRST: validates required secrets + DB extensions/schemas +
    // config, throwing a single remediation list (each with its fix) before serving — so a
    // misconfigured first deploy gets root-cause messages, not a Ready-but-dead pod. Then the exact
    // migration-sequence pin.
    await assertDeployReady(makeObserveDeps({ db }));
    await assertSchemaRevision(db);
  }

  // Go-live P0-A: install the field-encryption key registry source-aware (openshift → the
  // CODEMASTER_FIELD_ENCRYPTION_KEYSET env var; vault → Vault) ONCE, BEFORE the HTTP bind — so admin /
  // encrypted-config paths never observe a null registry (the runner installs it again later as a boot
  // task; this closes that window) and openshift-no-Vault boots with no Vault round-trip. Idempotent;
  // "skipped" in dev/test with no source. Fail-loud: a bad keyset throws here, before serving.
  {
    const { installFieldKeyRegistryAtBoot } = await import("#backend/security/boot_field_keys.js");
    await installFieldKeyRegistryAtBoot(process.env);
  }

  // HTTP API first — app.listen() returns once bound; the server keeps serving on the event loop.
  await runServer(serverDeps);
  console.info(
    `combined backend boot: tasks=[${tasks.map((t) => t.name).join(", ")}] ` +
      `readyz_checks=[${[
        ...("postgresCheck" in serverDeps ? ["postgres"] : []),
        ...("vaultCheck" in serverDeps ? ["vault"] : []),
        "runtime-loops",
      ].join(", ")}]`,
  );
  // The resolved task blocks for the process lifetime; Promise.all rejects the moment it rejects,
  // propagating to the fail-loud handler below.
  await Promise.all(tasks.map((t) => t.run()));
}

main().catch((err: unknown) => {
  console.error("[FATAL] combined backend entrypoint failed:", err);
  process.exit(1);
});
