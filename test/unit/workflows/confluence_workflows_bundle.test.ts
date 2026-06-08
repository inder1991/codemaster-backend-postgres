// Source-inspection guard for the three Confluence ingest WORKFLOW bodies (mirrors
// reconcile_workflow_bundle.test.ts). Importing these modules directly would run their top-level
// `proxyActivities(...)` calls OUTSIDE a Temporal workflow context, so — like the sibling workflow
// guard tests — we read each source as text and assert structure:
//   - confluence_ingest.workflow.ts     exports `confluenceIngestWorkflow`, proxies the 7 sync
//       activities by their REGISTERED snake_case Temporal names, transcribes the _PAGE_RETRY /
//       _LIST_RETRY curves + per-activity start_to_close timeouts, has the per-SPACE try/catch
//       fail-open (push to failed_spaces + continue), the per-PAGE try/catch fail-open, the
//       F-40 append-to-live-BEFORE-the-try ordering, and exports the schedule consts (Stage 8).
//   - mark_stale_chunks.workflow.ts      exports `markStaleChunksWorkflow`, proxies
//       `mark_stale_chunks_activity` (10min STC), exports the 24h schedule consts.
//   - trigger_page_resync.workflow.ts    exports `triggerPageResyncWorkflow`, chains the same 4
//       per-page activities for ONE page with _PAGE_RETRY, and mirrors the resync_complete
//       true-on-success / false-on-transient-failure contract.
// All three must be sandbox-pure (only @temporalio/workflow + `import type`, no clock/random/crypto)
// and resolve the deterministic cycle timestamp via the SDK workflow-start instant (no raw Date).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WF_DIR = "../../../apps/backend/src/workflows";

const INGEST_SRC = readFileSync(
  fileURLToPath(new URL(`${WF_DIR}/confluence_ingest.workflow.ts`, import.meta.url)),
  "utf-8",
);
const STALE_SRC = readFileSync(
  fileURLToPath(new URL(`${WF_DIR}/mark_stale_chunks.workflow.ts`, import.meta.url)),
  "utf-8",
);
const RESYNC_SRC = readFileSync(
  fileURLToPath(new URL(`${WF_DIR}/trigger_page_resync.workflow.ts`, import.meta.url)),
  "utf-8",
);

/** Shared sandbox-purity assertions every workflow file must satisfy. */
function assertSandboxPure(src: string): void {
  // Only the sandbox-safe @temporalio/workflow runtime import.
  expect(src).toContain('from "@temporalio/workflow"');
  // Contract imports are type-only (erased at emit; no runtime edge into the crypto-importing contracts).
  expect(src).toContain("import type {");
  // No clock / random / crypto / raw-timer constructs (clock-gate banned in workflow source too).
  expect(src).not.toMatch(/Date\.now|new Date\(|Math\.random|crypto\.|setTimeout|setInterval/);
  // The Temporal CLIENT package must never be imported into the sandbox bundle (would pull a crypto edge).
  expect(src).not.toContain("@temporalio/client");
  // No node:* / DB / network runtime imports — the only `from "..."` runtime import is @temporalio/workflow.
  const runtimeImports = [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gm)].map(
    (m) => m[1],
  );
  expect(runtimeImports).toEqual(["@temporalio/workflow"]);
}

describe("confluence_ingest.workflow.ts — full sync fan-out workflow", () => {
  it("exports the camelCase workflow function (= registered workflow TYPE)", () => {
    expect(INGEST_SRC).toContain(
      "export async function confluenceIngestWorkflow(",
    );
  });

  it("proxies all 7 sync activities by their REGISTERED snake_case Temporal names", () => {
    for (const name of [
      "list_active_confluence_spaces_activity",
      "fetch_space_pages_activity",
      "fetch_page_body_activity",
      "sanitize_page_activity",
      "chunk_and_embed_activity",
      "upsert_chunks_activity",
      "reconcile_deletions_activity",
    ]) {
      expect(INGEST_SRC).toContain(name);
    }
  });

  it("transcribes the _PAGE_RETRY curve (10s init / 2min max / 3 attempts)", () => {
    expect(INGEST_SRC).toContain('initialInterval: "10 seconds"');
    expect(INGEST_SRC).toContain('maximumInterval: "2 minutes"');
    // _PAGE_RETRY + _LIST_RETRY both cap at 3 attempts.
    expect(INGEST_SRC).toContain("maximumAttempts: 3");
  });

  it("transcribes the _LIST_RETRY curve (15s init / 3min max / 3 attempts)", () => {
    expect(INGEST_SRC).toContain('initialInterval: "15 seconds"');
    expect(INGEST_SRC).toContain('maximumInterval: "3 minutes"');
  });

  it("transcribes the per-activity start_to_close timeouts from the Python", () => {
    // list=30s, fetch_space_pages=5min, fetch_page_body=30s, sanitize=30s, chunk_and_embed=3min,
    // upsert=30s, reconcile=30s. (30s appears for list/fetch_body/sanitize/upsert/reconcile.)
    expect(INGEST_SRC).toContain('startToCloseTimeout: "30 seconds"');
    expect(INGEST_SRC).toContain('startToCloseTimeout: "5 minutes"');
    expect(INGEST_SRC).toContain('startToCloseTimeout: "3 minutes"');
  });

  it("has the per-SPACE fail-open: try/catch around syncOneSpace pushing to failed_spaces + continue", () => {
    expect(INGEST_SRC).toMatch(/syncOneSpace\(/);
    expect(INGEST_SRC).toMatch(/failed_spaces|failedSpaces/);
    // The per-space catch records the space + continues (no re-throw inside the space loop catch).
    expect(INGEST_SRC).toMatch(/catch[\s\S]*?\.push\(/);
  });

  it("has the F-40 per-PAGE fail-open with append-to-live BEFORE the try (ordering invariant)", () => {
    // The page_id must be appended to live_page_ids BEFORE the try block so a transient page failure
    // does NOT cause reconcile to soft-delete its chunks. Assert the push precedes the `try {`.
    const livePush = INGEST_SRC.search(/livePageIds\.push\(/);
    const pageTry = INGEST_SRC.indexOf("try {", livePush);
    expect(livePush).toBeGreaterThan(-1);
    expect(pageTry).toBeGreaterThan(livePush);
    // ...and the next `livePageIds.push(` after that try does NOT exist between push and try (push is first).
    const between = INGEST_SRC.slice(livePush + 1, pageTry);
    expect(between).not.toContain("livePageIds.push(");
  });

  it("exports the schedule consts the Stage-8 boot file imports (no @temporalio/client import)", () => {
    expect(INGEST_SRC).toContain('CONFLUENCE_SYNC_SCHEDULE_ID = "refresh-confluence-corpus"');
    expect(INGEST_SRC).toContain('CONFLUENCE_SYNC_TASK_QUEUE = "confluence-sync"');
    expect(INGEST_SRC).toContain('CONFLUENCE_SYNC_WORKFLOW_TYPE = "ConfluenceIngestWorkflow"');
    // 6h interval as a plain number (seconds or ms) const.
    expect(INGEST_SRC).toMatch(/CONFLUENCE_SYNC_INTERVAL/);
    expect(INGEST_SRC).not.toContain("@temporalio/client");
  });

  it("resolves the deterministic cycle timestamp via the SDK workflow-start instant", () => {
    expect(INGEST_SRC).toMatch(/workflowInfo\(\)\.startTime\.toISOString\(\)/);
  });

  it("is sandbox-pure", () => {
    assertSandboxPure(INGEST_SRC);
  });
});

describe("mark_stale_chunks.workflow.ts — 24h stale-derivation cron", () => {
  it("exports the camelCase workflow function", () => {
    expect(STALE_SRC).toContain("export async function markStaleChunksWorkflow(");
  });

  it("proxies mark_stale_chunks_activity with a 10min start_to_close (1:1 with Python)", () => {
    expect(STALE_SRC).toContain("mark_stale_chunks_activity");
    expect(STALE_SRC).toContain('startToCloseTimeout: "10 minutes"');
  });

  it("exports the 24h schedule consts", () => {
    expect(STALE_SRC).toContain('MARK_STALE_CHUNKS_SCHEDULE_ID = "mark-stale-confluence-chunks"');
    expect(STALE_SRC).toContain('MARK_STALE_CHUNKS_TASK_QUEUE = "confluence-sync"');
    expect(STALE_SRC).toContain('MARK_STALE_CHUNKS_WORKFLOW_TYPE = "MarkStaleChunksWorkflow"');
    expect(STALE_SRC).toMatch(/MARK_STALE_CHUNKS_INTERVAL/);
  });

  it("is sandbox-pure", () => {
    assertSandboxPure(STALE_SRC);
  });
});

describe("trigger_page_resync.workflow.ts — single-page resync workflow", () => {
  it("exports the camelCase workflow function", () => {
    expect(RESYNC_SRC).toContain("export async function triggerPageResyncWorkflow(");
  });

  it("chains the 4 per-page activities for ONE page", () => {
    for (const name of [
      "fetch_page_body_activity",
      "sanitize_page_activity",
      "chunk_and_embed_activity",
      "upsert_chunks_activity",
    ]) {
      expect(RESYNC_SRC).toContain(name);
    }
    // It does NOT fan out — no list/space/reconcile activities.
    expect(RESYNC_SRC).not.toContain("list_active_confluence_spaces_activity");
    expect(RESYNC_SRC).not.toContain("fetch_space_pages_activity");
    expect(RESYNC_SRC).not.toContain("reconcile_deletions_activity");
  });

  it("transcribes the _PAGE_RETRY curve (10s init / 2min max / 3 attempts)", () => {
    expect(RESYNC_SRC).toContain('initialInterval: "10 seconds"');
    expect(RESYNC_SRC).toContain('maximumInterval: "2 minutes"');
    expect(RESYNC_SRC).toContain("maximumAttempts: 3");
  });

  it("returns resync_complete=true on success and false on transient failure", () => {
    expect(RESYNC_SRC).toContain("resync_complete: true");
    expect(RESYNC_SRC).toContain("resync_complete: false");
    // The false branch is a catch (transient downstream error).
    expect(RESYNC_SRC).toMatch(/catch[\s\S]*?resync_complete: false/);
  });

  it("exports the task-queue + workflow-type consts", () => {
    expect(RESYNC_SRC).toContain('TRIGGER_PAGE_RESYNC_TASK_QUEUE = "confluence-sync"');
    expect(RESYNC_SRC).toContain('TRIGGER_PAGE_RESYNC_WORKFLOW_TYPE = "TriggerPageResyncWorkflow"');
  });

  it("is sandbox-pure", () => {
    assertSandboxPure(RESYNC_SRC);
  });
});
