// Phase 3e.3: trigger_page_resync — the LAST non-review Temporal workflow migrated onto the
// background-jobs platform (the admin-triggered single-page Confluence resync of
// trigger_page_resync.workflow.ts; the 4 per-page activities are REUSED, not rewritten). The
// Temporal workflow stays in place until Phase 4. Proves:
//   (1) HAPPY RESYNC: an enqueued 'trigger_page_resync' job driven through ONE background cycle runs
//       the 4-step single-page chain — fetch_page_body → sanitize_page → chunk_and_embed →
//       upsert_chunks — for exactly ONE (space_key, page_id), landing REAL rows in
//       core.confluence_chunks via the scripted Confluence client + the deterministic
//       RecordingEmbeddingsClient (NO real Confluence / Vault / Qwen network egress), with every
//       embed routed through the "confluence_chunk" purpose + the prod "qwen3-embed-0.6b" model
//       name. NO space listing and NO reconcile run (single-page scope — the workflow body's exact
//       activity set).
//   (2) TRANSIENT FAILURE → THROW → PLATFORM RETRY (the resync_complete divergence): a transient
//       fetch_page_body failure makes the handler THROW (it does NOT swallow into a
//       resync_complete=false result the way the Temporal workflow body fail-softs) → the runner
//       markFailed-retries: the job settles state='ready' (attempts 1 < max 3) with the error
//       persisted in last_error — NOT silently 'done'. The platform's backoff redrive REPLACES the
//       Temporal TriggerPageResyncOutputV1.resync_complete=false caller-retries contract.
//   (3) The event registry carries ALL 6 event entries (the 5 prior W3d.1/W3d.2 + this one).
//   (4) WORKFLOW_TYPE_TO_JOB_TYPE routes 'triggerPageResyncWorkflow' (the registered TS workflow
//       TYPE string — the exported function name RealTemporalClient.startWorkflow dispatches by;
//       the producer seam, api/admin/confluence_pages_write.ts::PageResyncDispatcherPort, is
//       unwired in production today, so the registered type IS the canonical identity a concrete
//       dispatcher must stamp) onto the registered job_type, and every mapped value has a handler.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { WallClock } from "#platform/clock.js";
import { disposePool } from "#platform/db/database.js";
import { type ConfluenceChunkClient } from "#backend/activities/confluence_sync.activity.js";
import { RecordingEmbeddingsClient } from "#backend/adapters/embeddings_port.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { runOneBackgroundJob } from "#backend/runner/background_runner.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import { registerCronHandlers } from "#backend/runner/handlers/cron_handlers.js";
import { registerEventHandlers } from "#backend/runner/handlers/event_handlers.js";
import { WORKFLOW_TYPE_TO_JOB_TYPE } from "#backend/runner/workflow_job_map.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let db: Kysely<unknown>;
let pool: Pool;
if (INTEGRATION_DSN) {
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
}

afterAll(async () => {
  await db?.destroy(); // the test's OWN pool
  // The handler resolves tenantKysely/getPool(deps.dsn) — the shared platform pool; dispose it too.
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

// AUTHORIZED DEVIATION (test isolation — same rationale as confluence_ingest_handler.integration.
// test.ts): vitest.config.ts shuffles test order, and claim() is a cross-job_type scan over ALL
// core.background_jobs rows — undrained 'ready' leftovers from other suites would otherwise be
// claimed instead of this suite's own job. Safe because test:integration runs --no-file-parallelism
// (files never interleave) and the other writers clean their own rows.
beforeEach(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.background_jobs`.execute(db);
  }
});

/** Bounded runner args (the W3e.2 suite's proven shape): generous ceilings (second-scale cycles
 *  never graze 300s), single-shot drive (never the infinite loop). */
const RUNNER_ARGS = { owner: "p3e3-resync-test", leaseS: 30, heartbeatS: 5, maxRuntimeS: 300 };

// Unique space_key prefix per file run so concurrent runs never collide and cleanup is surgical.
// space_key max is 64 (TriggerPageResyncInputV1) — prefix + suffix stays well under.
const SK_PREFIX = `ZZINTTEST_RESYNC_${process.pid}_`;

// ─── Scripted Confluence client (the W3e.2 suite's idiom, narrowed to the single-page journey) ─────

/** A {@link ConfluenceChunkClient} scripted for ONE page. Records calls so the single-page scope is
 *  assertable (the resync chain calls getPage exactly once and NEVER lists pages). When
 *  `failBody` is set, getPage throws — the transient-failure trigger for test (2). */
class ScriptedResyncClient implements ConfluenceChunkClient {
  public readonly listPagesCalls: Array<string> = [];
  public readonly getPageCalls: Array<{ pageId: string; spaceKey: string | null }> = [];

  public constructor(
    private readonly page: { spaceKey: string; pageId: string; version: number },
    private readonly failBody?: string,
  ) {}

  public async listPages(args: { spaceKey: string; cursor?: string | null }): Promise<{
    items: ReadonlyArray<{ page_id: string; version: number }>;
    next_cursor: string | null;
  }> {
    this.listPagesCalls.push(args.spaceKey);
    return { items: [], next_cursor: null };
  }

  public async getPage(args: { pageId: string; spaceKey?: string | null }): Promise<unknown> {
    this.getPageCalls.push({ pageId: args.pageId, spaceKey: args.spaceKey ?? null });
    if (this.failBody !== undefined) {
      throw new Error(this.failBody);
    }
    if (args.pageId !== this.page.pageId) {
      throw new Error(`scripted client: unknown page ${args.pageId}`);
    }
    return {
      schema_version: 2,
      page_id: this.page.pageId,
      space_key: this.page.spaceKey,
      title: `Page ${this.page.pageId}`,
      version: this.page.version,
      body_html: "<p>Hello world. This doc was re-synced after an approval revocation.</p>",
      last_modified_at: "2026-05-01T00:00:00+00:00",
      labels: [],
      status: "active",
    };
  }
}

// ─── DB fixtures ───────────────────────────────────────────────────────────────────────────────────

type ChunkRow = { chunk_id: string; deleted_at: Date | null };

async function chunkRows(spaceKey: string, pageId: string): Promise<Array<ChunkRow>> {
  const r = await pool.query<ChunkRow>(
    `SELECT chunk_id, deleted_at FROM core.confluence_chunks
      WHERE space_key = $1 AND page_id = $2 ORDER BY chunk_index`,
    [spaceKey, pageId],
  );
  return r.rows;
}

/** Tear down one space's rows: dual-written chunk_embeddings first, then chunks. */
async function cleanupSpace(spaceKey: string): Promise<void> {
  await pool.query(
    `DELETE FROM core.chunk_embeddings WHERE chunk_table = 'confluence_chunks' AND chunk_id IN
       (SELECT chunk_id FROM core.confluence_chunks WHERE space_key = $1)`,
    [spaceKey],
  );
  await pool.query(`DELETE FROM core.confluence_chunks WHERE space_key = $1`, [spaceKey]);
}

/** The dispatcher's args[0] envelope — the byte-exact TriggerPageResyncInputV1 dump the admin
 *  DELETE-approval producer stamps (schema_version + space_key + page_id + triggered_by_user_id). */
function resyncPayload(spaceKey: string, pageId: string): Record<string, unknown> {
  return {
    schema_version: 1,
    space_key: spaceKey,
    page_id: pageId,
    triggered_by_user_id: randomUUID(),
  };
}

/** Build a registry over the disposable DSN with the scripted client + deterministic embedder
 *  injected (NO real Confluence / Vault / Qwen), then drive exactly ONE enqueued
 *  'trigger_page_resync' job through the runner. */
async function runOneResyncJob(
  client: ScriptedResyncClient,
  embeddings: RecordingEmbeddingsClient,
  payload: Record<string, unknown>,
): Promise<{ outcome: string; settledState: string; settledLastError: string | null; settledAttempts: number }> {
  const registry = new HandlerRegistry();
  registerEventHandlers(registry, {
    dsn: INTEGRATION_DSN!,
    confluenceClient: client,
    confluenceEmbeddings: embeddings,
  });
  const repo = new BackgroundJobsRepo(db);
  const jobId = await repo.enqueue({ jobType: "trigger_page_resync", payload });
  const r = await runOneBackgroundJob({ repo, registry, clock: new WallClock(), ...RUNNER_ARGS });
  const settled = (await repo.getById(jobId))!;
  return {
    outcome: r.outcome,
    settledState: settled.state,
    settledLastError: settled.last_error,
    settledAttempts: settled.attempts,
  };
}

describeDb("trigger_page_resync handler — single-page resync on the background-jobs platform (Phase 3e.3)", () => {
  it("(1) HAPPY RESYNC: one cycle runs fetch → sanitize → chunk_and_embed → upsert for ONE page — chunks upserted, embeds via the stub, no listing/reconcile", async () => {
    const space = `${SK_PREFIX}HAPPY`;
    const pageId = `resync-p1-${randomUUID()}`;
    const client = new ScriptedResyncClient({ spaceKey: space, pageId, version: 4 });
    const embeddings = new RecordingEmbeddingsClient();

    try {
      const r = await runOneResyncJob(client, embeddings, resyncPayload(space, pageId));
      expect(r.outcome).toBe("done");
      expect(r.settledState).toBe("done");
      expect(r.settledLastError).toBeNull();

      // The page landed ACTIVE chunk rows (the real repo upsert — not a stub writer).
      const rows = await chunkRows(space, pageId);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        expect(row.deleted_at).toBeNull();
      }

      // SINGLE-PAGE SCOPE: exactly ONE page body fetched, for THE payload page, and the chain never
      // listed the space (fetch_space_pages is the INGEST workflow's step, not the resync's).
      expect(client.getPageCalls).toEqual([{ pageId, spaceKey: space }]);
      expect(client.listPagesCalls).toEqual([]);

      // Every embed went through the INJECTED deterministic client (no network) with the production
      // routing: the "confluence_chunk" metering purpose + the prod model name.
      expect(embeddings.calls.length).toBeGreaterThanOrEqual(1);
      for (const call of embeddings.calls) {
        expect(call.purpose).toBe("confluence_chunk");
        expect(call.model_name).toBe("qwen3-embed-0.6b");
      }
    } finally {
      await cleanupSpace(space);
    }
  });

  it("(2) TRANSIENT FAILURE: fetch_page_body throws → the handler THROWS (no resync_complete=false swallow) → markFailed re-enqueues 'ready' with last_error", async () => {
    const space = `${SK_PREFIX}FAIL`;
    const pageId = `resync-bad-${randomUUID()}`;
    const client = new ScriptedResyncClient(
      { spaceKey: space, pageId, version: 1 },
      "simulated transient page-body failure (rate limit)",
    );
    const embeddings = new RecordingEmbeddingsClient();

    try {
      const r = await runOneResyncJob(client, embeddings, resyncPayload(space, pageId));

      // The handler THREW — the platform retry/backoff REPLACES the Temporal workflow body's
      // resync_complete=false fail-soft (documented divergence): markFailed re-enqueued 'ready'
      // (attempts 1 < max_attempts 3) with the error persisted — NOT silently 'done', NOT 'dead'.
      expect(r.outcome).toBe("failed");
      expect(r.settledState).toBe("ready");
      expect(r.settledAttempts).toBe(1);
      expect(r.settledLastError).toMatch(/simulated transient page-body failure/);

      // Nothing was written for the failed page (the chain aborted at step 1).
      expect(await chunkRows(space, pageId)).toEqual([]);
      expect(embeddings.calls).toEqual([]);
    } finally {
      await cleanupSpace(space);
    }
  });
});

// ─── registry + WORKFLOW_TYPE_TO_JOB_TYPE (pure — no DB) ─────────────────────────────────────────
describe("event registry + workflow_job_map (Phase 3e.3 widening)", () => {
  it("(3) registerEventHandlers registers ALL 6 event job_types (5 prior + trigger_page_resync)", () => {
    const registry = new HandlerRegistry();
    registerEventHandlers(registry, {});
    expect([...registry.registeredTypes()].sort()).toEqual([
      "reconcile_installation",
      "reconcile_repositories",
      "refresh_semantic_docs",
      "repair_installation_repositories",
      "sync_code_owners",
      "trigger_page_resync",
    ]);
  });

  it("(4) maps 'triggerPageResyncWorkflow' (the registered TS workflow type — the canonical identity; the producer port is unwired today) to a registered job_type", () => {
    expect(WORKFLOW_TYPE_TO_JOB_TYPE["triggerPageResyncWorkflow"]).toBe("trigger_page_resync");

    // Lockstep: every mapped job_type (cron AND event) has a registered handler — an unmapped or
    // unregistered value would dead-letter every dispatched row as `no handler for <job_type>`.
    const registry = new HandlerRegistry();
    registerCronHandlers(registry, {});
    registerEventHandlers(registry, {});
    for (const jobType of Object.values(WORKFLOW_TYPE_TO_JOB_TYPE)) {
      expect(registry.registeredTypes()).toContain(jobType);
    }
  });
});
