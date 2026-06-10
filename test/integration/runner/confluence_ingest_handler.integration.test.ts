// Phase 3e W3e.2: confluence_ingest — the HARDEST multi-step Temporal workflow BODY re-implemented as
// an in-process JobHandler (the per-space × per-page nested fan-out of confluence_ingest.workflow.ts;
// the 7 confluence activities are REUSED, not rewritten). The Temporal workflow stays in place until
// Phase 4. Proves:
//   (1) HAPPY CYCLE: an enqueued 'confluence_ingest' job driven through ONE background cycle syncs a
//       1-space / 2-page corpus end-to-end — list_active_spaces → fetch_space_pages → per page
//       (fetch_body → sanitize → chunk_and_embed → upsert) → reconcile — landing REAL rows in
//       core.confluence_chunks via the scripted Confluence client + the deterministic
//       RecordingEmbeddingsClient (NO real Confluence / Vault / Qwen network egress), with every embed
//       routed through the "confluence_chunk" purpose + the prod "qwen3-embed-0.6b" model name.
//   (2) PER-SPACE FAIL-OPEN (confluence_sync_workflow.py:146): a space whose fetch_space_pages throws
//       is recorded in failed_spaces (the logged tally — the platform persists job OUTCOME, not the
//       workflow result payload) and the loop CONTINUES: a SECOND space (sorting AFTER the broken one)
//       still processes. The broken space's pre-existing chunks are UNTOUCHED (its reconcile is never
//       reached), and the job settles 'done'.
//   (3) F-40 PROOF (THE key test): each page_id is appended to live_page_ids BEFORE the per-page
//       try/catch, so a page whose fetch_page_body throws is STILL in live_page_ids and
//       reconcile_deletions does NOT soft-delete that page's pre-existing chunks. The one assertion
//       that breaks if the push were moved INSIDE the try (after the throwing fetch): the failing
//       page's seeded chunk would be absent from live_page_ids → reconcile would stamp its deleted_at
//       → `expect(badRow.deleted_at).toBeNull()` fails. A VANISHED page's seeded chunk (absent from
//       the live listing) IS soft-deleted in the same pass — proving reconcile actually ran (the
//       F-40 assertion is not vacuously green on a skipped reconcile).
//   (4) The CRON_SCHEDULES registry carries the 'codemaster-confluence-ingest' interval entry
//       (every 21600s — parity with the Temporal Schedule's every-6h ScheduleIntervalSpec;
//       overlap=SKIP falls out of dedup_key = schedule_id).
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { WallClock } from "#platform/clock.js";
import { disposePool } from "#platform/db/database.js";
import { type ConfluenceChunkClient } from "#backend/activities/confluence_sync.activity.js";
import { RecordingEmbeddingsClient } from "#backend/adapters/embeddings_port.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { runOneBackgroundJob } from "#backend/runner/background_runner.js";
import { CRON_SCHEDULES } from "#backend/runner/cron_schedules.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import { registerCronHandlers } from "#backend/runner/handlers/cron_handlers.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }

afterAll(async () => {
  await db?.destroy();                       // the test's OWN pool
  // The handler resolves tenantKysely/getPool(CODEMASTER_PG_CORE_DSN) — the shared platform pool;
  // dispose it too.
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

// AUTHORIZED DEVIATION (test isolation — same rationale as workspace_retention_handler.integration.
// test.ts): vitest.config.ts shuffles test order, and claim() is a cross-job_type scan over ALL
// core.background_jobs rows — undrained 'ready' leftovers from other suites would otherwise be
// claimed instead of this suite's own job. Safe because test:integration runs --no-file-parallelism
// (files never interleave) and the other writers clean their own rows.
beforeEach(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.background_jobs`.execute(db);
  }
});

/** Bounded runner args (the W3e.1 suite's proven shape): generous ceilings (second-scale cycles never
 *  graze 300s), single-shot drive (never the infinite loop). */
const RUNNER_ARGS = { owner: "w3e2-cron-test", leaseS: 30, heartbeatS: 5, maxRuntimeS: 300 };

// Unique space_key prefix per file run so concurrent runs never collide and cleanup is surgical.
// space_key max is 64 (ConfluenceSpaceRef / FetchSpacePagesInputV1) — prefix + suffix stays well under.
const SK_PREFIX = `ZZINTTEST_CINGEST_${process.pid}_`;

// ─── Scripted Confluence client (the StubClient idiom of confluence_sync.activity.test.ts, keyed
// per space so the nested fan-out + both failure injections are scriptable without any network) ────

type ScriptedSpace = {
  readonly pages: ReadonlyArray<{ page_id: string; version: number }>;
  /** When set, listPages for this space throws (the PER-SPACE fail-open trigger). */
  readonly listError?: string;
  /** Pages whose getPage throws (the F-40 per-page transient-failure trigger). */
  readonly failBodyPages?: ReadonlyArray<string>;
};

class ScriptedConfluenceClient implements ConfluenceChunkClient {
  public constructor(private readonly spaces: ReadonlyMap<string, ScriptedSpace>) {}

  public async listPages(args: { spaceKey: string; cursor?: string | null }): Promise<{
    items: ReadonlyArray<{ page_id: string; version: number }>;
    next_cursor: string | null;
  }> {
    const space = this.spaces.get(args.spaceKey);
    if (space === undefined) {
      return { items: [], next_cursor: null };
    }
    if (space.listError !== undefined) {
      throw new Error(space.listError);
    }
    return { items: space.pages, next_cursor: null };
  }

  public async getPage(args: { pageId: string; spaceKey?: string | null }): Promise<unknown> {
    const spaceKey = args.spaceKey ?? "";
    const space = this.spaces.get(spaceKey);
    const page = space?.pages.find((p) => p.page_id === args.pageId);
    if (space === undefined || page === undefined) {
      throw new Error(`scripted client: unknown page ${args.pageId} in space ${spaceKey}`);
    }
    if ((space.failBodyPages ?? []).includes(args.pageId)) {
      throw new Error("simulated transient page-body failure (rate limit)");
    }
    return {
      schema_version: 2,
      page_id: page.page_id,
      space_key: spaceKey,
      title: `Page ${page.page_id}`,
      version: page.version,
      body_html: "<p>Hello world. This is a doc about the F-40 reconcile invariant.</p>",
      last_modified_at: "2026-05-01T00:00:00+00:00",
      labels: [],
      status: "active",
    };
  }
}

// ─── DB fixtures ───────────────────────────────────────────────────────────────────────────────────

/** Seed one ENABLED confluence_space integration row (the list_active_spaces entry point reads it). */
async function seedSpace(spaceKey: string): Promise<void> {
  await pool.query(
    `INSERT INTO core.integrations (kind, config_json, enabled, trust_tier)
     VALUES ('confluence_space', $1::jsonb, TRUE, 'trusted')`,
    [JSON.stringify({ space_key: spaceKey })],
  );
}

/** Seed one PRE-EXISTING active chunk row for (spaceKey, pageId) — the reconcile-target fixture. The
 *  natural key (page_id, version, chunk_index) is GLOBAL, so page ids carry a per-run UUID. */
async function seedChunk(spaceKey: string, pageId: string): Promise<string> {
  const r = await pool.query<{ chunk_id: string }>(
    `INSERT INTO core.confluence_chunks
       (space_key, page_id, page_title, version, chunk_index, chunk_text, content_sha256,
        labels, page_status, last_modified_at)
     VALUES ($1, $2, 'Pre-existing', 1, 0, 'pre-existing body', $3, '{}'::text[], 'active',
             now() - interval '7 days')
     RETURNING chunk_id`,
    [spaceKey, pageId, randomUUID().replace(/-/g, "").padEnd(64, "0")],
  );
  return r.rows[0]!.chunk_id;
}

type ChunkRow = { chunk_id: string; deleted_at: Date | null };

async function chunkRows(spaceKey: string, pageId: string): Promise<Array<ChunkRow>> {
  const r = await pool.query<ChunkRow>(
    `SELECT chunk_id, deleted_at FROM core.confluence_chunks
      WHERE space_key = $1 AND page_id = $2 ORDER BY chunk_index`,
    [spaceKey, pageId],
  );
  return r.rows;
}

/** Tear down one space's rows: dual-written chunk_embeddings first, then chunks, then the integration. */
async function cleanupSpace(spaceKey: string): Promise<void> {
  await pool.query(
    `DELETE FROM core.chunk_embeddings WHERE chunk_table = 'confluence_chunks' AND chunk_id IN
       (SELECT chunk_id FROM core.confluence_chunks WHERE space_key = $1)`,
    [spaceKey],
  );
  await pool.query(`DELETE FROM core.confluence_chunks WHERE space_key = $1`, [spaceKey]);
  await pool.query(
    `DELETE FROM core.integrations WHERE kind = 'confluence_space' AND config_json->>'space_key' = $1`,
    [spaceKey],
  );
}

/** Build a registry over the disposable DSN with the scripted client + deterministic embedder
 *  injected (NO real Confluence / Vault / Qwen), then drive exactly ONE enqueued 'confluence_ingest'
 *  job through the runner. */
async function runOneIngestJob(
  client: ScriptedConfluenceClient,
  embeddings: RecordingEmbeddingsClient,
): Promise<{ outcome: string; settledState: string; settledLastError: string | null }> {
  const registry = new HandlerRegistry();
  registerCronHandlers(registry, {
    dsn: INTEGRATION_DSN!,
    confluenceClient: client,
    confluenceEmbeddings: embeddings,
  });
  const repo = new BackgroundJobsRepo(db);
  const jobId = await repo.enqueue({ jobType: "confluence_ingest", payload: {} });
  const r = await runOneBackgroundJob({ repo, registry, clock: new WallClock(), ...RUNNER_ARGS });
  const settled = (await repo.getById(jobId))!;
  return { outcome: r.outcome, settledState: settled.state, settledLastError: settled.last_error };
}

describeDb("confluence_ingest handler — multi-step fan-out cron on the background-jobs platform (Phase 3e W3e.2)", () => {
  it("(1) HAPPY CYCLE: one cycle syncs a 1-space/2-page corpus end-to-end — chunks upserted for BOTH pages, embeds routed through the stub", async () => {
    const space = `${SK_PREFIX}HAPPY`;
    const p1 = `cingest-p1-${randomUUID()}`;
    const p2 = `cingest-p2-${randomUUID()}`;
    const client = new ScriptedConfluenceClient(new Map([
      [space, { pages: [{ page_id: p1, version: 1 }, { page_id: p2, version: 3 }] }],
    ]));
    const embeddings = new RecordingEmbeddingsClient();

    try {
      await seedSpace(space);
      const r = await runOneIngestJob(client, embeddings);
      expect(r.outcome).toBe("done");
      expect(r.settledState).toBe("done");
      expect(r.settledLastError).toBeNull();

      // Both pages landed ACTIVE chunk rows (the real repo upsert — not a stub writer).
      for (const pageId of [p1, p2]) {
        const rows = await chunkRows(space, pageId);
        expect(rows.length).toBeGreaterThanOrEqual(1);
        for (const row of rows) {
          expect(row.deleted_at).toBeNull();
        }
      }

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

  it("(2) PER-SPACE FAIL-OPEN: one space's fetch_space_pages throws → recorded in failed_spaces, its chunks untouched; the SECOND space still processes; job settles 'done'", async () => {
    // The broken space sorts FIRST (list_active_spaces orders by space_key), so the second space's
    // upserted chunks prove the loop CONTINUED past the failure rather than failing before it.
    const badSpace = `${SK_PREFIX}AAA_BROKEN`;
    const goodSpace = `${SK_PREFIX}BBB_OK`;
    const oldPage = `cingest-old-${randomUUID()}`;
    const goodPage = `cingest-good-${randomUUID()}`;
    const client = new ScriptedConfluenceClient(new Map([
      [badSpace, { pages: [], listError: "simulated Confluence outage for this space" }],
      [goodSpace, { pages: [{ page_id: goodPage, version: 1 }] }],
    ]));
    const embeddings = new RecordingEmbeddingsClient();
    const infoSpy = vi.spyOn(console, "info");

    try {
      await seedSpace(badSpace);
      await seedSpace(goodSpace);
      // A pre-existing chunk in the BROKEN space: the per-space catch fires BEFORE that space's
      // reconcile, so a broken space can never flush its own corpus.
      await seedChunk(badSpace, oldPage);

      const r = await runOneIngestJob(client, embeddings);
      expect(r.outcome).toBe("done");
      expect(r.settledState).toBe("done");
      expect(r.settledLastError).toBeNull();

      // The second space processed (per-space fail-open: the loop continued past the broken one).
      expect((await chunkRows(goodSpace, goodPage)).length).toBeGreaterThanOrEqual(1);

      // The broken space's pre-existing chunk is untouched (its reconcile never ran).
      const oldRows = await chunkRows(badSpace, oldPage);
      expect(oldRows).toHaveLength(1);
      expect(oldRows[0]!.deleted_at).toBeNull();

      // failed_spaces recorded — the logged tally is the platform analogue of the workflow's
      // RefreshConfluenceOutputV1.failed_spaces (the platform persists OUTCOME, not results).
      const tally = infoSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.startsWith("confluence_ingest swept:"));
      expect(tally).toBeDefined();
      expect(tally).toContain(`failed_spaces=["${badSpace}"]`);
    } finally {
      infoSpy.mockRestore();
      await cleanupSpace(badSpace);
      await cleanupSpace(goodSpace);
    }
  });

  it("(3) F-40 PROOF: a page whose fetch_page_body throws is STILL in live_page_ids → reconcile does NOT soft-delete its pre-existing chunks (a vanished page's chunk IS soft-deleted in the same pass)", async () => {
    const space = `${SK_PREFIX}F40`;
    const goodPage = `cingest-f40-good-${randomUUID()}`;
    const badPage = `cingest-f40-bad-${randomUUID()}`;
    const vanishedPage = `cingest-f40-gone-${randomUUID()}`;
    const client = new ScriptedConfluenceClient(new Map([
      [space, {
        pages: [{ page_id: goodPage, version: 1 }, { page_id: badPage, version: 1 }],
        failBodyPages: [badPage],
      }],
    ]));
    const embeddings = new RecordingEmbeddingsClient();

    try {
      await seedSpace(space);
      // The failing page's PRE-EXISTING corpus — the F-40 protection target.
      await seedChunk(space, badPage);
      // A page absent from the live listing — proves reconcile RAN and soft-deletes absentees
      // (so the badPage assertion below cannot pass vacuously on a skipped reconcile).
      await seedChunk(space, vanishedPage);

      const r = await runOneIngestJob(client, embeddings);

      // The per-page failure is fail-open: the job still settles 'done' (pages_failed is
      // observability-only, exactly as the workflow body keeps it inside the per-space stats).
      expect(r.outcome).toBe("done");
      expect(r.settledState).toBe("done");
      expect(r.settledLastError).toBeNull();

      // ── THE F-40 ASSERTION ──. badPage's page_id was appended to live_page_ids BEFORE the per-page
      // try, so reconcile skipped its chunks. If the append moved INSIDE the try (after the throwing
      // fetch_page_body), reconcile would have stamped deleted_at here and this line fails.
      const badRows = await chunkRows(space, badPage);
      expect(badRows).toHaveLength(1);
      expect(badRows[0]!.deleted_at).toBeNull();

      // Reconcile DID run: the vanished page's chunk was soft-deleted in this same pass.
      const goneRows = await chunkRows(space, vanishedPage);
      expect(goneRows).toHaveLength(1);
      expect(goneRows[0]!.deleted_at).not.toBeNull();

      // The good page processed normally despite its sibling's failure (per-page fail-open).
      expect((await chunkRows(space, goodPage)).length).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanupSpace(space);
    }
  });
});

// ─── CRON_SCHEDULES entry (pure — no DB) ───────────────────────────────────────────────────────────
describe("CRON_SCHEDULES (Phase 3e W3e.2 entry)", () => {
  it("carries the confluence_ingest interval entry with the Temporal-parity cadence (every 6 hours)", () => {
    // arrayContaining (not toEqual): this suite owns ONE entry; the FULL registry literal is pinned
    // by cron_handlers_daily.integration.test.ts.
    expect(CRON_SCHEDULES).toEqual(expect.arrayContaining([
      {
        schedule_id: "codemaster-confluence-ingest",
        job_type: "confluence_ingest",
        cadence_kind: "interval",
        cadence_spec: "21600",
        input: {},
      },
    ]));
  });
});
