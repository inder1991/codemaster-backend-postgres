// Unit tests for rrfCombine (the RRF math): 1/(k+rank), dedup by chunk_id, degraded propagation.
// Pure-function tests — no DB, no embedder.

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { RRF_K_DEFAULT, rrfCombine } from "#backend/retrieval/rrf.js";

import type {
  KnowledgeChunkV1,
  RetrievedKnowledgeV1,
  ScoredKnowledgeChunkV1,
} from "#contracts/knowledge_chunks.v1.js";

const IID = randomUUID();
const RID = randomUUID();

/** A minimal valid KnowledgeChunkV1 with a fixed chunk_id. */
function chunk(chunkId: string, body = "x"): KnowledgeChunkV1 {
  return {
    schema_version: 2,
    chunk_id: chunkId,
    installation_id: IID,
    repo_id: RID,
    relative_path: "docs/x.md",
    chunk_index: 0,
    heading_path: [],
    body,
    doc_kind: "adr",
    doc_status: "active",
    source: "repo_knowledge",
    space_key: null,
    page_id: null,
    page_version: null,
    labels: [],
    match_specificity_score: 0,
    age_days: 0,
  };
}

/** Wrap an ordered list of chunk_ids into a RetrievedKnowledgeV1 (stage irrelevant to RRF). */
function listed(
  chunkIds: ReadonlyArray<string>,
  opts: { degraded?: boolean; reason?: string } = {},
): RetrievedKnowledgeV1 {
  const items: Array<ScoredKnowledgeChunkV1> = chunkIds.map((cid, i) => ({
    schema_version: 1,
    chunk: chunk(cid),
    score: 100 - i, // raw scores RRF must IGNORE
    stage: "bm25",
  }));
  return {
    schema_version: 1,
    items,
    degraded: opts.degraded ?? false,
    degradation_reason: opts.reason ?? "",
    starvation_tiers: [],
    source_counts: {},
  };
}

describe("rrfCombine", () => {
  it("empty input returns an all-defaults envelope", () => {
    const out = rrfCombine([], { topK: 5 });
    expect(out.items).toEqual([]);
    expect(out.degraded).toBe(false);
    expect(out.degradation_reason).toBe("");
  });

  it("single list: score = 1/(k+rank), rank 1-based, stage='rrf'", () => {
    const a = randomUUID();
    const b = randomUUID();
    const out = rrfCombine([listed([a, b])], { topK: 5, k: RRF_K_DEFAULT });
    expect(out.items.length).toBe(2);
    // rank 1 → 1/(60+1); rank 2 → 1/(60+2).
    expect(out.items[0]!.chunk.chunk_id).toBe(a);
    expect(out.items[0]!.score).toBeCloseTo(1 / (RRF_K_DEFAULT + 1), 12);
    expect(out.items[0]!.stage).toBe("rrf");
    expect(out.items[1]!.chunk.chunk_id).toBe(b);
    expect(out.items[1]!.score).toBeCloseTo(1 / (RRF_K_DEFAULT + 2), 12);
  });

  it("a chunk ranked in BOTH lists sums its reciprocal ranks and floats to the top", () => {
    const shared = randomUUID();
    const onlyA = randomUUID();
    const onlyB = randomUUID();
    // List A: [onlyA(rank1), shared(rank2)]; List B: [onlyB(rank1), shared(rank2)].
    // shared score = 1/(60+2) + 1/(60+2) = 2/62; onlyA = 1/61; onlyB = 1/61. shared wins.
    const out = rrfCombine([listed([onlyA, shared]), listed([onlyB, shared])], { topK: 5 });
    expect(out.items[0]!.chunk.chunk_id).toBe(shared);
    const sharedScore = 2 / (RRF_K_DEFAULT + 2);
    const singleScore = 1 / (RRF_K_DEFAULT + 1);
    expect(out.items[0]!.score).toBeCloseTo(sharedScore, 12);
    expect(sharedScore).toBeGreaterThan(singleScore);
    // dedup: shared appears exactly once.
    const sharedCount = out.items.filter((i) => i.chunk.chunk_id === shared).length;
    expect(sharedCount).toBe(1);
    expect(out.items.length).toBe(3);
  });

  it("dedup keeps the FIRST-seen chunk object for a repeated id (setdefault semantics)", () => {
    const cid = randomUUID();
    const first = chunk(cid, "FIRST");
    const second = chunk(cid, "SECOND");
    const la: RetrievedKnowledgeV1 = {
      schema_version: 1,
      items: [{ schema_version: 1, chunk: first, score: 1, stage: "bm25" }],
      degraded: false,
      degradation_reason: "",
      starvation_tiers: [],
      source_counts: {},
    };
    const lb: RetrievedKnowledgeV1 = {
      schema_version: 1,
      items: [{ schema_version: 1, chunk: second, score: 1, stage: "ann" }],
      degraded: false,
      degradation_reason: "",
      starvation_tiers: [],
      source_counts: {},
    };
    const out = rrfCombine([la, lb], { topK: 5 });
    expect(out.items.length).toBe(1);
    expect(out.items[0]!.chunk.body).toBe("FIRST");
  });

  it("top_k truncates the fused output", () => {
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const out = rrfCombine([listed(ids)], { topK: 2 });
    expect(out.items.length).toBe(2);
    expect(out.items[0]!.chunk.chunk_id).toBe(ids[0]);
    expect(out.items[1]!.chunk.chunk_id).toBe(ids[1]);
  });

  it("a smaller k weights the very top result more aggressively", () => {
    const a = randomUUID();
    const big = rrfCombine([listed([a])], { topK: 1, k: 60 }).items[0]!.score;
    const small = rrfCombine([listed([a])], { topK: 1, k: 1 }).items[0]!.score;
    // 1/(1+1)=0.5 ≫ 1/(60+1)≈0.0164.
    expect(small).toBeGreaterThan(big);
  });

  it("degraded propagates true if ANY input is degraded; reasons are joined", () => {
    const a = randomUUID();
    const b = randomUUID();
    const out = rrfCombine(
      [listed([a]), listed([b], { degraded: true, reason: "embed service unreachable" })],
      { topK: 5 },
    );
    expect(out.degraded).toBe(true);
    expect(out.degradation_reason).toBe("embed service unreachable");
  });

  it("no input degraded → degraded false, empty reason", () => {
    const a = randomUUID();
    const out = rrfCombine([listed([a]), listed([a])], { topK: 5 });
    expect(out.degraded).toBe(false);
    expect(out.degradation_reason).toBe("");
  });

  it("joined degradation_reason is capped at 200 chars", () => {
    const a = randomUUID();
    const long = "x".repeat(300);
    const out = rrfCombine([listed([a], { degraded: true, reason: long })], { topK: 5 });
    expect(out.degradation_reason.length).toBe(200);
  });
});
