// Source-inspection guard for the auto-registration reconcile/repair workflows + the combined-pod bundle
// barrel (mirrors the OutboxDispatcherWorkflow source-inspection guard pattern). Importing the workflow
// module directly would run its top-level `proxyActivities(...)` calls OUTSIDE a Temporal workflow context,
// so — exactly like the existing workflow unit tests — we read the source as text and assert structure:
//   - reconcile.workflow.ts exports the 3 workflow functions, proxies the 3 correctly-NAMED activities,
//     transcribes the exact per-activity retry curves, and uses the ZodError non-retryable analogue.
//   - all_workflows.ts re-exports ALL FOUR workflow functions (the review spine + the 3 reconcile/repair),
//     so the combined-pod worker's single workflowsPath bundle registers all four types.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const RECONCILE_SRC = readFileSync(
  fileURLToPath(new URL("../../../apps/backend/src/workflows/reconcile.workflow.ts", import.meta.url)),
  "utf-8",
);
const ALL_WORKFLOWS_SRC = readFileSync(
  fileURLToPath(new URL("../../../apps/backend/src/workflows/all_workflows.ts", import.meta.url)),
  "utf-8",
);

describe("reconcile.workflow.ts — three thin pass-through workflows", () => {
  it("exports the three workflow functions", () => {
    expect(RECONCILE_SRC).toContain("export async function reconcileInstallation(");
    expect(RECONCILE_SRC).toContain("export async function reconcileRepositories(");
    expect(RECONCILE_SRC).toContain("export async function repairInstallationRepositories(");
  });

  it("proxies the three activities by their REGISTERED snake_case Temporal names", () => {
    expect(RECONCILE_SRC).toContain("reconcile_installation_activity(payloadDict: unknown)");
    expect(RECONCILE_SRC).toContain("reconcile_repositories_activity(payloadDict: unknown)");
    expect(RECONCILE_SRC).toContain("hydrate_installation_repositories_activity(payloadDict: unknown)");
  });

  it("transcribes the reconcileInstallation retry curve (30s / 1s / 5 attempts)", () => {
    // The reconcile_installation proxy block: 30s STC, 1s initial, 5 attempts.
    const block = RECONCILE_SRC.slice(
      RECONCILE_SRC.indexOf("reconcile_installation_activity(payloadDict"),
    );
    expect(block).toContain('startToCloseTimeout: "30 seconds"');
    expect(block).toContain('initialInterval: "1 second"');
    expect(block).toContain("maximumAttempts: 5");
  });

  it("transcribes the reconcileRepositories retry curve (2min / 5s / 10 attempts)", () => {
    const block = RECONCILE_SRC.slice(
      RECONCILE_SRC.indexOf("reconcile_repositories_activity(payloadDict"),
    );
    expect(block).toContain('startToCloseTimeout: "2 minutes"');
    expect(block).toContain('initialInterval: "5 seconds"');
    expect(block).toContain("maximumAttempts: 10");
  });

  it("transcribes the repair/hydrate retry curve (5min / 10s / x2 / 300s max / 12 attempts)", () => {
    const block = RECONCILE_SRC.slice(
      RECONCILE_SRC.indexOf("hydrate_installation_repositories_activity(payloadDict"),
    );
    expect(block).toContain('startToCloseTimeout: "5 minutes"');
    expect(block).toContain('initialInterval: "10 seconds"');
    expect(block).toContain("backoffCoefficient: 2.0");
    expect(block).toContain('maximumInterval: "300 seconds"');
    expect(block).toContain("maximumAttempts: 12");
  });

  it("uses ZodError (the ValueError analogue) as the non-retryable error type on all three", () => {
    // Three proxies → three nonRetryableErrorTypes: ["ZodError"].
    expect(RECONCILE_SRC.split('nonRetryableErrorTypes: ["ZodError"]').length - 1).toBe(3);
  });

  it("is sandbox-pure: only @temporalio/workflow + type-only contract imports, no clock/random/crypto", () => {
    expect(RECONCILE_SRC).toContain('from "@temporalio/workflow"');
    expect(RECONCILE_SRC).not.toMatch(/Date\.now|Math\.random|crypto\.|setTimeout/);
    // Contract imports must be type-only (erased at emit; no runtime edge into the crypto-importing contracts).
    expect(RECONCILE_SRC).toContain("import type {");
  });
});

describe("all_workflows.ts — combined-pod bundle barrel", () => {
  it("re-exports ALL NINE workflow functions for the single workflowsPath bundle", () => {
    expect(ALL_WORKFLOWS_SRC).toContain("reviewPullRequest");
    expect(ALL_WORKFLOWS_SRC).toContain("reconcileInstallation");
    expect(ALL_WORKFLOWS_SRC).toContain("reconcileRepositories");
    expect(ALL_WORKFLOWS_SRC).toContain("repairInstallationRepositories");
    // Wave-1 liveness-backstop cron workflows (ADR-0074 / ADR-0064).
    expect(ALL_WORKFLOWS_SRC).toContain("mutexJanitorWorkflow");
    expect(ALL_WORKFLOWS_SRC).toContain("reviewRunReaperWorkflow");
    // Wave-4 Confluence ingest workflows (combined-pod worker reuse — ADR-0075).
    expect(ALL_WORKFLOWS_SRC).toContain("confluenceIngestWorkflow");
    expect(ALL_WORKFLOWS_SRC).toContain("markStaleChunksWorkflow");
    expect(ALL_WORKFLOWS_SRC).toContain("triggerPageResyncWorkflow");
    // Seven re-export statements: the review spine + the three reconcile/repair (one statement) + the two
    // Wave-1 backstops (one each) + the three Wave-4 confluence workflows (one each) — 1 + 1 + 2 + 3 = 7.
    expect(ALL_WORKFLOWS_SRC.split("export {").length - 1).toBe(7);
  });
});
