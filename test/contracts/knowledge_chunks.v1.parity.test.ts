import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  KnowledgeChunkV1,
  KnowledgeQueryV1,
  RetrievedKnowledgeV1,
  ScoredKnowledgeChunkV1,
} from "../../libs/contracts/src/knowledge_chunks.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Follows the embed_query / aggregated_findings
// template.
const PY = "contracts.knowledge_chunks.v1";

// Lowercase UUIDs — Pydantic dumps UUIDs lowercase, so the payloads must be lowercase for a byte-equal
// canonical compare.
const CID = "00000000-0000-0000-0000-000000000001";
const IID = "00000000-0000-0000-0000-000000000002";
const RID = "00000000-0000-0000-0000-000000000003";

// BARE-FLOAT columns that the repo canonicalizer (test/parity/canonical.ts) rejects. They cannot
// byte-round-trip (Python emits `0.0` / `0.15`; JS emits `0`), so strip them — including nested copies
// inside chunk/items — before the canonical diff, then assert them structurally + range-reject
// separately.
type Rec = Record<string, unknown>;

function stripChunkFloats(chunk: unknown): unknown {
  if (chunk && typeof chunk === "object") {
    const c = { ...(chunk as Rec) };
    delete c.age_days;
    return c;
  }
  return chunk;
}

function stripScoredFloats(scored: unknown): unknown {
  if (scored && typeof scored === "object") {
    const s = { ...(scored as Rec) };
    delete s.score;
    s.chunk = stripChunkFloats(s.chunk);
    return s;
  }
  return scored;
}

// Re-canonicalize a parsed/oracle object after dropping every float column it carries so both sides
// run through the identical key-sort + scalar rules.
function stripFloats(o: unknown): string {
  const obj = { ...(o as Rec) };
  // KnowledgeChunkV1 shape.
  if ("age_days" in obj) delete obj.age_days;
  // KnowledgeQueryV1 shape.
  if ("query_vector_override" in obj) delete obj.query_vector_override;
  if ("default_pool_token_reservation_pct" in obj) delete obj.default_pool_token_reservation_pct;
  // ScoredKnowledgeChunkV1 shape.
  if ("score" in obj) {
    delete obj.score;
    if ("chunk" in obj) obj.chunk = stripChunkFloats(obj.chunk);
  } else if ("chunk" in obj) {
    obj.chunk = stripChunkFloats(obj.chunk);
  }
  // RetrievedKnowledgeV1 shape.
  if (Array.isArray(obj.items)) obj.items = obj.items.map(stripScoredFloats);
  return canonicalize(obj);
}

describe("KnowledgeChunkV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (age_days float excepted)", async () => {
    const payload = {
      schema_version: 2,
      chunk_id: CID,
      installation_id: IID,
      repo_id: RID,
      relative_path: "docs/adr/0001.md",
      chunk_index: 3,
      heading_path: ["Context", "Decision"],
      body: "We will use Postgres for everything.",
      doc_kind: "adr",
      doc_status: "active",
      source: "repo_knowledge",
      space_key: null,
      page_id: null,
      page_version: null,
      labels: ["team:platform", "area:data"],
      match_specificity_score: 5,
      age_days: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeChunkV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = KnowledgeChunkV1.parse(payload);
    expect(stripFloats(parsed)).toBe(stripFloats(JSON.parse(r.out ?? "{}")));
    // age_days round-trips structurally (Zod-parsed value matches what we fed in).
    expect(parsed.age_days).toBe(0);
  }, 30_000);

  it("applies all the same defaults when optional fields omitted", async () => {
    const payload = {
      chunk_id: CID,
      installation_id: IID,
      repo_id: RID,
      relative_path: "a.md",
      chunk_index: 0,
      body: "x",
      doc_kind: "other",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeChunkV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = KnowledgeChunkV1.parse(payload);
    expect(stripFloats(parsed)).toBe(stripFloats(JSON.parse(r.out ?? "{}")));
    // Defaults: schema_version=2, heading_path=[], doc_status=active, source=repo_knowledge,
    // labels=[], match_specificity_score=0, age_days=0.
    expect(parsed.schema_version).toBe(2);
    expect(parsed.heading_path).toEqual([]);
    expect(parsed.doc_status).toBe("active");
    expect(parsed.source).toBe("repo_knowledge");
    expect(parsed.labels).toEqual([]);
    expect(parsed.match_specificity_score).toBe(0);
    expect(parsed.age_days).toBe(0);
  }, 30_000);

  it("accepts a forward schema_version (int default, NOT z.literal)", async () => {
    const payload = {
      schema_version: 3,
      chunk_id: CID,
      installation_id: IID,
      repo_id: RID,
      relative_path: "a.md",
      chunk_index: 0,
      body: "x",
      doc_kind: "rfc",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeChunkV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(stripFloats(KnowledgeChunkV1.parse(payload))).toBe(stripFloats(JSON.parse(r.out ?? "{}")));
  }, 30_000);

  it("both REJECT a bad UUID (chunk_id)", async () => {
    const bad = {
      chunk_id: "not-a-uuid",
      installation_id: IID,
      repo_id: RID,
      relative_path: "a.md",
      chunk_index: 0,
      body: "x",
      doc_kind: "adr",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeChunkV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => KnowledgeChunkV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an out-of-range value (chunk_index < 0)", async () => {
    const bad = {
      chunk_id: CID,
      installation_id: IID,
      repo_id: RID,
      relative_path: "a.md",
      chunk_index: -1,
      body: "x",
      doc_kind: "adr",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeChunkV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => KnowledgeChunkV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a negative age_days (ge=0.0 range guard, float-stripped from compare)", async () => {
    const bad = {
      chunk_id: CID,
      installation_id: IID,
      repo_id: RID,
      relative_path: "a.md",
      chunk_index: 0,
      body: "x",
      doc_kind: "adr",
      age_days: -1.0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeChunkV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => KnowledgeChunkV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid doc_kind enum value", async () => {
    const bad = {
      chunk_id: CID,
      installation_id: IID,
      repo_id: RID,
      relative_path: "a.md",
      chunk_index: 0,
      body: "x",
      doc_kind: "bogus_kind",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeChunkV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => KnowledgeChunkV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT too many heading_path entries (max_length=3)", async () => {
    const bad = {
      chunk_id: CID,
      installation_id: IID,
      repo_id: RID,
      relative_path: "a.md",
      chunk_index: 0,
      heading_path: ["a", "b", "c", "d"],
      body: "x",
      doc_kind: "adr",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeChunkV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => KnowledgeChunkV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      chunk_id: CID,
      installation_id: IID,
      repo_id: RID,
      relative_path: "a.md",
      chunk_index: 0,
      body: "x",
      doc_kind: "adr",
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeChunkV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => KnowledgeChunkV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("KnowledgeQueryV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (floats excepted)", async () => {
    // effective_labels uses a single element so the frozenset's nondeterministic dump order is
    // order-invariant for the byte-equal compare.
    const payload = {
      schema_version: 2,
      query: "Add caching to the retrieval path",
      installation_id: IID,
      repo_id: RID,
      top_k: 25,
      query_vector_override: [0.1, 0.2, -0.3],
      include_confluence: true,
      effective_labels: ["team:platform"],
      default_pool_token_reservation_pct: 0.15,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeQueryV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = KnowledgeQueryV1.parse(payload);
    expect(stripFloats(parsed)).toBe(stripFloats(JSON.parse(r.out ?? "{}")));
    // The float-bearing columns round-trip structurally.
    expect(parsed.query_vector_override).toEqual([0.1, 0.2, -0.3]);
    expect(parsed.default_pool_token_reservation_pct).toBe(0.15);
  }, 30_000);

  it("applies all the same defaults when optional fields omitted", async () => {
    const payload = { query: "q", installation_id: IID, repo_id: RID };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeQueryV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = KnowledgeQueryV1.parse(payload);
    expect(stripFloats(parsed)).toBe(stripFloats(JSON.parse(r.out ?? "{}")));
    // Defaults: schema_version=2, top_k=10, query_vector_override=null, include_confluence=false,
    // effective_labels=[], default_pool_token_reservation_pct=0.15.
    expect(parsed.schema_version).toBe(2);
    expect(parsed.top_k).toBe(10);
    expect(parsed.query_vector_override).toBeNull();
    expect(parsed.include_confluence).toBe(false);
    expect(parsed.effective_labels).toEqual([]);
    expect(parsed.default_pool_token_reservation_pct).toBe(0.15);
  }, 30_000);

  it("both REJECT a bad UUID (installation_id)", async () => {
    const bad = { query: "q", installation_id: "not-a-uuid", repo_id: RID };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeQueryV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => KnowledgeQueryV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT top_k below the floor (ge=1)", async () => {
    const bad = { query: "q", installation_id: IID, repo_id: RID, top_k: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeQueryV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => KnowledgeQueryV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT top_k above the ceiling (le=100)", async () => {
    const bad = { query: "q", installation_id: IID, repo_id: RID, top_k: 101 };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeQueryV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => KnowledgeQueryV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT default_pool_token_reservation_pct > 1.0 (le=1.0 range guard)", async () => {
    const bad = {
      query: "q",
      installation_id: IID,
      repo_id: RID,
      default_pool_token_reservation_pct: 1.5,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeQueryV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => KnowledgeQueryV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { query: "q", installation_id: IID, repo_id: RID, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeQueryV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => KnowledgeQueryV1.parse(bad)).toThrow();
  }, 30_000);
});

// A representative valid nested KnowledgeChunkV1 payload reused by the scored / retrieved envelopes.
const CHUNK = {
  chunk_id: CID,
  installation_id: IID,
  repo_id: RID,
  relative_path: "docs/adr/0001.md",
  chunk_index: 0,
  body: "We will use Postgres.",
  doc_kind: "adr",
} as const;

describe("ScoredKnowledgeChunkV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (score + nested age_days excepted)", async () => {
    const payload = { schema_version: 1, chunk: CHUNK, score: 0.875, stage: "rrf" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ScoredKnowledgeChunkV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = ScoredKnowledgeChunkV1.parse(payload);
    expect(stripFloats(parsed)).toBe(stripFloats(JSON.parse(r.out ?? "{}")));
    // score round-trips structurally.
    expect(parsed.score).toBe(0.875);
  }, 30_000);

  it("both REJECT an invalid stage enum value", async () => {
    const bad = { chunk: CHUNK, score: 0.5, stage: "bogus_stage" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ScoredKnowledgeChunkV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ScoredKnowledgeChunkV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested chunk (chunk_index < 0 propagates)", async () => {
    const bad = { chunk: { ...CHUNK, chunk_index: -1 }, score: 0.5, stage: "bm25" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ScoredKnowledgeChunkV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ScoredKnowledgeChunkV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { chunk: CHUNK, score: 0.5, stage: "ann", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ScoredKnowledgeChunkV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ScoredKnowledgeChunkV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("RetrievedKnowledgeV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (nested floats excepted)", async () => {
    const payload = {
      schema_version: 1,
      items: [{ chunk: CHUNK, score: 0.9, stage: "rerank" }],
      degraded: true,
      degradation_reason: "ann->bm25 fallback",
      starvation_tiers: ["tier_a", "tier_b"],
      source_counts: { repo: 3, confluence: 2, deduped: 1 },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedKnowledgeV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = RetrievedKnowledgeV1.parse(payload);
    expect(stripFloats(parsed)).toBe(stripFloats(JSON.parse(r.out ?? "{}")));
    // source_counts dict + nested score round-trip structurally.
    expect(parsed.source_counts).toEqual({ repo: 3, confluence: 2, deduped: 1 });
    expect(parsed.items[0]?.score).toBe(0.9);
  }, 30_000);

  it("applies all the same defaults when optional fields omitted (empty items)", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedKnowledgeV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = RetrievedKnowledgeV1.parse(payload);
    // No nested float when items is empty — full byte-equality holds.
    expect(canonicalize(parsed)).toBe(r.out);
    // Defaults: schema_version=1, items=[], degraded=false, degradation_reason="",
    // starvation_tiers=[], source_counts={}.
    expect(parsed.schema_version).toBe(1);
    expect(parsed.items).toEqual([]);
    expect(parsed.degraded).toBe(false);
    expect(parsed.degradation_reason).toBe("");
    expect(parsed.starvation_tiers).toEqual([]);
    expect(parsed.source_counts).toEqual({});
  }, 30_000);

  it("both REJECT too many starvation_tiers (max_length=10)", async () => {
    const bad = { starvation_tiers: Array.from({ length: 11 }, (_v, i) => `t${i}`) };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedKnowledgeV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrievedKnowledgeV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a too-long degradation_reason (max_length=200)", async () => {
    const bad = { degradation_reason: "x".repeat(201) };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedKnowledgeV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrievedKnowledgeV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested item (bad stage propagates)", async () => {
    const bad = { items: [{ chunk: CHUNK, score: 0.5, stage: "bogus" }] };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedKnowledgeV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrievedKnowledgeV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { degraded: false, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedKnowledgeV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrievedKnowledgeV1.parse(bad)).toThrow();
  }, 30_000);
});
