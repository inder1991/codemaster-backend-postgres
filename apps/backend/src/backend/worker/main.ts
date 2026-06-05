/**
 * Worker bootstrap — the Phase-2.0 Temporal-TS walking-skeleton worker. Brings up a single Temporal
 * Worker that registers the ONE skeleton activity ({@link activities}) and serves the ONE skeleton
 * workflow (`review_skeleton.workflow`), wired with the custom payload converter (`data_converter`).
 *
 * This is the foundational worker pattern Phase 2.1+ reuses: NativeConnection → Worker.create (with
 * workflowsPath + activities + dataConverter) → worker.run.
 *
 * ## Isolation defaults (keep the skeleton OFF the real cluster's path)
 *
 * The defaults deliberately isolate this worker from production review workflows:
 *   - namespace  `dualrun`                 (env `TEMPORAL_NAMESPACE`)
 *   - taskQueue  `review-skeleton-dualrun` (env `TEMPORAL_TASK_QUEUE`)
 *   - address    `localhost:7233`          (env `TEMPORAL_ADDRESS`)
 *   - tls        off unless `TEMPORAL_TLS=1`
 *
 * A dedicated namespace + dedicated task queue means a real worker never polls this queue and this worker
 * never polls a real queue — the skeleton cannot pick up (or be picked up by) live cluster traffic.
 *
 * ## ESM ↔ CJS interop for `require.resolve`
 *
 * The package is `"type": "module"`, so there is NO ambient CommonJS `require` in this module — calling a
 * bare `require.resolve(...)` would be a `ReferenceError`. Temporal's `workflowsPath` and
 * `dataConverter.payloadConverterPath` both want a RESOLVED absolute module path (Temporal loads those
 * files itself — `workflowsPath` is webpack-bundled into the sandbox; `payloadConverterPath` is imported
 * into both threads). We therefore reconstruct `require.resolve` from the ESM entrypoint URL via
 * `createRequire(import.meta.url)` — the canonical Node ESM→CJS bridge — and resolve the two sibling
 * modules relative to THIS file. `createRequire` is bound to this module's URL, so the relative specifiers
 * resolve correctly whether the worker runs from `.ts` (tsx) or compiled `.js` (the resolver honours the
 * package `exports` / extension at runtime).
 */

import { createRequire } from "node:module";

import { NativeConnection, Worker } from "@temporalio/worker";

import { startupSelfCheck } from "../chunking/treesitter_loader.js";
import { buildActivities } from "./registry.js";

/** ESM→CJS bridge: a `require` bound to THIS module's URL, so `require.resolve` works under ESM. */
const require_ = createRequire(import.meta.url);

/**
 * Bring up the skeleton worker and run it until shutdown. Connects a {@link NativeConnection}, creates a
 * {@link Worker} bound to the isolated namespace / task queue with the skeleton workflow + activity + the
 * custom payload converter, then blocks in `worker.run()` (resolves on graceful shutdown / SIGINT-SIGTERM,
 * which the SDK wires by default).
 *
 * `tls` is included in the connection options ONLY when `TEMPORAL_TLS=1` — under `exactOptionalPropertyTypes`
 * an explicit `tls: undefined` is a type error against the optional field, so we build the options object
 * conditionally rather than passing `undefined`.
 */
export async function runWorker(): Promise<void> {
  // Fail LOUD at worker boot if the vendored tree-sitter grammars are missing/corrupt (ADR-0067 cond 3,
  // SHA-256-verified). Without this, a missing .wasm would surface as a degraded review mid-flight (the
  // chunker falling back to hunk-mode) instead of a clear startup failure.
  await startupSelfCheck();

  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const connection = await NativeConnection.connect(
    process.env.TEMPORAL_TLS === "1" ? { address, tls: {} } : { address },
  );

  // Build the full review-pipeline activity surface via the composition root (real collaborators, every
  // activity curried/bound to a 1-arg Temporal activity, the ADR-0068 ledger wired into the LlmClientCache).
  // Constructed HERE (not at module load) so the env reads `buildActivities()` performs happen with the
  // worker's populated environment.
  const activities = buildActivities();

  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "dualrun",
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "review-skeleton-dualrun",
    workflowsPath: require_.resolve("../workflows/review_skeleton.workflow"),
    activities,
    dataConverter: { payloadConverterPath: require_.resolve("./data_converter") },
  });

  await worker.run();
}

// Main-module entrypoint guard: when this file is executed directly (not imported), run the worker and
// fail loudly on any startup error. `process.argv[1]` is the entrypoint path; comparing the file:// URL
// of THIS module to it is the ESM analogue of `if __name__ == "__main__":`.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runWorker().catch((err: unknown) => {
    process.stderr.write(`[ERROR] review-skeleton worker failed: ${String(err)}\n`);
    process.exit(1);
  });
}
