// Real-DB end-to-end integration test for `upsert_chunks_activity` — wires the ConfluenceSyncActivities
// holder to the REAL PostgresConfluenceChunksRepo + PostgresConfluencePageApprovalsRepo +
// PoolExistingChunkRowsReader against the DISPOSABLE Postgres
// (postgresql://postgres:postgres@localhost:5434/codemaster).
//
// Runs ONLY when CODEMASTER_PG_CORE_DSN is set (the shared describeDb gate); SKIPS otherwise. NEVER
// touches the in-cluster DB; every seeded row is scoped to a unique test space_key and cleaned up.
//
// Coverage:
//  - a non-default chunk persists end-to-end (the real ON CONFLICT UPSERT writes the row).
//  - a 'default'-labeled page with an ACTIVE approval persists + the default_approval JSONB round-trips.
//  - a 'default'-labeled page with NO approval is rejected (rejected_no_approval) and writes nothing.
//  - quarantine recompute persists quarantined=true + sorted reasons (biconditional CHECK satisfied).

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import {
  ConfluenceSyncActivities,
  PoolExistingChunkRowsReader,
} from "#backend/activities/confluence_sync.activity.js";

import { RecordingEmbeddingsClient } from "#backend/adapters/embeddings_port.js";
import { PostgresConfluenceChunksRepo, makeChunkId } from "#backend/domain/repos/confluence_chunks_repo.js";
import { PostgresConfluencePageApprovalsRepo } from "#backend/domain/repos/confluence_page_approvals_repo.js";

import { WallClock } from "#platform/clock.js";
import { disposeAllPools, getPool, tenantKysely } from "#platform/db/database.js";

import { type DefaultApprovalV1 } from "#contracts/page_approval.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const TEST_SPACE = `ZZINTTEST_UPSERT_${process.pid}`;

function vec1024(seed: number): Array<number> {
  return Array.from({ length: 1024 }, (_, i) => (seed + i) / 100000);
}

/** A narrow approvals-reader adapter that maps the repo's full read shape onto the activity port. */
function approvalsPort(repo: PostgresConfluencePageApprovalsRepo): {
  getActiveApproval(args: { spaceKey: string; pageId: string }): Promise<DefaultApprovalV1 | null>;
} {
  return {
    async getActiveApproval(args) {
      const row = await repo.getActiveApproval(args);
      if (row === null) return null;
      // Project the read shape onto DefaultApprovalV1 (1:1 with the Python get_active_approval → DefaultApprovalV1).
      return {
        schema_version: 1,
        approver_email: row.approver_email,
        approved_at_utc: row.approved_at_utc,
        approval_artifact_url: row.approval_artifact_url,
        scope_justification: row.scope_justification,
        default_scope: row.default_scope,
      };
    },
  };
}

function makeChunkInput(args: { chunkIndex: number; tokenCount?: number }): {
  schema_version: 1;
  chunk_id: string;
  chunk_index: number;
  body: string;
  content_sha256: string;
  heading_path: Array<string>;
  token_count: number;
  embedding: Array<number>;
  bedrock_reused_from_cache: boolean;
} {
  return {
    schema_version: 1,
    chunk_id: makeChunkId({ spaceKey: TEST_SPACE, pageId: "p1", version: 1, chunkIndex: args.chunkIndex }),
    chunk_index: args.chunkIndex,
    body: '<doc trust="untrusted">hello</doc>',
    content_sha256: "a".repeat(64),
    heading_path: [],
    token_count: args.tokenCount ?? 10,
    embedding: vec1024(1),
    bedrock_reused_from_cache: false,
  };
}

describeDb("upsert_chunks_activity end-to-end (integration)", () => {
  const dsn = INTEGRATION_DSN as string;
  const pool = getPool(dsn);
  const db = tenantKysely<unknown>(dsn);
  const chunksRepo = new PostgresConfluenceChunksRepo({ db, clock: new WallClock() });
  const approvalsRepo = new PostgresConfluencePageApprovalsRepo({ db });

  const acts = new ConfluenceSyncActivities({
    client: { listPages: async () => ({ items: [], next_cursor: null }), getPage: async () => ({}) },
    embeddings: new RecordingEmbeddingsClient(),
    modelName: "qwen3-embed-0.6b",
    chunkEmbeddingLookup: chunksRepo,
    chunksWriter: chunksRepo,
    approvalsReader: approvalsPort(approvalsRepo),
    existingChunkRowsReader: new PoolExistingChunkRowsReader({ dsn }),
  });

  const cleanup = async (): Promise<void> => {
    await pool.query("DELETE FROM core.confluence_chunks WHERE space_key = $1", [TEST_SPACE]);
    await pool.query("DELETE FROM core.confluence_page_approvals WHERE space_key = $1", [TEST_SPACE]);
  };

  const baseInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    schema_version: 1,
    space_key: TEST_SPACE,
    page_id: "p1",
    page_title: "A Page",
    page_status: "active",
    page_version: 1,
    last_modified_at: "2026-05-01T00:00:00+00:00",
    raw_labels: [],
    injection_flags: [],
    chunks: [makeChunkInput({ chunkIndex: 0 })],
    ...overrides,
  });

  beforeAll(async () => {
    await pool.query("SELECT 1 FROM core.confluence_chunks WHERE false");
    await cleanup();
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await disposeAllPools();
  });

  it("persists a non-default chunk end-to-end against the real repo", async () => {
    const out = await acts.upsertChunks(baseInput() as never);
    expect(out.upserted).toBe(1);

    const r = await pool.query(
      "SELECT page_id, chunk_index, redaction_applied FROM core.confluence_chunks WHERE space_key = $1",
      [TEST_SPACE],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].page_id).toBe("p1");
    expect(r.rows[0].redaction_applied).toBe(true);
  });

  it("rejects a 'default'-labeled page with NO active approval (writes nothing)", async () => {
    const out = await acts.upsertChunks(baseInput({ raw_labels: ["default"] }) as never);
    expect(out.upserted).toBe(0);
    expect(out.rejected_no_approval).toBe(1);

    const r = await pool.query("SELECT count(*)::int AS n FROM core.confluence_chunks WHERE space_key = $1", [
      TEST_SPACE,
    ]);
    expect(r.rows[0].n).toBe(0);
  });

  it("persists a 'default'-labeled page WHEN an active approval exists, round-tripping default_approval", async () => {
    // Seed the approval via the real repo (actorEmail is session-derived per audit P0-1).
    await approvalsRepo.upsertApproval(
      {
        schema_version: 1,
        space_key: TEST_SPACE,
        page_id: "p1",
        approved_at_utc: "2026-05-01T00:00:00+00:00",
        approval_artifact_url: "https://wiki.example.com/approval/1",
        scope_justification: "Approved for universal default scope by the platform team.",
        default_scope: "universal",
      },
      { actorEmail: "approver@example.com" },
    );

    const out = await acts.upsertChunks(baseInput({ raw_labels: ["default"] }) as never);
    expect(out.upserted).toBe(1);

    const r = await pool.query(
      "SELECT labels, default_approval FROM core.confluence_chunks WHERE space_key = $1",
      [TEST_SPACE],
    );
    expect(r.rows[0].labels).toEqual(["default"]);
    expect(r.rows[0].default_approval.approver_email).toBe("approver@example.com");
    expect(r.rows[0].default_approval.default_scope).toBe("universal");
    // REGRESSION (adversarial-review HIGH): the persisted JSONB must be the 6-field DefaultApprovalV1, NOT
    // the full 12-field ConfluencePageApprovalV1 the repo returns — no approval_id / space_key / page_id /
    // revoked_at / revoked_by / created_at / updated_at may leak to disk (the column's .strict() contract).
    expect(Object.keys(r.rows[0].default_approval).sort()).toEqual([
      "approval_artifact_url",
      "approved_at_utc",
      "approver_email",
      "default_scope",
      "schema_version",
      "scope_justification",
    ]);
  });

  it("persists quarantine recompute (quarantined=true + sorted reasons, biconditional CHECK satisfied)", async () => {
    const out = await acts.upsertChunks(
      baseInput({ injection_flags: ["role_override", "hidden_directive"] }) as never,
    );
    expect(out.upserted).toBe(1);
    expect(out.quarantined).toBe(true);

    const r = await pool.query(
      "SELECT quarantined, quarantine_reasons FROM core.confluence_chunks WHERE space_key = $1",
      [TEST_SPACE],
    );
    expect(r.rows[0].quarantined).toBe(true);
    expect(r.rows[0].quarantine_reasons).toEqual(["hidden_directive", "role_override"]);
  });
});
