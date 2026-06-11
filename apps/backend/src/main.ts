// Canonical combined entrypoint — the HTTP API + ALL Temporal workers run in ONE process/pod. This is the
// production deployment shape for the TS backend (a deliberate architecture decision; it diverges from the
// Python split into separate api / worker-* deployments). Replica-safe: the outbox-dispatcher singleton is
// enforced at the Temporal workflow level (fixed workflowId + USE_EXISTING conflict policy), so every
// replica's poller is safe to run.
//
// FAIL-LOUD: the HTTP API listen happens first, then ALL resolved boot tasks run concurrently (each blocks
// for the process lifetime). If ANY of them rejects — at startup OR a runtime crash — the process exits
// non-zero so Kubernetes restarts the pod and the fault is visible to alerting. No silently-degraded pod.
// (Matches every sibling entrypoint's `.catch(() => process.exit(1))` convention.)
//
// WHICH tasks boot is the PURE resolveBootTasks seam (boot_tasks.ts — Phase 4d review blocker #6,
// reshaped by CS1.1): CODEMASTER_RUNTIME_MODE unset/"temporal" (DEFAULT) → the two Temporal workers,
// byte-identical to the pre-mode boot; "postgres"/"shadow" → ONLY the Postgres background runner (runner +
// scheduler + outbox-drain loops), with the mode threaded through so the runner knows whether it shadows.
// The two runtimes are MUTUALLY EXCLUSIVE BY CONSTRUCTION — no mode boots both (the old two-boolean shape
// allowed exactly that: both runtimes fire the SAME crons and drain the SAME outbox, so the joined boot
// double-ran every cron — audit C7/C9/RC8/C8/RT1). The runner's thunk dynamic-imports its module graph, so
// the temporal-mode boot loads NOTHING of the Postgres runtime.

import { resolveBootTasks } from "#backend/boot_tasks.js";
import { runServer } from "#backend/api/server.js";
import { runWorker } from "#backend/worker/main.js";
import { runOutboxDispatcherWorker } from "#backend/worker/outbox_dispatcher_main.js";

async function main(): Promise<void> {
  // Resolve the boot composition BEFORE any I/O — a garbage CODEMASTER_RUNTIME_MODE value (or a
  // still-set removed cutover boolean) refuses boot here (fail-loud), before the HTTP server binds.
  const tasks = resolveBootTasks(process.env, {
    runWorker,
    runOutboxDispatcherWorker,
    runBackgroundRunner: async (mode) => {
      const { runBackgroundRunner } = await import("#backend/runner/background_runner_main.js");
      await runBackgroundRunner(mode);
    },
  });
  // HTTP API first — app.listen() returns once bound; the server keeps serving on the event loop.
  await runServer();
  console.info(`combined backend boot: tasks=[${tasks.map((t) => t.name).join(", ")}]`);
  // Every resolved task blocks for the process lifetime; run them concurrently. Promise.all rejects
  // the moment ANY rejects, propagating to the fail-loud handler below.
  await Promise.all(tasks.map((t) => t.run()));
}

main().catch((err: unknown) => {
  console.error("[FATAL] combined backend entrypoint failed:", err);
  process.exit(1);
});
