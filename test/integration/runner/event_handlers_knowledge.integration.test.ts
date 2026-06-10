// Phase 3d W3d.2: the 2 knowledge-producer EVENT-DRIVEN handlers — sync_code_owners /
// refresh_semantic_docs — adapted from the Temporal workflows (sync_code_owners.workflow.ts: a pure
// single-activity pass-through; refresh_semantic_docs.workflow.ts: the 2-step clone → refresh
// sequence) onto the Postgres background-jobs platform. Proves:
//   (1) PARITY (sync_code_owners, flag ON): an enqueued 'sync_code_owners' job driven through ONE
//       background cycle produces the SAME DB effect as calling syncCodeOwners directly — the
//       CODEOWNERS body (stub GitHub port, the activity suite's idiom) parses to 3 valid rules
//       upserted into core.code_owners.
//   (2) DEFAULT POSTURE (sync_code_owners, flag omitted): the production default is OFF
//       (FOLLOW-UP-code-owners-v1-flag-reader, 1:1 with build_activities.ts) — the job settles done
//       with ZERO rows and ZERO GitHub fetches (the flag gate fires before any I/O).
//   (3) SEQUENCE (refresh_semantic_docs): the handler reproduces the Temporal workflow body's 2-step
//       chain IN ORDER — Step 1 clone_repository_activity (stub CacheGitCloner writes knowledge docs
//       into `<targetDir>/repo`; the REAL defaultResolveRepo resolves the seeded repo row; a stub
//       token provider stands in for Vault) produces the workspace, THEN Step 2 refreshSemanticDocs
//       discovers + chunks + embeds those docs into core.knowledge_chunks (RecordingEmbeddingsClient,
//       the activity suite's deterministic embedder). The order is proven STRUCTURALLY: the persisted
//       chunks' content can only come from files the CLONER wrote — refresh-before-clone would
//       discover zero docs.
// Plus the pure (no-DB) checks: the event registry carries ALL 5 event entries (the 3 W3d.1
// reconcile/repair + these 2), and WORKFLOW_TYPE_TO_JOB_TYPE routes the byte-exact producer
// workflow_type strings ('syncCodeOwners' / 'refreshSemanticDocs' — _push_emitters.ts) onto
// registered job_types.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CacheGitCloner } from "#backend/activities/clone_repository.activity.js";
import type { CodeOwnersFilePort } from "#backend/activities/sync_code_owners.activity.js";
import { RecordingEmbeddingsClient } from "#backend/adapters/embeddings_port.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { runOneBackgroundJob } from "#backend/runner/background_runner.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import { registerCronHandlers } from "#backend/runner/handlers/cron_handlers.js";
import { registerEventHandlers } from "#backend/runner/handlers/event_handlers.js";
import { WORKFLOW_TYPE_TO_JOB_TYPE } from "#backend/runner/workflow_job_map.js";
import { WallClock } from "#platform/clock.js";
import { disposeAllPools } from "#platform/db/database.js";
import { describeDb, INTEGRATION_DSN } from "../_db.js";

let db: Kysely<unknown>;
let pool: Pool;
if (INTEGRATION_DSN) {
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
}

beforeAll(() => {
  if (!INTEGRATION_DSN) return;
  // The clone step's REAL defaultResolveRepo + the per-dispatch repo construction resolve the DSN
  // from process.env (1:1 with their Temporal dispatch); mirror the test DSN so they hit the
  // disposable DB.
  process.env.CODEMASTER_PG_CORE_DSN = INTEGRATION_DSN;
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  await db.destroy(); // the test's OWN pool
  await disposeAllPools(); // the activities' shared ADR-0062 platform pools
});

// AUTHORIZED DEVIATION (test isolation — same rationale as event_handlers_reconcile.integration.test.ts):
// vitest.config.ts shuffles test order, and claim() is a cross-job_type scan over ALL
// core.background_jobs rows; per-test wipes keep claim targets exact. Safe because test:integration
// runs --no-file-parallelism (files never interleave) and the other writers clean their own rows.
beforeEach(async () => {
  if (INTEGRATION_DSN) {
    await pool.query(`DELETE FROM core.background_jobs`);
  }
});

/** Drive exactly ONE claim → dispatch → settle cycle (the W4 suite's WallClock determinism note:
 *  generous ceilings vs ms-fast handlers keep the hard-timeout race deterministic). */
async function runOne(
  registry: HandlerRegistry,
  repo: BackgroundJobsRepo,
): Promise<{ outcome: string; jobId?: string }> {
  return runOneBackgroundJob({
    repo,
    registry,
    clock: new WallClock(),
    owner: "w3d2-knowledge-test",
    leaseS: 30,
    heartbeatS: 5,
    maxRuntimeS: 300,
  });
}

/** A unique positive int64-safe bigint for github_* UNIQUE columns (the activity suites' idiom). */
function uniqueGithubId(): bigint {
  return BigInt(`0x${randomUUID().replace(/-/g, "").slice(0, 12)}`);
}

/** Seed the FK parents (installation + repository); returns the numeric github_installation_id +
 *  full_name the clone step's REAL defaultResolveRepo resolves. */
async function seedParents(args: {
  installationId: string;
  repositoryId: string;
}): Promise<{ githubInstallationId: bigint; fullName: string }> {
  const githubInstallationId = uniqueGithubId();
  const fullName = `org/repo-${args.repositoryId.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO core.installations
       (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [args.installationId, githubInstallationId.toString(), `acct-${args.installationId.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO core.repositories
       (repository_id, installation_id, github_repo_id, full_name, default_branch)
     VALUES ($1, $2, $3, $4, 'main')`,
    [args.repositoryId, args.installationId, uniqueGithubId().toString(), fullName],
  );
  return { githubInstallationId, fullName };
}

/** Delete every row a test created, FK-safe order (children before parents). */
async function cleanup(args: { installationId: string; repositoryId: string }): Promise<void> {
  await pool.query(`DELETE FROM core.code_owners WHERE repository_id = $1`, [args.repositoryId]);
  await pool.query(`DELETE FROM core.knowledge_chunks WHERE installation_id = $1`, [
    args.installationId,
  ]);
  await pool.query(`DELETE FROM core.repositories WHERE repository_id = $1`, [args.repositoryId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [
    args.installationId,
  ]);
}

// ─── sync_code_owners fixtures (the activity suite's stub idiom) ─────────────────────────────────

const CODEOWNERS_SHA = "a".repeat(40);

const CODEOWNERS_BODY = [
  "# A representative CODEOWNERS file",
  "*           @org/global-owners",
  "/docs/      @org/docs-team @writer",
  "src/**.ts   @indersingh   # trailing comment ignored",
  "",
  "malformed-no-owners",
].join("\n");

/** A stub {@link CodeOwnersFilePort}: the configured [base64-ASCII bytes, blobSha] tuple, exactly
 *  the shape the production 3-path getContents adapter yields. Records calls so the flag-OFF test
 *  can assert the activity short-circuits BEFORE any fetch. */
function stubCodeOwnersGithub(): { github: CodeOwnersFilePort; callCount: () => number } {
  let calls = 0;
  return {
    github: {
      fetchCodeowners: async (): Promise<readonly [Uint8Array, string] | null> => {
        await Promise.resolve();
        calls += 1;
        const b64 = Buffer.from(CODEOWNERS_BODY, "utf-8").toString("base64");
        return [new Uint8Array(Buffer.from(b64, "ascii")), CODEOWNERS_SHA] as const;
      },
    },
    callCount: () => calls,
  };
}

/** The webhook emitter's args[0] envelope (byte-exact keys — _push_emitters.ts maybeEmitSyncCodeOwners). */
function syncCodeOwnersPayload(installationId: string, repositoryId: string): Record<string, unknown> {
  return {
    schema_version: 1,
    installation_id_uuid: installationId,
    installation_id_int: 4242,
    repository_id: repositoryId,
    owner: "org",
    repo: "widgets",
    default_branch: "main",
  };
}

async function countCodeOwnersRows(installationId: string, repositoryId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM core.code_owners
     WHERE installation_id = $1 AND repository_id = $2`,
    [installationId, repositoryId],
  );
  return Number(r.rows[0]?.n);
}

// ─── refresh_semantic_docs fixtures ──────────────────────────────────────────────────────────────

const HEAD_SHA = "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3";

// An ADR doc (doc_kind=adr → KEPT by discoverKnowledgeDocs) — the refresh activity suite's fixture.
const ADR_DOC = {
  path: "docs/adr/0001-use-postgres.md",
  body: [
    "# ADR 0001: Use Postgres",
    "",
    "## Context",
    "",
    "We need one durable store for the core loop.",
    "",
    "## Decision",
    "",
    "Postgres 16 + pgvector is the single core data store.",
  ].join("\n"),
};

/** The webhook emitter's args[0] envelope (byte-exact keys — _push_emitters.ts maybeEmitRefreshSemanticDocs). */
function refreshPayload(installationId: string, repositoryId: string): Record<string, unknown> {
  return {
    schema_version: 1,
    installation_id: installationId,
    repository_id: repositoryId,
    triggered_by: "default_branch_push",
    head_sha: HEAD_SHA,
  };
}

describeDb("event_handlers — sync_code_owners + refresh_semantic_docs (Phase 3d W3d.2)", () => {
  it("(1) PARITY: 'sync_code_owners' (flag ON) parses CODEOWNERS + upserts core.code_owners through one cycle", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    await seedParents({ installationId, repositoryId });
    try {
      const gh = stubCodeOwnersGithub();
      const registry = new HandlerRegistry();
      registerEventHandlers(registry, {
        dsn: INTEGRATION_DSN!,
        codeOwnersGithub: gh.github,
        codeOwnersIsEnabled: async (): Promise<boolean> => {
          await Promise.resolve();
          return true;
        },
      });
      const repo = new BackgroundJobsRepo(db);

      const jobId = await repo.enqueue({
        jobType: "sync_code_owners",
        payload: syncCodeOwnersPayload(installationId, repositoryId),
      });
      const r = await runOne(registry, repo);
      expect(r.outcome).toBe("done");
      expect(r.jobId).toBe(jobId);

      // The Temporal-activity effect, reproduced through the handler path: the CODEOWNERS body yields
      // 3 valid rules (comment line skipped, owner-less line dropped) — same as the activity suite.
      expect(gh.callCount()).toBe(1);
      expect(await countCodeOwnersRows(installationId, repositoryId)).toBe(3);

      // source_file_sha persisted == the stub blob SHA (the natural-key idempotency component).
      const shas = await pool.query<{ source_file_sha: string }>(
        `SELECT DISTINCT source_file_sha FROM core.code_owners
         WHERE installation_id = $1 AND repository_id = $2`,
        [installationId, repositoryId],
      );
      expect(shas.rows.map((row) => row.source_file_sha.trim())).toEqual([CODEOWNERS_SHA]);
    } finally {
      await cleanup({ installationId, repositoryId });
    }
  });

  it("(2) DEFAULT POSTURE: 'sync_code_owners' with isEnabled OMITTED is flag-OFF — done, zero fetches, zero rows", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    await seedParents({ installationId, repositoryId });
    try {
      const gh = stubCodeOwnersGithub();
      const registry = new HandlerRegistry();
      // NO codeOwnersIsEnabled — the production default is OFF (FOLLOW-UP-code-owners-v1-flag-reader,
      // 1:1 with build_activities.ts's `isEnabled: async () => false` wiring).
      registerEventHandlers(registry, { dsn: INTEGRATION_DSN!, codeOwnersGithub: gh.github });
      const repo = new BackgroundJobsRepo(db);

      await repo.enqueue({
        jobType: "sync_code_owners",
        payload: syncCodeOwnersPayload(installationId, repositoryId),
      });
      const r = await runOne(registry, repo);
      expect(r.outcome).toBe("done"); // disabled is a clean no-op, NOT a failure

      expect(gh.callCount()).toBe(0); // the flag gate fires BEFORE any GitHub fetch
      expect(await countCodeOwnersRows(installationId, repositoryId)).toBe(0);
    } finally {
      await cleanup({ installationId, repositoryId });
    }
  });

  it("(3) SEQUENCE: 'refresh_semantic_docs' runs clone → refresh; the cloned docs land in core.knowledge_chunks", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    const { githubInstallationId, fullName } = await seedParents({ installationId, repositoryId });

    // The clone step computes `<CODEMASTER_CLONE_CACHE_ROOT>/<iid>/<rid>` at CALL time — point it at
    // a throwaway tmpdir for this test.
    const cacheRoot = mkdtempSync(join(tmpdir(), "w3d2-clone-cache-"));
    const priorCacheRoot = process.env.CODEMASTER_CLONE_CACHE_ROOT;
    process.env.CODEMASTER_CLONE_CACHE_ROOT = cacheRoot;

    try {
      // Stub CacheGitCloner: records the clone call + writes the ADR knowledge doc into
      // `<targetDir>/repo` (the GitSubprocessCloner checkout layout). The refresh step can only
      // discover docs the CLONER wrote — the structural clone-before-refresh order proof.
      const cloneCalls: Array<{ repoFullName: string; headSha: string; installationToken: string }> =
        [];
      const cloner: CacheGitCloner = {
        clone: async (args): Promise<void> => {
          cloneCalls.push({
            repoFullName: args.repoFullName,
            headSha: args.headSha,
            installationToken: args.installationToken,
          });
          const docAbs = join(args.targetDir, "repo", ADR_DOC.path);
          await mkdir(join(docAbs, ".."), { recursive: true });
          await writeFile(docAbs, ADR_DOC.body, "utf-8");
        },
      };
      // Stub token provider (the Vault stand-in); records the numeric id the REAL defaultResolveRepo
      // resolved from the seeded core.installations row.
      const tokenCalls: Array<number> = [];
      const getToken = async (gid: number): Promise<string> => {
        tokenCalls.push(gid);
        return "tok-test";
      };
      const emb = new RecordingEmbeddingsClient();

      const registry = new HandlerRegistry();
      registerEventHandlers(registry, {
        dsn: INTEGRATION_DSN!,
        refreshCloner: cloner,
        refreshGetToken: getToken,
        refreshEmbeddings: emb,
      });
      const repo = new BackgroundJobsRepo(db);

      const jobId = await repo.enqueue({
        jobType: "refresh_semantic_docs",
        payload: refreshPayload(installationId, repositoryId),
      });
      const r = await runOne(registry, repo);
      expect(r.outcome).toBe("done");
      expect(r.jobId).toBe(jobId);

      // Step 1 ran: ONE clone, against the SEEDED repo identity (defaultResolveRepo resolved the
      // full_name + numeric github_installation_id from the disposable DB) with the payload's SHA +
      // the stub-minted token.
      expect(cloneCalls).toEqual([
        { repoFullName: fullName, headSha: HEAD_SHA, installationToken: "tok-test" },
      ]);
      expect(tokenCalls).toEqual([Number(githubInstallationId)]);

      // Step 2 ran AFTER step 1: the persisted chunks carry the ADR doc the CLONER wrote into the
      // workspace (refresh-before-clone would have discovered zero docs).
      const chunks = await pool.query<{ relative_path: string; doc_kind: string }>(
        `SELECT relative_path, doc_kind FROM core.knowledge_chunks
         WHERE installation_id = $1 AND repository_id = $2`,
        [installationId, repositoryId],
      );
      expect(chunks.rows.length).toBeGreaterThan(0);
      expect(chunks.rows.every((row) => row.relative_path === ADR_DOC.path)).toBe(true);
      expect(chunks.rows.every((row) => row.doc_kind === "adr")).toBe(true);

      // The embed side saw the doc's content under the platform purpose + model (the activity
      // suite's assertions, reproduced through the handler path).
      expect(emb.callCount()).toBeGreaterThan(0);
      expect(emb.calls.every((c) => c.purpose === "in_repo_doc")).toBe(true);
      expect(emb.calls.every((c) => c.model_name === "qwen3-embed-0.6b")).toBe(true);
      expect(emb.calls.some((c) => c.texts.some((t) => t.includes("pgvector")))).toBe(true);

      // The clone landed under the test cache root (the env seam took effect — no /clone-cache leak).
      expect(existsSync(join(cacheRoot, installationId, repositoryId, "repo"))).toBe(true);
    } finally {
      if (priorCacheRoot === undefined) {
        delete process.env.CODEMASTER_CLONE_CACHE_ROOT;
      } else {
        process.env.CODEMASTER_CLONE_CACHE_ROOT = priorCacheRoot;
      }
      rmSync(cacheRoot, { recursive: true, force: true });
      await cleanup({ installationId, repositoryId });
    }
  });
});

// ─── registry + WORKFLOW_TYPE_TO_JOB_TYPE (pure — no DB) ─────────────────────────────────────────
describe("event registry + workflow_job_map (Phase 3d W3d.2 widening)", () => {
  it("registerEventHandlers registers ALL 6 event job_types (3 reconcile/repair + 2 knowledge producers + the 3e.3 page resync)", () => {
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

  it("maps the 2 knowledge-producer workflow_type strings (byte-exact producer strings) to registered job_types", () => {
    // Keys are the EXACT workflow_type strings _push_emitters.ts stamps on outbox rows
    // (SYNC_CODE_OWNERS_WORKFLOW_TYPE / REFRESH_SEMANTIC_DOCS_WORKFLOW_TYPE).
    expect(WORKFLOW_TYPE_TO_JOB_TYPE["syncCodeOwners"]).toBe("sync_code_owners");
    expect(WORKFLOW_TYPE_TO_JOB_TYPE["refreshSemanticDocs"]).toBe("refresh_semantic_docs");

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
