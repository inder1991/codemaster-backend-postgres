/**
 * Workflow-bundle self-check (ADR-0065) — the build-time proof that the Temporal workflow sandbox bundle
 * is crypto-free, WITHOUT a running Temporal server.
 *
 * `bundleWorkflowCode({ workflowsPath })` runs the SDK's webpack-based bundler over the workflow module
 * and its transitive import graph, compiling them into the V8-isolate bundle. The bundler REFUSES
 * sandbox-illegal Node builtins (`node:crypto` among them) — so if the workflow graph (transitively)
 * imported `node:crypto` (e.g. via the `diff_chunking.v1` / `retrieved_evidence.v1` contracts or any
 * minting helper), bundling FAILS LOUDLY here. A clean exit 0 means the workflow body + everything it
 * pulls in is sandbox-safe: the ADR-0065 crypto boundary holds.
 *
 * This is intentionally a standalone script (run via `npx tsx scripts/check_workflow_bundle.ts`) rather
 * than a `make validate-fast` gate yet — bundling spins up webpack and is heavier than the AST gates.
 * FOLLOW-UP (ADR-0065): promote this to a `scripts/gates/` entry (wired into `run_all.ts`) once Phase 2.1
 * adds more workflows, so every workflow's sandbox-purity is enforced pre-merge.
 *
 * ## ESM `require.resolve`
 *
 * The package is `"type": "module"`; there is no ambient `require`. We reconstruct it via
 * `createRequire(import.meta.url)` (bound to THIS script's URL) and resolve the workflow module relative
 * to `scripts/` → `../apps/backend/src/workflows/...`.
 */

import { createRequire } from "node:module";

import { bundleWorkflowCode } from "@temporalio/worker";

/** ESM→CJS bridge: a `require` bound to THIS script's URL, so `require.resolve` works under ESM. */
const require_ = createRequire(import.meta.url);

/**
 * The workflow modules a PRODUCTION worker actually serves as its `workflowsPath` — NOT the thin spine.
 * Bundling each one webpacks its full transitive import graph into the V8 sandbox bundle and REFUSES
 * sandbox-illegal Node builtins (`node:crypto` among them), so a future sandbox-illegal import ANYWHERE in
 * a served graph fails LOUDLY here rather than at runtime.
 *   - `all_workflows`            — the review worker's bundle (worker/main.ts): `reviewPullRequest` PLUS the
 *     auto-registration + confluence-ingest + retention + liveness workflows, re-exported together.
 *   - `outbox_dispatcher.workflow` — the outbox dispatcher worker's bundle (worker/outbox_dispatcher_main.ts).
 */
const SERVED_WORKFLOW_MODULES: ReadonlyArray<string> = [
  "../apps/backend/src/workflows/all_workflows",
  "../apps/backend/src/workflows/outbox_dispatcher.workflow",
];

/** Bundle every served workflow module; exit 0 on success, non-zero (printing the error) on any failure. */
async function main(): Promise<number> {
  for (const mod of SERVED_WORKFLOW_MODULES) {
    const workflowsPath = require_.resolve(mod);
    try {
      const bundle = await bundleWorkflowCode({ workflowsPath });
      process.stdout.write(
        `[INFO] check_workflow_bundle: OK — ${mod} compiled crypto-free (${bundle.code.length} bytes)\n`,
      );
    } catch (err: unknown) {
      process.stderr.write(
        `[ERROR] check_workflow_bundle: bundling FAILED for ${mod} — the workflow graph imports a ` +
          `sandbox-illegal module (e.g. node:crypto). See ADR-0065.\n${String(err)}\n`,
      );
      return 1;
    }
  }
  return 0;
}

main()
  .then((rc) => {
    process.exit(rc);
  })
  .catch((err: unknown) => {
    process.stderr.write(`[ERROR] check_workflow_bundle: unexpected failure: ${String(err)}\n`);
    process.exit(1);
  });
