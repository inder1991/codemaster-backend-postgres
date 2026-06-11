// Phase 4b W4b.3 (review blocker #4): long multi-step handlers must HONOR the runner's AbortSignal
// at their major step boundaries. The runner aborts `work.signal` on lease loss AND at the hard
// runtime ceiling, then settles the attempt — but it cannot STOP an ignoring handler: the orphaned
// promise keeps driving external work (Confluence fetches, chunk embeds, GitHub clones) after the
// job already settled, duplicating cost when the retry redrives. The fix is cooperative:
// `signal.throwIfAborted()` checkpoints at every step boundary, and the per-space / per-page
// fail-open catches RE-THROW on abort instead of swallowing it as one more transient failure.
//
// Handlers are driven DIRECTLY (registry.get(...) + an injected AbortController) — the runner's own
// abort plumbing (hard-timeout race, F4 orphan observer) is pinned by background_runner tests; THIS
// suite pins the handler-side cooperation the runner cannot enforce. A rejecting handler is exactly
// the shape runOneBackgroundJob settles as failed/lease_lost — never 'done'.
//
// MEANINGFULNESS — the assertions that break if the cooperation were removed:
//   (1) confluence_ingest: WITHOUT the throwIfAborted checkpoints, the post-abort external calls
//       fire — page 1's chunk embed runs (`embeddings.calls` ≠ 0) and page 2's fetch_body fires
//       (`fetchedPageIds` gains p2). WITHOUT the re-throw-on-abort in the F-40 per-page / per-space
//       catches, the AbortError is swallowed as fail-open and the handler resolves — `rejects` fails.
//   (2) refresh_semantic_docs (abort DURING clone): WITHOUT the pre-refresh checkpoint, Step 2
//       discovers + embeds + persists the doc the cloner wrote — `embeddings.calls` ≠ 0 and
//       core.knowledge_chunks gains rows.
//   (3) refresh_semantic_docs (ALREADY-aborted signal): WITHOUT the pre-clone checkpoint, the clone
//       (and its token mint) fires against the seeded repo — `cloneCalls` ≠ 0.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import type { CacheGitCloner } from "#backend/activities/clone_repository.activity.js";
import type { ConfluenceChunkClient } from "#backend/activities/confluence_sync.activity.js";
import { RecordingEmbeddingsClient } from "#backend/adapters/embeddings_port.js";
import { HandlerRegistry, type HandlerDeps } from "#backend/runner/handler_registry.js";
import { registerCronHandlers } from "#backend/runner/handlers/cron_handlers.js";
import { registerEventHandlers } from "#backend/runner/handlers/event_handlers.js";
import { WallClock } from "#platform/clock.js";
import { disposeAllPools } from "#platform/db/database.js";
import { BackgroundJobV1 } from "#contracts/background_job.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let db: Kysely<unknown>;
let pool: Pool;
if (INTEGRATION_DSN) {
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
}

beforeAll(() => {
  if (!INTEGRATION_DSN) return;
  // The clone step's REAL defaultResolveRepo resolves the DSN from process.env (1:1 with its
  // Temporal dispatch); mirror the test DSN so it hits the disposable DB.
  process.env.CODEMASTER_PG_CORE_DSN = INTEGRATION_DSN;
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  await db.destroy(); // the test's OWN pool
  await disposeAllPools(); // the handlers' shared ADR-0062 platform pools
});

/** A leased-state job row for direct handler invocation (the runner normally provides the claimed
 *  row; only job_id/clock are read by the handlers — the contract parse keeps the fixture honest). */
function fakeDeps(jobType: string): HandlerDeps {
  const now = new Date();
  return {
    job: BackgroundJobV1.parse({
      job_id: randomUUID(),
      job_type: jobType,
      installation_id: null,
      payload: {},
      payload_sha256: "0".repeat(64),
      state: "leased",
      priority: 0,
      run_after: now,
      lease_owner: "handler-abort-test",
      attempt_token: randomUUID(),
      leased_until: now,
      timeout_at: now,
      heartbeat_at: null,
      attempts: 1,
      max_attempts: 5,
      finished_at: null,
      dead_reason: null,
      last_error: null,
      dedup_key: null,
      created_at: now,
      updated_at: now,
    }),
    clock: new WallClock(),
    shadow: false, // CS1.2: the production posture — the registry's shadow wrapper passes through
  };
}

// ─── confluence_ingest fixtures ────────────────────────────────────────────────────────────────────

// Unique space_key prefix per file run (the confluence_ingest suite's isolation idiom).
const SK_PREFIX = `ZZINTTEST_HABORT_${process.pid}_`;

/** Seed one ENABLED confluence_space integration row (the list_active_spaces entry point reads it). */
async function seedSpace(spaceKey: string): Promise<void> {
  await pool.query(
    `INSERT INTO core.integrations (kind, config_json, enabled, trust_tier)
     VALUES ('confluence_space', $1::jsonb, TRUE, 'trusted')`,
    [JSON.stringify({ space_key: spaceKey })],
  );
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

/** A recording {@link ConfluenceChunkClient} that ABORTS the injected controller while serving the
 *  configured page's body — the "lease lost / runtime ceiling fired mid-page" instant, scripted
 *  deterministically. Every getPage is recorded, so a post-abort fetch is observable. */
class AbortingConfluenceClient implements ConfluenceChunkClient {
  public readonly fetchedPageIds: Array<string> = [];

  public constructor(
    private readonly o: {
      spaceKey: string;
      pages: ReadonlyArray<{ page_id: string; version: number }>;
      abortOnPageId: string;
      controller: AbortController;
      reason: Error;
    },
  ) {}

  public async listPages(args: { spaceKey: string; cursor?: string | null }): Promise<{
    items: ReadonlyArray<{ page_id: string; version: number }>;
    next_cursor: string | null;
  }> {
    if (args.spaceKey !== this.o.spaceKey) {
      return { items: [], next_cursor: null };
    }
    return { items: this.o.pages, next_cursor: null };
  }

  public async getPage(args: { pageId: string; spaceKey?: string | null }): Promise<unknown> {
    this.fetchedPageIds.push(args.pageId);
    if (args.pageId === this.o.abortOnPageId) {
      this.o.controller.abort(this.o.reason); // the abort lands MID-step; the body still returns
    }
    return {
      schema_version: 2,
      page_id: args.pageId,
      space_key: args.spaceKey ?? this.o.spaceKey,
      title: `Page ${args.pageId}`,
      version: 1,
      body_html: "<p>Hello world. This doc exists to be chunked and embedded.</p>",
      last_modified_at: "2026-05-01T00:00:00+00:00",
      labels: [],
      status: "active",
    };
  }
}

// ─── refresh_semantic_docs fixtures (the W3d.2 knowledge suite's idiom) ────────────────────────────

const HEAD_SHA = "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3";

// An ADR doc (doc_kind=adr → KEPT by discoverKnowledgeDocs): the bait the refresh step WOULD embed
// + persist if the pre-refresh checkpoint were missing — keeps the "refresh never ran" assertions
// non-vacuous.
const ADR_DOC = {
  path: "docs/adr/0001-use-postgres.md",
  body: ["# ADR 0001: Use Postgres", "", "## Decision", "", "Postgres 16 is the core store."].join(
    "\n",
  ),
};

/** A unique positive int64-safe bigint for github_* UNIQUE columns (the activity suites' idiom). */
function uniqueGithubId(): bigint {
  return BigInt(`0x${randomUUID().replace(/-/g, "").slice(0, 12)}`);
}

/** Seed the FK parents (installation + repository) the clone step's REAL defaultResolveRepo reads. */
async function seedParents(args: { installationId: string; repositoryId: string }): Promise<void> {
  await pool.query(
    `INSERT INTO core.installations
       (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [args.installationId, uniqueGithubId().toString(), `acct-${args.installationId.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO core.repositories
       (repository_id, installation_id, github_repo_id, full_name, default_branch)
     VALUES ($1, $2, $3, $4, 'main')`,
    [
      args.repositoryId,
      args.installationId,
      uniqueGithubId().toString(),
      `org/repo-${args.repositoryId.slice(0, 8)}`,
    ],
  );
}

/** Delete every row a refresh test created, FK-safe order (children before parents). */
async function cleanupParents(args: { installationId: string; repositoryId: string }): Promise<void> {
  await pool.query(`DELETE FROM core.knowledge_chunks WHERE installation_id = $1`, [
    args.installationId,
  ]);
  await pool.query(`DELETE FROM core.repositories WHERE repository_id = $1`, [args.repositoryId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [
    args.installationId,
  ]);
}

/** The webhook emitter's args[0] envelope (byte-exact keys — _push_emitters.ts). */
function refreshPayload(installationId: string, repositoryId: string): Record<string, unknown> {
  return {
    schema_version: 1,
    installation_id: installationId,
    repository_id: repositoryId,
    triggered_by: "default_branch_push",
    head_sha: HEAD_SHA,
  };
}

async function countKnowledgeChunks(installationId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM core.knowledge_chunks WHERE installation_id = $1`,
    [installationId],
  );
  return Number(r.rows[0]?.n);
}

describeDb("handler AbortSignal cooperation — no external work after abort (Phase 4b W4b.3)", () => {
  it("confluence_ingest: abort lands during page 1 → page 2's fetch_body NEVER fires, NO embed runs, and the handler REJECTS (the F-40 fail-open catches re-throw the abort instead of swallowing it)", async () => {
    const space = `${SK_PREFIX}ABORT`;
    const p1 = `habort-p1-${randomUUID()}`;
    const p2 = `habort-p2-${randomUUID()}`;
    const controller = new AbortController();
    const reason = new Error("handler-abort-test: stop after first page");
    const client = new AbortingConfluenceClient({
      spaceKey: space,
      pages: [
        { page_id: p1, version: 1 },
        { page_id: p2, version: 1 },
      ],
      abortOnPageId: p1,
      controller,
      reason,
    });
    const embeddings = new RecordingEmbeddingsClient();
    const registry = new HandlerRegistry();
    registerCronHandlers(registry, {
      dsn: INTEGRATION_DSN!,
      confluenceClient: client,
      confluenceEmbeddings: embeddings,
    });
    const handler = registry.get("confluence_ingest")!;

    try {
      await seedSpace(space);

      // The handler must THROW the abort reason (→ the runner settles failed/lease_lost, NOT 'done').
      // A swallowed AbortError in the per-page (F-40) or per-space catch resolves instead → this fails.
      await expect(handler({}, controller.signal, fakeDeps("confluence_ingest"))).rejects.toThrow(
        "handler-abort-test: stop after first page",
      );

      // ── THE W4b.3 ASSERTIONS ── Page 1 was fetched (the abort landed mid-step); page 2's
      // fetch_body — the next EXTERNAL call — never fired. Without the throwIfAborted checkpoints
      // the orphaned loop would fetch p2 here.
      expect(client.fetchedPageIds).toEqual([p1]);
      // No COST step ran after the abort: page 1's chunk embed sits behind a post-abort checkpoint.
      expect(embeddings.calls).toHaveLength(0);
    } finally {
      await cleanupSpace(space);
    }
  });

  it("refresh_semantic_docs: abort lands during the clone → the refresh step NEVER runs (zero embeds, zero knowledge_chunks) and the handler REJECTS", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    const cacheRoot = mkdtempSync(join(tmpdir(), "w4b3-clone-cache-"));
    const priorCacheRoot = process.env.CODEMASTER_CLONE_CACHE_ROOT;
    process.env.CODEMASTER_CLONE_CACHE_ROOT = cacheRoot;

    const controller = new AbortController();
    const reason = new Error("handler-abort-test: stop during clone");
    // The cloner WRITES the ADR bait, then aborts: if the pre-refresh checkpoint were missing,
    // Step 2 would discover + embed + persist it (the assertions below would catch real work).
    const cloneCalls: Array<string> = [];
    const cloner: CacheGitCloner = {
      clone: async (args): Promise<void> => {
        cloneCalls.push(args.headSha);
        const docAbs = join(args.targetDir, "repo", ADR_DOC.path);
        await mkdir(join(docAbs, ".."), { recursive: true });
        await writeFile(docAbs, ADR_DOC.body, "utf-8");
        controller.abort(reason); // the abort lands MID-clone; the clone itself completes
      },
    };
    const emb = new RecordingEmbeddingsClient();
    const registry = new HandlerRegistry();
    registerEventHandlers(registry, {
      dsn: INTEGRATION_DSN!,
      refreshCloner: cloner,
      refreshGetToken: async (): Promise<string> => "tok-test",
      refreshEmbeddings: emb,
    });
    const handler = registry.get("refresh_semantic_docs")!;

    try {
      await seedParents({ installationId, repositoryId });

      await expect(
        handler(refreshPayload(installationId, repositoryId), controller.signal, fakeDeps("refresh_semantic_docs")),
      ).rejects.toThrow("handler-abort-test: stop during clone");

      // Step 1 ran (the abort landed mid-step) …
      expect(cloneCalls).toEqual([HEAD_SHA]);
      // … but Step 2 (the refresh — discovery + EMBED + persist) never started: the cloned ADR bait
      // produced zero embed calls and zero persisted chunks. Without the pre-refresh
      // throwIfAborted, both assertions break.
      expect(emb.calls).toHaveLength(0);
      expect(await countKnowledgeChunks(installationId)).toBe(0);
    } finally {
      if (priorCacheRoot === undefined) {
        delete process.env.CODEMASTER_CLONE_CACHE_ROOT;
      } else {
        process.env.CODEMASTER_CLONE_CACHE_ROOT = priorCacheRoot;
      }
      rmSync(cacheRoot, { recursive: true, force: true });
      await cleanupParents({ installationId, repositoryId });
    }
  });

  it("refresh_semantic_docs: an ALREADY-aborted signal stops the job BEFORE the clone — zero external work", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    const cacheRoot = mkdtempSync(join(tmpdir(), "w4b3-preclone-cache-"));
    const priorCacheRoot = process.env.CODEMASTER_CLONE_CACHE_ROOT;
    process.env.CODEMASTER_CLONE_CACHE_ROOT = cacheRoot;

    const controller = new AbortController();
    controller.abort(new Error("handler-abort-test: aborted before dispatch"));
    const cloneCalls: Array<string> = [];
    const tokenCalls: Array<number> = [];
    const cloner: CacheGitCloner = {
      clone: async (args): Promise<void> => {
        cloneCalls.push(args.headSha);
      },
    };
    const emb = new RecordingEmbeddingsClient();
    const registry = new HandlerRegistry();
    registerEventHandlers(registry, {
      dsn: INTEGRATION_DSN!,
      refreshCloner: cloner,
      refreshGetToken: async (gid: number): Promise<string> => {
        tokenCalls.push(gid);
        return "tok-test";
      },
      refreshEmbeddings: emb,
    });
    const handler = registry.get("refresh_semantic_docs")!;

    try {
      // Seeded parents make the assertion REAL: without the pre-clone checkpoint the resolve +
      // token mint + clone would all succeed against this row (cloneCalls would gain HEAD_SHA).
      await seedParents({ installationId, repositoryId });

      await expect(
        handler(refreshPayload(installationId, repositoryId), controller.signal, fakeDeps("refresh_semantic_docs")),
      ).rejects.toThrow("handler-abort-test: aborted before dispatch");

      expect(cloneCalls).toHaveLength(0); // no NEW external call STARTS after abort (gate ①)
      expect(tokenCalls).toHaveLength(0);
      expect(emb.calls).toHaveLength(0);
    } finally {
      if (priorCacheRoot === undefined) {
        delete process.env.CODEMASTER_CLONE_CACHE_ROOT;
      } else {
        process.env.CODEMASTER_CLONE_CACHE_ROOT = priorCacheRoot;
      }
      rmSync(cacheRoot, { recursive: true, force: true });
      await cleanupParents({ installationId, repositoryId });
    }
  });
});
