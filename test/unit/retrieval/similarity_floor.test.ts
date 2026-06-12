// Unit tests for the W1.3 (RH10) minimum cosine-similarity floor.
//
// RH10 (docs/audits/2026-06-11-audit-recovered-lenses.md): the ANN ports ordered by distance and
// LIMIT'd to top_k with NO similarity gate, so a repo whose only indexed docs are unrelated to the
// change still returned top_k "matches" (cosine ~0.1) rendered to the LLM as authoritative knowledge.
// The fix: a minimum cosine-similarity floor, defaulted platform-wide (MIN_COSINE_SIMILARITY_FLOOR)
// and tunable per construction, so a query with no genuinely-similar chunks returns FEWER/ZERO results
// instead of padding to top_k.
//
// The default is 0.3 — the BOTTOM of the audit's suggested 0.3–0.5 band: maximally fail-open (only
// discards matches of the clearly-irrelevant class RH10 describes) until W1.7's retrieval-quality
// counters give evidence to tune it upward.

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type AnnPort,
  type AnnSearchArgs,
  InMemoryAnnPort,
  type InMemoryAnnRow,
} from "#backend/retrieval/ann_port.js";
import { AnnRetriever } from "#backend/retrieval/ann_retriever.js";
import { MIN_COSINE_SIMILARITY_FLOOR } from "#backend/retrieval/constants.js";

import type { EmbeddingsPort } from "#backend/adapters/embeddings_port.js";
import { KnowledgeChunkV1, KnowledgeQueryV1 } from "#contracts/knowledge_chunks.v1.js";

const INSTALLATION_ID = randomUUID();
const REPO_ID = randomUUID();

function makeChunk(relativePath: string): KnowledgeChunkV1 {
  return KnowledgeChunkV1.parse({
    chunk_id: randomUUID(),
    installation_id: INSTALLATION_ID,
    repo_id: REPO_ID,
    relative_path: relativePath,
    chunk_index: 0,
    body: `body of ${relativePath}`,
    doc_kind: "adr",
    doc_status: "active",
  });
}

// Query vector [1,0,0] against: near (cos≈0.99), mid (cos=0.5), far (cos=0).
const NEAR = makeChunk("near.md");
const MID = makeChunk("mid.md");
const FAR = makeChunk("far.md");
const ROWS: ReadonlyArray<InMemoryAnnRow> = [
  [NEAR, [0.9, 0.1, 0]],
  [MID, [0.5, Math.sqrt(0.75), 0]],
  [FAR, [0, 1, 0]],
];
const QUERY_VEC: ReadonlyArray<number> = [1, 0, 0];

describe("MIN_COSINE_SIMILARITY_FLOOR — the platform default", () => {
  it("is 0.3 (the fail-open bottom of RH10's suggested 0.3–0.5 band)", () => {
    expect(MIN_COSINE_SIMILARITY_FLOOR).toBe(0.3);
  });
});

describe("InMemoryAnnPort — minimum-similarity floor (RH10)", () => {
  it("applies the default floor: below-floor matches are dropped instead of padding to top_k", async () => {
    const port = new InMemoryAnnPort({ rows: ROWS });
    const hits = await port.search({
      installationId: INSTALLATION_ID,
      repoId: REPO_ID,
      queryVector: QUERY_VEC,
      topK: 5,
    });
    // far.md (cos=0) is BELOW the 0.3 default floor → excluded; near + mid survive.
    expect(hits.map(([c]) => c.relative_path)).toEqual(["near.md", "mid.md"]);
  });

  it("minSimilarity=0 disables the floor (explicit opt-out keeps the legacy padding)", async () => {
    const port = new InMemoryAnnPort({ rows: ROWS });
    const hits = await port.search({
      installationId: INSTALLATION_ID,
      repoId: REPO_ID,
      queryVector: QUERY_VEC,
      topK: 5,
      minSimilarity: 0,
    });
    expect(hits.map(([c]) => c.relative_path)).toEqual(["near.md", "mid.md", "far.md"]);
  });

  it("an explicit tighter floor drops mid-band matches too", async () => {
    const port = new InMemoryAnnPort({ rows: ROWS });
    const hits = await port.search({
      installationId: INSTALLATION_ID,
      repoId: REPO_ID,
      queryVector: QUERY_VEC,
      topK: 5,
      minSimilarity: 0.6,
    });
    expect(hits.map(([c]) => c.relative_path)).toEqual(["near.md"]);
  });
});

describe("AnnRetriever — threads its configured floor into every port search", () => {
  function recordingPort(seen: Array<AnnSearchArgs>): AnnPort {
    return {
      async search(args) {
        seen.push(args);
        return [];
      },
    };
  }
  const unusedEmbeddings: EmbeddingsPort = {
    async embed() {
      throw new Error("embed must not be called (override present)");
    },
  };
  const query = KnowledgeQueryV1.parse({
    query: "anything",
    installation_id: INSTALLATION_ID,
    repo_id: REPO_ID,
    top_k: 5,
    query_vector_override: [1, 0, 0],
  });

  it("defaults to MIN_COSINE_SIMILARITY_FLOOR", async () => {
    const seen: Array<AnnSearchArgs> = [];
    const retriever = new AnnRetriever({
      port: recordingPort(seen),
      embeddings: unusedEmbeddings,
      modelName: "m",
    });
    await retriever.retrieve(query);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.minSimilarity).toBe(MIN_COSINE_SIMILARITY_FLOOR);
  });

  it("an injected minSimilarity (the wiring env knob) wins over the default", async () => {
    const seen: Array<AnnSearchArgs> = [];
    const retriever = new AnnRetriever({
      port: recordingPort(seen),
      embeddings: unusedEmbeddings,
      modelName: "m",
      minSimilarity: 0.45,
    });
    await retriever.retrieve(query);
    expect(seen[0]!.minSimilarity).toBe(0.45);
  });
});
