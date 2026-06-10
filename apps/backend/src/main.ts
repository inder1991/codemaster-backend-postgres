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
// WHICH tasks boot is the PURE resolveBootTasks seam (boot_tasks.ts — Phase 4d review blocker #6):
// CODEMASTER_RUN_BACKGROUND_RUNNER unset/false (DEFAULT) → the two Temporal workers, byte-identical to the
// pre-flag boot. true → the Postgres background runner (runner + scheduler + outbox-drain loops) JOINS the
// Promise.all. ⚠️ The flag MUST stay OFF while the Temporal worker (with its Temporal Schedules) is also
// booted here — both fire the SAME crons, so booting both double-runs them; it flips ON only at the Phase-4
// cutover when the Temporal worker is removed from this boot. The runner's thunk dynamic-imports its module
// graph, so the flag-OFF boot loads NOTHING of the Postgres runtime (the deferred-import idiom from
// background_runner_main.ts's makeRealTemporalPort).

import { resolveBootTasks } from "#backend/boot_tasks.js";
import { runServer } from "#backend/api/server.js";
import { runWorker } from "#backend/worker/main.js";
import { runOutboxDispatcherWorker } from "#backend/worker/outbox_dispatcher_main.js";

async function main(): Promise<void> {
  // Resolve the boot composition BEFORE any I/O — a garbage CODEMASTER_RUN_BACKGROUND_RUNNER value
  // refuses boot here (fail-loud), before the HTTP server ever binds.
  const tasks = resolveBootTasks(process.env, {
    runWorker,
    runOutboxDispatcherWorker,
    runBackgroundRunner: async () => {
      const { runBackgroundRunner } = await import("#backend/runner/background_runner_main.js");
      await runBackgroundRunner();
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
