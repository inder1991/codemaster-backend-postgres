// Unit tests for the ConfluenceSyncActivities holder — the 1:1 TS port of the frozen Python
// vendor/codemaster-py/codemaster/activities/confluence_sync.py (Sub-spec A T11).
//
// These are PURE unit tests: the client / repos / embeddings / hard-limit row-fetcher are stubbed so
// each activity is exercised by a DIRECT method call (no Temporal, no DB). They lock the byte-faithful
// behaviours the Python source defines:
//   - chunk_and_embed: idempotency-skip-on-hit (audit P0-4 — no Bedrock call when (chunk_id, sha) is
//     already stored) + embeds-on-miss; redactor wraps each chunk in <doc trust="untrusted">.
//   - upsert_chunks: per-space chunk-cap rejection, platform-token-cap rejection, page-approval gating
//     (default-tagged page with no active approval is rejected), label-allowlist intersection, and the
//     quarantine recompute (injection_flags → quarantined + reasons).
//   - reconcile_deletions: delegates to the repo soft-delete.
//   - sanitize_page / fetch_space_pages / fetch_page_body: happy paths.

import { describe, expect, it } from "vitest";

import {
  ConfluenceSyncActivities,
  type ChunkEmbeddingLookup,
  type ConfluenceChunkClient,
  type ConfluenceChunksWriter,
  type EmbedderCacheForDualWrite,
  type ExistingChunkRowsReader,
  type PageApprovalsReader,
} from "#backend/activities/confluence_sync.activity.js";

import {
  type EmbeddingsPort,
  type EmbedRequest,
  type EmbedResult,
  EmbeddingsValidationError,
} from "#backend/adapters/embeddings_port.js";
import { type ConfluenceChunkRow } from "#backend/ingest/confluence/hard_limits.js";

import { type ChunkAndEmbedInputV1 } from "#contracts/confluence_sync.v1.js";
import { type DefaultApprovalV1 } from "#contracts/page_approval.v1.js";

// ─── Stubs ───────────────────────────────────────────────────────────────────────────────────────

const MODEL = "qwen3-embed-0.6b";

/** Deterministic 1024-dim vector so the EmbeddedChunkV1 contract (min/max 1024) validates. */
function vec1024(seed: number): Array<number> {
  return Array.from({ length: 1024 }, (_, i) => (seed + i) / 100000);
}

class StubEmbeddings implements EmbeddingsPort {
  public readonly calls: Array<EmbedRequest> = [];
  public failValidationOnce = false;
  public async embed(req: EmbedRequest): Promise<EmbedResult> {
    this.calls.push(req);
    if (this.failValidationOnce) {
      this.failValidationOnce = false;
      throw new EmbeddingsValidationError("simulated context-window overflow");
    }
    return {
      vectors: req.texts.map((_, i) => vec1024(i + 1)),
      model_name: req.model_name,
      model_version: "test-v1",
      cache_hits: 0,
    };
  }
}

class StubClient implements ConfluenceChunkClient {
  public listPagesCalls: Array<{ spaceKey: string; cursor: string | null }> = [];
  public getPageCalls: Array<{ pageId: string; spaceKey: string | null }> = [];
  // pages keyed by cursor (null = first page); each entry returns { items, nextCursor }.
  public constructor(
    private readonly pagesByCursor: ReadonlyArray<{
      items: ReadonlyArray<{ page_id: string; version: number }>;
      next_cursor: string | null;
    }>,
  ) {}
  public async listPages(args: { spaceKey: string; cursor?: string | null }): Promise<{
    items: ReadonlyArray<{ page_id: string; version: number }>;
    next_cursor: string | null;
  }> {
    this.listPagesCalls.push({ spaceKey: args.spaceKey, cursor: args.cursor ?? null });
    const idx = this.listPagesCalls.length - 1;
    return this.pagesByCursor[idx]!;
  }
  public async getPage(args: { pageId: string; spaceKey?: string | null }): Promise<unknown> {
    this.getPageCalls.push({ pageId: args.pageId, spaceKey: args.spaceKey ?? null });
    return {
      schema_version: 2,
      page_id: args.pageId,
      space_key: args.spaceKey ?? "ENG",
      title: "A Page",
      version: 1,
      body_html: "<p>Hello world</p>",
      last_modified_at: "2026-05-01T00:00:00+00:00",
      labels: [],
      status: "active",
    };
  }
}

class StubLookups implements ChunkEmbeddingLookup {
  // chunkId -> stored embedding for the (chunkId, sha) idempotency check.
  public hits = new Map<string, { sha: string; embedding: ReadonlyArray<number> }>();
  public lookups: Array<{ chunkId: string; contentSha256: string }> = [];
  public async findExistingChunkEmbedding(args: {
    chunkId: string;
    contentSha256: string;
  }): Promise<ReadonlyArray<number> | null> {
    this.lookups.push(args);
    const hit = this.hits.get(args.chunkId);
    if (hit !== undefined && hit.sha === args.contentSha256) {
      return hit.embedding;
    }
    return null;
  }
}

class StubWriter implements ConfluenceChunksWriter {
  public upsertCalls: Array<{ rowsCount: number }> = [];
  public lastRows: ReadonlyArray<unknown> = [];
  public async upsertChunks(rows: ReadonlyArray<unknown>): Promise<number> {
    this.upsertCalls.push({ rowsCount: rows.length });
    this.lastRows = rows;
    return rows.length;
  }
  public async reconcileDeletions(args: {
    spaceKey: string;
    livePageIds: ReadonlyArray<string>;
  }): Promise<number> {
    void args;
    return 0;
  }
}

class StubApprovals implements PageApprovalsReader {
  public approvals = new Map<string, DefaultApprovalV1>();
  public async getActiveApproval(args: {
    spaceKey: string;
    pageId: string;
  }): Promise<DefaultApprovalV1 | null> {
    return this.approvals.get(`${args.spaceKey}/${args.pageId}`) ?? null;
  }
}

class StubExistingRows implements ExistingChunkRowsReader {
  public constructor(private readonly rows: ReadonlyArray<ConfluenceChunkRow>) {}
  public async listChunkRowsForLimits(): Promise<ReadonlyArray<ConfluenceChunkRow>> {
    return this.rows;
  }
}

function buildActivities(opts: {
  embeddings?: StubEmbeddings;
  client?: StubClient;
  lookups?: StubLookups;
  writer?: StubWriter;
  approvals?: StubApprovals;
  existingRows?: StubExistingRows;
} = {}): {
  acts: ConfluenceSyncActivities;
  embeddings: StubEmbeddings;
  client: StubClient;
  lookups: StubLookups;
  writer: StubWriter;
  approvals: StubApprovals;
} {
  const embeddings = opts.embeddings ?? new StubEmbeddings();
  const client = opts.client ?? new StubClient([{ items: [], next_cursor: null }]);
  const lookups = opts.lookups ?? new StubLookups();
  const writer = opts.writer ?? new StubWriter();
  const approvals = opts.approvals ?? new StubApprovals();
  const existingRows = opts.existingRows ?? new StubExistingRows([]);
  const acts = new ConfluenceSyncActivities({
    client,
    embeddings,
    modelName: MODEL,
    chunkEmbeddingLookup: lookups,
    chunksWriter: writer,
    approvalsReader: approvals,
    existingChunkRowsReader: existingRows,
  });
  return { acts, embeddings, client, lookups, writer, approvals };
}

// A sanitized-page input the chunker turns into ≥1 chunk.
function sanitizedInput(body: string): ChunkAndEmbedInputV1 {
  return {
    schema_version: 1,
    sanitized: {
      schema_version: 1,
      page_id: "p1",
      space_key: "ENG",
      version: 1,
      title: "A Page",
      body,
      labels: [],
      injection_flags: [],
      status: "active",
      last_modified_at: "2026-05-01T00:00:00+00:00",
      pattern_set_version: 1,
    },
  };
}

describe("ConfluenceSyncActivities.fetchSpacePages", () => {
  it("paginates via cursor and returns all PageRefs", async () => {
    const client = new StubClient([
      { items: [{ page_id: "a", version: 1 }, { page_id: "b", version: 2 }], next_cursor: "CUR1" },
      { items: [{ page_id: "c", version: 3 }], next_cursor: null },
    ]);
    const { acts } = buildActivities({ client });
    const out = await acts.fetchSpacePages({ schema_version: 1, space_key: "ENG" });
    expect(out.pages.map((p) => p.page_id)).toEqual(["a", "b", "c"]);
    expect(client.listPagesCalls.map((c) => c.cursor)).toEqual([null, "CUR1"]);
  });
});

describe("ConfluenceSyncActivities.fetchPageBody", () => {
  it("fetches one page and returns it", async () => {
    const { acts, client } = buildActivities();
    const out = await acts.fetchPageBody({ schema_version: 1, page_id: "p9", space_key: "ENG" });
    expect(out.page.page_id).toBe("p9");
    expect(client.getPageCalls).toEqual([{ pageId: "p9", spaceKey: "ENG" }]);
  });
});

describe("ConfluenceSyncActivities.sanitizePage", () => {
  it("sanitizes a raw page body and strips disallowed tags", async () => {
    const { acts } = buildActivities();
    const out = await acts.sanitizePage({
      schema_version: 1,
      page: {
        schema_version: 2,
        page_id: "p1",
        space_key: "ENG",
        title: "A Page",
        version: 1,
        body_html: "<p>Keep me</p><script>alert(1)</script>",
        last_modified_at: "2026-05-01T00:00:00+00:00",
        labels: [],
        status: "active",
      },
      last_modified_at: "2026-05-01T00:00:00+00:00",
    });
    // Disallowed <script> tag is discarded (text kept per bleach nonTextTags:[] parity), <p> kept.
    expect(out.sanitized.body).toContain("Keep me");
    expect(out.sanitized.body).not.toContain("<script>");
  });
});

describe("ConfluenceSyncActivities.chunkAndEmbed", () => {
  it("embeds on a cache MISS and wraps each chunk body in the trust tag", async () => {
    const { acts, embeddings } = buildActivities();
    const out = await acts.chunkAndEmbed(sanitizedInput("Hello world. This is a doc."));
    expect(out.chunks.length).toBeGreaterThanOrEqual(1);
    // Embedded → exactly one batch embed call was issued (cache miss).
    expect(embeddings.calls.length).toBe(1);
    for (const c of out.chunks) {
      expect(c.bedrock_reused_from_cache).toBe(false);
      expect(c.body.startsWith('<doc trust="untrusted">')).toBe(true);
      expect(c.body.endsWith("</doc>")).toBe(true);
      expect(c.embedding).toHaveLength(1024);
      expect(c.content_sha256).toHaveLength(64);
    }
  });

  it("SKIPS the embed call on a cache HIT (audit P0-4 idempotency, no double-billing)", async () => {
    // First pass to learn the deterministic chunk_id + sha the activity computes.
    const probe = buildActivities();
    const first = await probe.acts.chunkAndEmbed(sanitizedInput("Hello world. This is a doc."));
    expect(first.chunks.length).toBeGreaterThanOrEqual(1);

    // Seed the lookup so EVERY produced chunk is a cache hit.
    const lookups = new StubLookups();
    for (const c of first.chunks) {
      lookups.hits.set(c.chunk_id, { sha: c.content_sha256, embedding: vec1024(42) });
    }
    const { acts, embeddings } = buildActivities({ lookups });
    const out = await acts.chunkAndEmbed(sanitizedInput("Hello world. This is a doc."));
    expect(embeddings.calls.length).toBe(0); // NO Bedrock call — all reused.
    for (const c of out.chunks) {
      expect(c.bedrock_reused_from_cache).toBe(true);
    }
  });

  it("returns no chunks for an empty body", async () => {
    const { acts, embeddings } = buildActivities();
    const out = await acts.chunkAndEmbed(sanitizedInput(""));
    expect(out.chunks).toEqual([]);
    expect(embeddings.calls.length).toBe(0);
  });
});

describe("ConfluenceSyncActivities.upsertChunks", () => {
  const oneChunk = {
    schema_version: 1 as const,
    chunk_id: "987f2e77-33cd-5198-aa6e-cf41925e4d37",
    chunk_index: 0,
    body: '<doc trust="untrusted">x</doc>',
    content_sha256: "a".repeat(64),
    heading_path: [],
    token_count: 100,
    embedding: vec1024(1),
    bedrock_reused_from_cache: false,
  };

  function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema_version: 1,
      space_key: "ENG",
      page_id: "p1",
      page_title: "A Page",
      page_status: "active",
      page_version: 1,
      last_modified_at: "2026-05-01T00:00:00+00:00",
      raw_labels: [],
      injection_flags: [],
      chunks: [oneChunk],
      ...overrides,
    };
  }

  it("upserts a non-default chunk without needing an approval", async () => {
    const { acts, writer } = buildActivities();
    const out = await acts.upsertChunks(baseInput() as never);
    expect(out.upserted).toBe(1);
    expect(out.rejected_no_approval).toBe(0);
    expect(out.rejected_default_cap).toBe(0);
    expect(writer.upsertCalls).toHaveLength(1);
  });

  it("rejects a 'default'-labeled page with NO active approval", async () => {
    const { acts, writer } = buildActivities();
    const out = await acts.upsertChunks(baseInput({ raw_labels: ["default"] }) as never);
    expect(out.upserted).toBe(0);
    expect(out.rejected_no_approval).toBe(1);
    expect(writer.upsertCalls).toHaveLength(0); // never reached the writer
  });

  it("upserts a 'default'-labeled page WHEN an active approval exists", async () => {
    const approvals = new StubApprovals();
    approvals.approvals.set("ENG/p1", {
      schema_version: 1,
      approver_email: "approver@example.com",
      approved_at_utc: "2026-05-01T00:00:00+00:00",
      approval_artifact_url: "https://wiki.example.com/a/1",
      scope_justification: "Approved for universal default scope by the platform team.",
      default_scope: "universal",
    });
    const { acts, writer } = buildActivities({ approvals });
    const out = await acts.upsertChunks(baseInput({ raw_labels: ["default"] }) as never);
    expect(out.upserted).toBe(1);
    expect(writer.upsertCalls).toHaveLength(1);
  });

  it("PROJECTS the approval to the 6-field DefaultApprovalV1 even when the reader yields the full row (adversarial-review HIGH regression)", async () => {
    // The PRODUCTION wiring passes the PostgresConfluencePageApprovalsRepo DIRECTLY, whose getActiveApproval
    // yields the FULL 12-field ConfluencePageApprovalV1 (TS structural subtyping lets it satisfy the
    // DefaultApprovalV1 port). The activity MUST re-project to exactly the 6 stored keys (1:1 with the Python
    // DefaultApprovalV1(...) construction) so no approval_id/space_key/page_id/revoked_*/*_at leaks to disk.
    const approvals = new StubApprovals();
    approvals.approvals.set("ENG/p1", {
      schema_version: 1,
      approval_id: "11111111-1111-4111-8111-111111111111",
      space_key: "ENG",
      page_id: "p1",
      approver_email: "approver@example.com",
      approved_at_utc: "2026-05-01T00:00:00+00:00",
      approval_artifact_url: "https://wiki.example.com/a/1",
      scope_justification: "Approved for universal default scope by the platform team.",
      default_scope: "universal",
      revoked_at: null,
      revoked_by: null,
      created_at: "2026-05-01T00:00:00+00:00",
      updated_at: "2026-05-01T00:00:00+00:00",
    } as unknown as DefaultApprovalV1);
    const { acts, writer } = buildActivities({ approvals });
    await acts.upsertChunks(baseInput({ raw_labels: ["default"] }) as never);
    expect(writer.upsertCalls).toHaveLength(1);
    const row = writer.lastRows[0] as { defaultApproval: Record<string, unknown> };
    expect(Object.keys(row.defaultApproval).sort()).toEqual([
      "approval_artifact_url",
      "approved_at_utc",
      "approver_email",
      "default_scope",
      "schema_version",
      "scope_justification",
    ]);
  });

  it("rejects a default page when the per-space chunk cap would be exceeded", async () => {
    // 25 existing default chunks in ENG (the FALLBACK_MAX_PER_SPACE cap) + 1 new = 26 > 25.
    const existing: Array<ConfluenceChunkRow> = Array.from({ length: 25 }, () => ({
      space_key: "ENG",
      labels: ["default"],
      deleted_at: null,
      token_count: 1,
    }));
    const approvals = new StubApprovals();
    approvals.approvals.set("ENG/p1", {
      schema_version: 1,
      approver_email: "approver@example.com",
      approved_at_utc: "2026-05-01T00:00:00+00:00",
      approval_artifact_url: "https://wiki.example.com/a/1",
      scope_justification: "Approved for universal default scope by the platform team.",
      default_scope: "universal",
    });
    const { acts, writer } = buildActivities({
      approvals,
      existingRows: new StubExistingRows(existing),
    });
    const out = await acts.upsertChunks(baseInput({ raw_labels: ["default"] }) as never);
    expect(out.upserted).toBe(0);
    expect(out.rejected_default_cap).toBe(1);
    expect(writer.upsertCalls).toHaveLength(0);
  });

  it("recomputes quarantine from injection_flags (quarantined=true + sorted reasons)", async () => {
    const { acts, writer } = buildActivities();
    const out = await acts.upsertChunks(
      baseInput({ injection_flags: ["role_override", "hidden_directive"] }) as never,
    );
    expect(out.quarantined).toBe(true);
    expect(out.upserted).toBe(1);
    const row = writer.lastRows[0] as { quarantined: boolean; quarantineReasons: ReadonlyArray<string> };
    expect(row.quarantined).toBe(true);
    expect([...row.quarantineReasons]).toEqual(["hidden_directive", "role_override"]); // sorted
  });

  it("intersects raw_labels with the platform allowlist (F-48): an off-list 'default' string is NOT a default decision", async () => {
    // 'definitely-not-default' is off-list, so even though it contains substring matching is irrelevant;
    // a raw label that is not exactly 'default' (after allowlist intersection) does not gate on approval.
    const { acts, writer } = buildActivities();
    const out = await acts.upsertChunks(
      baseInput({ raw_labels: ["lang:python", "not-a-real-platform-label"] }) as never,
    );
    expect(out.upserted).toBe(1); // no approval required (no 'default' in effective labels)
    expect(writer.upsertCalls).toHaveLength(1);
  });

  // ── SCOPE-A dual-write wiring ──────────────────────────────────────────────────────────────────

  /** An opts-capturing writer (the shared StubWriter discards the 2nd arg; here we capture it). */
  class OptsCapturingWriter implements ConfluenceChunksWriter {
    public lastOpts: { activeGeneration?: number | null; activeModelName?: string | null } | undefined;
    public async upsertChunks(
      rows: ReadonlyArray<unknown>,
      opts?: { activeGeneration?: number | null; activeModelName?: string | null },
    ): Promise<number> {
      this.lastOpts = opts;
      return rows.length;
    }
    public async reconcileDeletions(): Promise<number> {
      return 0;
    }
  }

  /** A fake EmbedderCache pinned to a gen + model; counts refresh() calls. */
  class FakeDualWriteCache implements EmbedderCacheForDualWrite {
    public refreshes = 0;
    public constructor(
      private readonly gen: number,
      private readonly model: string,
    ) {}
    public getActiveGeneration(): number {
      return this.gen;
    }
    public getActiveModelName(): string {
      return this.model;
    }
    public async refresh(): Promise<void> {
      this.refreshes += 1;
    }
  }

  it("WITH an EmbedderCache wired: upsert receives {activeGeneration, activeModelName} (refresh awaited)", async () => {
    const writer = new OptsCapturingWriter();
    const cache = new FakeDualWriteCache(42, "mxbai-embed-large-v1");
    const acts = new ConfluenceSyncActivities({
      client: new StubClient([{ items: [], next_cursor: null }]),
      embeddings: new StubEmbeddings(),
      modelName: MODEL,
      chunkEmbeddingLookup: new StubLookups(),
      chunksWriter: writer,
      approvalsReader: new StubApprovals(),
      existingChunkRowsReader: new StubExistingRows([]),
      embedderCache: cache,
    });
    const out = await acts.upsertChunks(baseInput() as never);
    expect(out.upserted).toBe(1);
    expect(cache.refreshes).toBe(1); // lazy-TTL refresh awaited once per batch
    expect(writer.lastOpts).toEqual({ activeGeneration: 42, activeModelName: "mxbai-embed-large-v1" });
  });

  it("WITHOUT an EmbedderCache (default): upsert receives EMPTY opts (legacy-only, SAFE-DEFAULT)", async () => {
    const writer = new OptsCapturingWriter();
    const acts = new ConfluenceSyncActivities({
      client: new StubClient([{ items: [], next_cursor: null }]),
      embeddings: new StubEmbeddings(),
      modelName: MODEL,
      chunkEmbeddingLookup: new StubLookups(),
      chunksWriter: writer,
      approvalsReader: new StubApprovals(),
      existingChunkRowsReader: new StubExistingRows([]),
      // embedderCache omitted → no dual-write.
    });
    const out = await acts.upsertChunks(baseInput() as never);
    expect(out.upserted).toBe(1);
    expect(writer.lastOpts).toEqual({}); // no activeGeneration / activeModelName → repo writes legacy only
  });
});

describe("ConfluenceSyncActivities.reconcileDeletions", () => {
  it("delegates to the repo soft-delete and returns the count", async () => {
    const writer = new StubWriter();
    writer.reconcileDeletions = async (args: {
      spaceKey: string;
      livePageIds: ReadonlyArray<string>;
    }): Promise<number> => {
      expect(args.spaceKey).toBe("ENG");
      expect([...args.livePageIds]).toEqual(["a", "b"]);
      return 3;
    };
    const { acts } = buildActivities({ writer });
    const out = await acts.reconcileDeletions({
      schema_version: 1,
      space_key: "ENG",
      live_page_ids: ["a", "b"],
    });
    expect(out.soft_deleted).toBe(3);
  });
});
