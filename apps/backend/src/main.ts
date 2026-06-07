// Canonical combined entrypoint — the HTTP API + ALL Temporal workers run in ONE process/pod. This is the
// production deployment shape for the TS backend (a deliberate architecture decision; it diverges from the
// Python split into separate api / worker-* deployments). Replica-safe: the outbox-dispatcher singleton is
// enforced at the Temporal workflow level (fixed workflowId + USE_EXISTING conflict policy), so every
// replica's poller is safe to run.
//
// FAIL-LOUD: the HTTP API listen happens first, then BOTH workers run concurrently (each blocks in
// worker.run()). If ANY of them rejects — at startup OR a runtime crash — the process exits non-zero so
// Kubernetes restarts the pod and the fault is visible to alerting. No silently-degraded pod. (Matches every
// sibling entrypoint's `.catch(() => process.exit(1))` convention.)

import { runServer } from "#backend/api/server.js";
import { runWorker } from "#backend/worker/main.js";
import { runOutboxDispatcherWorker } from "#backend/worker/outbox_dispatcher_main.js";

async function main(): Promise<void> {
  // HTTP API first — app.listen() returns once bound; the server keeps serving on the event loop.
  await runServer();
  // Review worker + outbox dispatcher each block in worker.run(); run them concurrently. Promise.all rejects
  // the moment EITHER rejects, propagating to the fail-loud handler below.
  await Promise.all([runWorker(), runOutboxDispatcherWorker()]);
}

main().catch((err: unknown) => {
  console.error("[FATAL] combined backend entrypoint failed:", err);
  process.exit(1);
});
