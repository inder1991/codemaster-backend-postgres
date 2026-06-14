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
import { DisposableRegistry } from "#backend/runner/disposables.js";
import { LoopHealthRegistry } from "#backend/runner/loop_health.js";

import { WallClock } from "#platform/clock.js";
import { disposeAllPools, getPool } from "#platform/db/database.js";
import { transportAbortSignal } from "#platform/transport_timeout.js";

/** F16 / P2-20: race a boot step against a hard deadline. Vault's per-leg retries can compose into a
 *  ~40-60s SILENT boot stall before fail-loud; this bounds that to one interval. Uses the sanctioned
 *  transportAbortSignal timer (the clock/random gate forbids a raw setTimeout outside clock.ts). */
const BOOT_FIELD_KEY_DEADLINE_MS = 30_000;
async function withBootDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  const signal = transportAbortSignal(ms);
  const deadline = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(new Error(`boot deadline: ${what} exceeded ${ms}ms`));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
  return Promise.race([p, deadline]);
}

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
      // disposeSharedPool:false — main.ts owns the shared pool's lifecycle (disposed LAST, below), so
      // the runner must NOT end it mid-shutdown while the API is still draining (F2 / P0-3).
      // wireFieldKeyRefresh:false — main.ts owns the field-key refresh loop (F16 / P2-19); the runner
      // must NOT start a second loop.
      await runBackgroundRunner(runnerMode, {
        loopHealth,
        disposeSharedPool: false,
        wireFieldKeyRefresh: false,
      });
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
  // F16 / P2-19: the composition root owns the field-key REFRESH loop (not just the install) — so the API
  // / auth path's registry is refreshed across a Vault key rotation independent of the runner task reaching
  // its own wireFieldKeyRefreshLoop (a delayed/crashed runner boot would otherwise leave it stale). The
  // runner is told (wireFieldKeyRefresh:false in the boot-task thunk) NOT to start a SECOND loop.
  const rootDisposables = new DisposableRegistry();
  {
    const { installFieldKeyRegistryAtBoot } = await import("#backend/security/boot_field_keys.js");
    const { wireFieldKeyRefreshLoop } = await import("#backend/runner/background_runner_main.js");
    // P2-20: bound the install so a stalled Vault fails loud within a deadline, not a long silent hang.
    const installResult = await withBootDeadline(
      installFieldKeyRegistryAtBoot(process.env),
      BOOT_FIELD_KEY_DEADLINE_MS,
      "field-encryption key registry install",
    );
    wireFieldKeyRefreshLoop({ installResult, env: process.env, clock, disposables: rootDisposables });
  }

  // HTTP API first — app.listen() returns once bound; the server keeps serving on the event loop.
  const server = await runServer(serverDeps);
  console.info(
    `combined backend boot: tasks=[${tasks.map((t) => t.name).join(", ")}] ` +
      `readyz_checks=[${[
        ...("postgresCheck" in serverDeps ? ["postgres"] : []),
        ...("vaultCheck" in serverDeps ? ["vault"] : []),
        "runtime-loops",
      ].join(", ")}]`,
  );

  // F2 / P0-3: main.ts is the SINGLE shutdown owner for the combined pod. On SIGTERM/SIGINT it closes
  // the HTTP server (stop accepting connections + drain in-flight) — memoized so repeat signals share
  // one close. The runner registers its OWN signal handler that drains its loops, so Promise.all below
  // resolves; the pool (shared by API + runner) is disposed LAST, in the finally, once both have
  // drained. Pre-fix: nothing closed the server, so the event loop never emptied and the process hung
  // until SIGKILL — while the runner had already disposed the shared pool out from under the live API.
  let closePromise: Promise<void> | undefined;
  const closeServer = (): Promise<void> => (closePromise ??= server.close());
  process.once("SIGTERM", () => void closeServer().catch((e: unknown) => console.error("server close failed:", e)));
  process.once("SIGINT", () => void closeServer().catch((e: unknown) => console.error("server close failed:", e)));

  try {
    // The resolved task blocks for the process lifetime; Promise.all rejects the moment it rejects,
    // propagating to the fail-loud handler below.
    await Promise.all(tasks.map((t) => t.run()));
  } finally {
    // Stop accepting HTTP (idempotent), stop the field-key refresh loop (F16/P2-19), THEN dispose the
    // shared pool last — so in-flight HTTP + the draining runner both complete against a live pool.
    await closeServer().catch((e: unknown) => console.error("server close failed:", e));
    await rootDisposables.disposeAll();
    await disposeAllPools();
  }
}

main().catch((err: unknown) => {
  console.error("[FATAL] combined backend entrypoint failed:", err);
  process.exit(1);
});
