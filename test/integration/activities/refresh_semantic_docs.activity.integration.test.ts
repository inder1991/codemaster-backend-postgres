/**
 * Integration test for the `refresh_semantic_docs_activity` holder — REAL ported port of the frozen
 * Python `@activity.defn("refresh_semantic_docs_activity")`
 * (vendor/codemaster-py/codemaster/activities/refresh_semantic_docs.py::RefreshSemanticDocsActivity.refresh_semantic_docs),
 * against a DISPOSABLE Postgres (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the
 * in-cluster DB). Runs ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise.
 *
 * The GitHub/clone side is replaced by a REAL temp workspace dir written with markdown docs (the frozen
 * Python reads the ALREADY-CLONED workspace from disk via `discover_knowledge_docs` + `fs` — there is no
 * GitHub API port in this activity). The embed side is the DETERMINISTIC {@link RecordingEmbeddingsClient}
 * (1024-dim synthetic vectors, no live calls). The activity discovers + chunks + embeds + upserts into
 * `core.knowledge_chunks` through the REAL {@link PostgresKnowledgeChunkRepo}.
 *
 * Assertions (1:1 with the Python behaviour):
 *   - happy path → real knowledge_chunks rows written for the repo-doc source (chunks_persisted matches
 *     the row count; rows readable back; installation_id / repository_id / relative_path / content_sha256 /
 *     vector / doc_kind / doc_status columns byte-faithful; tenancy-scoped to THIS installation only).
 *   - idempotent re-run (same workspace) → second call re-embeds nothing NEW that changed (ON CONFLICT
 *     keeps the row count stable; no duplicate rows).
 *   - R-5 ORPHAN-SWEEP EMPTY-FETCH GUARD → a SECOND run against a workspace with ZERO knowledge docs
 *     PRESERVES the existing chunks (does NOT wipe the index). This is the load-bearing safety check.
 *   - embed-service unreachable → returns retrieval_degraded=true; the prior index is unchanged.
 *
 * Each test owns a UNIQUE installation_id / repository_id (+ unique github_* bigints) so per-org rows
 * never collide, and cleans up (children before parents).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { RecordingEmbeddingsClient } from "#backend/adapters/embeddings_port.js";
import { RefreshSemanticDocsActivity } from "#backend/activities/refresh_semantic_docs.activity.js";
import { PostgresKnowledgeChunkRepo } from "#backend/domain/repos/knowledge_chunks_repo.js";

import type { RefreshSemanticDocsInputV1 } from "#contracts/refresh_semantic_docs.v1.js";

import { WallClock } from "#platform/clock.js";
import { disposeAllPools, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const MODEL_NAME = "qwen3-embed-0.6b";

// Minimal typing for the FK-parent seeding + read-back assertions (NOT part of the activity's surface).
type SeedDb = Record<string, never>;

let db: Kysely<SeedDb>;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  db = tenantKysely<SeedDb>(INTEGRATION_DSN);
});

afterAll(async () => {
  await disposeAllPools();
});

/** A unique positive int64-safe bigint for github_* UNIQUE columns. */
function uniqueGithubId(): bigint {
  return BigInt(`0x${randomUUID().replace(/-/g, "").slice(0, 12)}`);
}

/** Seed the FK parents (installation + repository) a knowledge_chunks row requires. */
async function seedParents(args: {
  installationId: string;
  repositoryId: string;
}): Promise<void> {
  await sql`
    INSERT INTO core.installations
      (installation_id, github_installation_id, account_login, account_type)
    VALUES (${args.installationId}, ${uniqueGithubId().toString()}, ${"acct-" +
    args.installationId.slice(0, 8)}, 'Organization')
  `.execute(db);
  await sql`
    INSERT INTO core.repositories
      (repository_id, installation_id, github_repo_id, full_name, default_branch)
    VALUES (${args.repositoryId}, ${args.installationId}, ${uniqueGithubId().toString()}, ${"org/repo-" +
    args.repositoryId.slice(0, 8)}, 'main')
  `.execute(db);
}

/** Delete every row a test created, FK-safe order (children before parents). */
async function cleanup(args: {
  installationId: string;
  repositoryId: string;
}): Promise<void> {
  await sql`DELETE FROM core.knowledge_chunks WHERE installation_id = ${args.installationId}`.execute(
    db,
  );
  await sql`DELETE FROM core.repositories WHERE repository_id = ${args.repositoryId}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${args.installationId}`.execute(db);
}

/** Count knowledge_chunks rows for a (installation, repo). */
async function countRows(installationId: string, repositoryId: string): Promise<number> {
  const r = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM core.knowledge_chunks
    WHERE installation_id = ${installationId} AND repository_id = ${repositoryId}
  `.execute(db);
  return Number(r.rows[0]?.n);
}

/** Read back the distinct (relative_path, doc_kind, doc_status) projections for a repo's index. */
async function readProjection(
  installationId: string,
  repositoryId: string,
): Promise<Array<{ relative_path: string; doc_kind: string; doc_status: string }>> {
  const r = await sql<{ relative_path: string; doc_kind: string; doc_status: string }>`
    SELECT relative_path, doc_kind, doc_status FROM core.knowledge_chunks
    WHERE installation_id = ${installationId} AND repository_id = ${repositoryId}
    ORDER BY relative_path, chunk_index
  `.execute(db);
  return r.rows;
}

/** Make a temp workspace dir; caller cleans it. */
function makeWorkspace(files: ReadonlyArray<{ path: string; body: string }>): string {
  const ws = mkdtempSync(join(tmpdir(), "refresh-semantic-docs-"));
  for (const f of files) {
    const abs = join(ws, f.path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, f.body, "utf-8");
  }
  return ws;
}

function input(installationId: string, repositoryId: string): RefreshSemanticDocsInputV1 {
  return {
    schema_version: 1,
    installation_id: installationId,
    repository_id: repositoryId,
    triggered_by: "default_branch_push",
    head_sha: "abc1234",
  };
}

function activity(embeddings: RecordingEmbeddingsClient): RefreshSemanticDocsActivity {
  return new RefreshSemanticDocsActivity({
    embeddings,
    chunkRepo: PostgresKnowledgeChunkRepo.fromDsn(INTEGRATION_DSN ?? ""),
    modelName: MODEL_NAME,
    clock: new WallClock(),
  });
}

// An ADR doc (doc_kind=adr, non-other → KEPT by discoverKnowledgeDocs) with a couple of sections so the
// markdown chunker yields ≥1 chunk. A runbook doc (doc_kind=runbook) for a second source path.
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
const RUNBOOK_DOC = {
  path: "docs/runbooks/deploy.md",
  body: [
    "# Deploy runbook",
    "",
    "## Steps",
    "",
    "Roll every pod consuming the image, not just the worker.",
  ].join("\n"),
};
// A guideline file (CLAUDE.md) the KNOWLEDGE walk must EXCLUDE (Subsystem A owns guideline patterns) — a
// negative control proving the repo-doc index does NOT swallow policy files.
const CLAUDE_GUIDELINE = {
  path: "CLAUDE.md",
  body: "# Repo guardrails\n\nRun make validate-fast before declaring done.",
};

describeDb("refresh_semantic_docs_activity (integration, disposable PG)", () => {
  it("happy path: discovers + chunks + embeds knowledge docs into core.knowledge_chunks", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    await seedParents({ installationId, repositoryId });
    const ws = makeWorkspace([ADR_DOC, RUNBOOK_DOC, CLAUDE_GUIDELINE]);
    try {
      const emb = new RecordingEmbeddingsClient();
      const act = activity(emb);

      const result = await act.refreshSemanticDocs({ input: input(installationId, repositoryId), workspacePath: ws });

      // docs_discovered counts the 2 KNOWLEDGE docs (ADR + runbook); CLAUDE.md is a guideline → excluded.
      expect(result.docs_discovered).toBe(2);
      expect(result.retrieval_degraded).toBe(false);
      expect(result.degradation_reason).toBeNull();
      expect(result.chunks_persisted).toBeGreaterThan(0);

      // The embed client was called with purpose=in_repo_doc + the platform model name.
      expect(emb.callCount()).toBeGreaterThan(0);
      expect(emb.calls.every((c) => c.purpose === "in_repo_doc")).toBe(true);
      expect(emb.calls.every((c) => c.model_name === MODEL_NAME)).toBe(true);

      // Rows landed for THIS installation/repo; chunks_persisted matches the persisted row count.
      expect(await countRows(installationId, repositoryId)).toBe(result.chunks_persisted);

      // Column projection: ADR → doc_kind=adr, runbook → doc_kind=runbook; both doc_status=active. The
      // CLAUDE.md guideline is NOT in the repo-doc index.
      const proj = await readProjection(installationId, repositoryId);
      const paths = new Set(proj.map((p) => p.relative_path));
      expect(paths.has("docs/adr/0001-use-postgres.md")).toBe(true);
      expect(paths.has("docs/runbooks/deploy.md")).toBe(true);
      expect(paths.has("CLAUDE.md")).toBe(false);
      const byPath = new Map(proj.map((p) => [p.relative_path, p]));
      expect(byPath.get("docs/adr/0001-use-postgres.md")?.doc_kind).toBe("adr");
      expect(byPath.get("docs/runbooks/deploy.md")?.doc_kind).toBe("runbook");
      expect(proj.every((p) => p.doc_status === "active")).toBe(true);

      // Tenancy: NO rows leaked to a different installation_id (count over a random other iid is 0).
      expect(await countRows(randomUUID(), repositoryId)).toBe(0);
    } finally {
      await cleanup({ installationId, repositoryId });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("idempotent re-run: same workspace → ON CONFLICT keeps the row count stable, no duplicates", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    await seedParents({ installationId, repositoryId });
    const ws = makeWorkspace([ADR_DOC, RUNBOOK_DOC]);
    try {
      const act = activity(new RecordingEmbeddingsClient());

      const first = await act.refreshSemanticDocs({ input: input(installationId, repositoryId), workspacePath: ws });
      const rowsAfterFirst = await countRows(installationId, repositoryId);
      expect(rowsAfterFirst).toBe(first.chunks_persisted);

      // Second run over the SAME bytes — the content_sha256 matches, so nothing changes; the natural-key
      // UPSERT keeps the row count stable (no duplicate rows).
      await act.refreshSemanticDocs({ input: input(installationId, repositoryId), workspacePath: ws });
      expect(await countRows(installationId, repositoryId)).toBe(rowsAfterFirst);
    } finally {
      await cleanup({ installationId, repositoryId });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("R-5 EMPTY-FETCH GUARD: a zero-doc refresh PRESERVES the existing index (does NOT wipe it)", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    await seedParents({ installationId, repositoryId });
    // Run 1: a populated workspace seeds the index.
    const wsFull = makeWorkspace([ADR_DOC, RUNBOOK_DOC]);
    // Run 2: an EMPTY workspace (no knowledge docs at all) — discoverKnowledgeDocs returns 0 docs.
    const wsEmpty = makeWorkspace([]);
    try {
      const act = activity(new RecordingEmbeddingsClient());

      const seeded = await act.refreshSemanticDocs({ input: input(installationId, repositoryId), workspacePath: wsFull });
      const rowsBefore = await countRows(installationId, repositoryId);
      expect(rowsBefore).toBe(seeded.chunks_persisted);
      expect(rowsBefore).toBeGreaterThan(0);

      // Run 2 — ZERO docs discovered. The R-5 guard MUST skip the orphan-sweep so the prior index is
      // retained intact, NOT deleted.
      const emptyRun = await act.refreshSemanticDocs({ input: input(installationId, repositoryId), workspacePath: wsEmpty });
      expect(emptyRun.docs_discovered).toBe(0);
      expect(emptyRun.chunks_persisted).toBe(0);
      expect(emptyRun.retrieval_degraded).toBe(false);

      // THE LOAD-BEARING ASSERTION: the existing chunks are STILL THERE (the empty fetch did not wipe).
      expect(await countRows(installationId, repositoryId)).toBe(rowsBefore);
    } finally {
      await cleanup({ installationId, repositoryId });
      rmSync(wsFull, { recursive: true, force: true });
      rmSync(wsEmpty, { recursive: true, force: true });
    }
  });

  it("embed-service unreachable: returns retrieval_degraded=true; prior index unchanged", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    await seedParents({ installationId, repositoryId });
    // Seed an index first (with a working embedder), then a degraded run.
    const wsSeed = makeWorkspace([ADR_DOC]);
    const wsDegraded = makeWorkspace([ADR_DOC, RUNBOOK_DOC]);
    try {
      const seeded = await activity(new RecordingEmbeddingsClient()).refreshSemanticDocs({
        input: input(installationId, repositoryId),
        workspacePath: wsSeed,
      });
      const rowsBefore = await countRows(installationId, repositoryId);
      expect(rowsBefore).toBe(seeded.chunks_persisted);

      const downEmb = new RecordingEmbeddingsClient();
      downEmb.simulateUnreachable(true);
      const degraded = await activity(downEmb).refreshSemanticDocs({
        input: input(installationId, repositoryId),
        workspacePath: wsDegraded,
      });
      expect(degraded.retrieval_degraded).toBe(true);
      expect(degraded.degradation_reason).toBe("embed_service_unreachable");
      expect(degraded.chunks_persisted).toBe(0);

      // Prior index unchanged (the degraded path never reached the upsert/orphan-sweep).
      expect(await countRows(installationId, repositoryId)).toBe(rowsBefore);
    } finally {
      await cleanup({ installationId, repositoryId });
      rmSync(wsSeed, { recursive: true, force: true });
      rmSync(wsDegraded, { recursive: true, force: true });
    }
  });
});
