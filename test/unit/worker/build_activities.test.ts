// buildActivities() composition-root coverage (post-Temporal-teardown).
//
// buildActivities() is the SOURCE OF TRUTH for the real activity surface the Postgres runner dispatches
// in-process: runner/in_process_ports.ts (the orchestrate ports, by baseFn key), review_job_shell's
// lifecycle bundle (camelCase keys), and the cron/event handlers (snake_case keys). A key the runner wires
// but buildActivities does NOT register is a runtime `base(...)[name] is not a function` crash — exactly the
// live PR #137 failure (now also pinned statically by test/smoke/in_process_ports_wired_keys.smoke.test.ts).
//
// This file pins TWO buildActivities invariants:
//   (1) it registers EVERY name the runtime dispatches by (the hand-maintained EXPECTED set below);
//   (2) every registered value is callable with a SINGLE positional argument (arity <= 1) — a bare 2-arg
//       function would receive `undefined` for its 2nd arg when dispatched with one positional input.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { buildActivities } from "#backend/worker/build_activities.js";

// The activity NAMES the runtime dispatches by (camelCase = the lifecycle/orchestrate ports;
// snake_case = the cron/event handlers). Hand-maintained — the in_process_ports_wired_keys smoke pins the
// orchestrate-port subset against in_process_ports.ts so it cannot silently drift for that surface.
const EXPECTED_ACTIVITY_NAMES = [
  "persistReviewFindings",
  "persistReviewWalkthrough",
  "aggregateFindings",
  "dedupFindings",
  "classifyFiles",
  "cloneRepoIntoWorkspace",
  "loadRepoConfigActivity",
  "computePolicyRules",
  "postCheckRun",
  "postReviewResults",
  "chunkAndRedact",
  "redactChunks",
  "selectCarryForward",
  "staticAnalysis",
  "allocateWorkspace",
  "releaseWorkspace",
  "embedQuery",
  "retrieveKnowledge",
  "bedrockReviewChunk",
  "generateWalkthrough",
  // #4 manifest fetch/parse (bound-method holders) + #6 carry-forward loader (bare fn).
  "fetchManifestSnapshots",
  "parseManifestDependencies",
  "loadParentReviewFindings",
  // Stage-2 lifecycle: gate + mutex lease renew/release + placeholder post/delete.
  "startReviewForWebhook",
  "renewPrReviewMutexLeaseActivity",
  "releasePrReviewMutexActivity",
  "postReviewPlaceholder",
  "deleteReviewPlaceholder",
  // Stage-3 run-lifecycle + finding-delivery + citation + audit.
  "recordReviewLifecycleEvent",
  "finalizeReviewRun",
  "recordRunFailed",
  "recordRunCancelled",
  "recordDeliveryFinalized",
  "recordDeliverySkipped",
  "recordDeliveryDegraded",
  "citationValidate",
  "emitOutputSafetyAuditEvent",
  // Stage-4 enrichment.
  "enrichPrFilesV2",
  "fetchLinkedIssues",
  "fetchSuggestedReviewers",
  "updatePrDescriptionSummary",
  "buildRetrievedEvidence",
  // Stage-5: arbitration apply + tool-run record + fix-prompt.
  "applyArbitrationActivity",
  "recordToolRuns",
  "generateFixPrompt",
  // Liveness-backstop cron activities (snake_case keys the cron handlers dispatch by).
  "mutex_janitor_activity",
  "review_run_reaper_activity",
  // Confluence ingest activities.
  "list_active_confluence_spaces_activity",
  "fetch_space_pages_activity",
  "fetch_page_body_activity",
  "sanitize_page_activity",
  "chunk_and_embed_activity",
  "upsert_chunks_activity",
  "reconcile_deletions_activity",
  "mark_stale_chunks_activity",
  // Retention cron activities.
  "run_id_close_stale_prs",
  "run_id_retire_old_runs",
  "run_id_delete_old_events",
  "run_pg_partman_maintenance",
  "run_workspace_orphan_sweep_activity",
  "run_workspace_reap_activity",
  "run_workspace_released_retention_activity",
  // Spine activities (clone primitive + CODEOWNERS sync + semantic-docs refresh).
  "clone_repository_activity",
  "sync_code_owners_activity",
  "refresh_semantic_docs_activity",
] as const;

describe("buildActivities() composition root", () => {
  // Dummy env so construction succeeds WITHOUT a DB connection or live Vault/GitHub. The DSN is a
  // syntactically-valid Postgres DSN (lazy pool — never dialed); the Qwen DSN routes the embedder through
  // the dev recording client sentinel. buildActivities() reads NO per-PR install id (threaded per input).
  const SAVED: Record<string, string | undefined> = {};
  const DUMMY_ENV: Record<string, string> = {
    CODEMASTER_PG_CORE_DSN: "postgresql://codemaster:codemaster@localhost:5433/codemaster_test",
    CODEMASTER_QWEN_DSN: "stub://recording",
  };

  beforeAll(() => {
    for (const [k, v] of Object.entries(DUMMY_ENV)) {
      SAVED[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterAll(() => {
    for (const k of Object.keys(DUMMY_ENV)) {
      const prev = SAVED[k];
      if (prev === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = prev;
      }
    }
  });

  it("registers EVERY activity the runtime dispatches by (no missing-key crash gaps)", () => {
    const registered = Object.keys(buildActivities()).sort();
    for (const name of EXPECTED_ACTIVITY_NAMES) {
      expect(registered, `missing activity '${name}' in buildActivities() map`).toContain(name);
    }
  });

  it("every registered value is a 1-arg activity (arity <= 1 — the 2-arg-crash guard)", () => {
    const activities = buildActivities() as Record<string, unknown>;
    for (const [name, value] of Object.entries(activities)) {
      expect(typeof value, `activity '${name}' is not a function`).toBe("function");
      // A curried / bound 1-arg activity has `.length <= 1`; a bare 2-arg function has `.length === 2`
      // and crashes when dispatched with one positional arg. This is the load-bearing assert.
      expect(
        (value as (...args: ReadonlyArray<unknown>) => unknown).length,
        `activity '${name}' has arity > 1 — it would receive 'undefined' for its 2nd arg when ` +
          `dispatched with a single positional argument (curry it in buildActivities)`,
      ).toBeLessThanOrEqual(1);
    }
  });
});
