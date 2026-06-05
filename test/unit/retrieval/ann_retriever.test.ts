// Unit tests for AnnRetriever, scored via the TEST-ONLY InMemoryAnnPort (TS cosine).
//
// Three load-bearing behaviors (1:1 with the Python AnnRetriever contract):
//   1. override path: a query_vector_override SKIPS the embed RPC entirely (recording.calls stays 0).
//   2. degraded-empty: an EmbeddingsConnectivityError / RateLimited from embed → items=[], degraded=true.
//   3. every hit carries stage="ann".
//
// No DB, no live embedder — pure in-memory. randomUUID is fine in a TEST file (the check_clock_random
// gate only scans production src trees).

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type EmbedResult,
  type EmbeddingsPort,
  EmbeddingsConnectivityError,
  EmbeddingsRateLimitedError,
  RecordingEmbeddingsClient,
} from "#backend/adapters/embeddings_port.js";
import { InMemoryAnnPort, type InMemoryAnnRow } from "#backend/retrieval/ann_port.js";
import { AnnRetriever } from "#backend/retrieval/ann_retriever.js";

import { KnowledgeChunkV1, KnowledgeQueryV1 } from "#contracts/knowledge_chunks.v1.js";

const INSTALLATION_ID = randomUUID();
const REPO_ID = randomUUID();

function makeChunk(opts: {
  relativePath: string;
  body: string;
  docStatus?: "active" | "deprecated" | "superseded" | "draft";
}): KnowledgeChunkV1 {
  return KnowledgeChunkV1.parse({
    chunk_id: randomUUID(),
    installation_id: INSTALLATION_ID,
    repo_id: REPO_ID,
    relative_path: opts.relativePath,
    chunk_index: 0,
    body: opts.body,
    doc_kind: "adr",
    doc_status: opts.docStatus ?? "active",
  });
}

/** A double that always raises the given error from embed (to exercise the degraded path). */
class FailingEmbeddings implements EmbeddingsPort {
  public constructor(private readonly error: Error) {}
  public async embed(): Promise<EmbedResult> {
    throw this.error;
  }
}

describe("AnnRetriever", () => {
  it("skips the embed RPC when a query_vector_override is supplied", async () => {
    const chunkA = makeChunk({ relativePath: "a.md", body: "alpha" });
    const chunkB = makeChunk({ relativePath: "b.md", body: "beta" });
    const rows: ReadonlyArray<InMemoryAnnRow> = [
      [chunkA, [1, 0, 0]],
      [chunkB, [0, 1, 0]],
    ];
    const recording = new RecordingEmbeddingsClient();
    const retriever = new AnnRetriever({
      port: new InMemoryAnnPort({ rows }),
      embeddings: recording,
      modelName: "m",
    });

    // The override vector is closest to chunkA's [1,0,0].
    const query = KnowledgeQueryV1.parse({
      query: "ignored because override is present",
      installation_id: INSTALLATION_ID,
      repo_id: REPO_ID,
      top_k: 1,
      query_vector_override: [0.9, 0.1, 0],
    });

    const out = await retriever.retrieve(query);

    // Embed RPC NOT called — the override short-circuits it.
    expect(recording.calls).toHaveLength(0);
    expect(out.degraded).toBe(false);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.chunk.relative_path).toBe("a.md");
    expect(out.items[0]!.stage).toBe("ann");
  });

  it("returns a degraded-empty envelope when embed is unreachable", async () => {
    const retriever = new AnnRetriever({
      port: new InMemoryAnnPort({ rows: [] }),
      embeddings: new FailingEmbeddings(new EmbeddingsConnectivityError("down")),
      modelName: "m",
    });
    const query = KnowledgeQueryV1.parse({
      query: "anything",
      installation_id: INSTALLATION_ID,
      repo_id: REPO_ID,
    });

    const out = await retriever.retrieve(query);

    expect(out.degraded).toBe(true);
    expect(out.degradation_reason).toBe("embed service unreachable");
    expect(out.items).toHaveLength(0);
  });

  it("returns a degraded-empty envelope when embed is rate-limited", async () => {
    const retriever = new AnnRetriever({
      port: new InMemoryAnnPort({ rows: [] }),
      embeddings: new FailingEmbeddings(new EmbeddingsRateLimitedError("429")),
      modelName: "m",
    });
    const query = KnowledgeQueryV1.parse({
      query: "anything",
      installation_id: INSTALLATION_ID,
      repo_id: REPO_ID,
    });

    const out = await retriever.retrieve(query);

    expect(out.degraded).toBe(true);
    expect(out.degradation_reason).toBe("embed service rate-limited");
    expect(out.items).toHaveLength(0);
  });

  it("embeds the query and stamps stage=ann on every hit (no override)", async () => {
    const chunkA = makeChunk({ relativePath: "a.md", body: "alpha" });
    const stale = makeChunk({ relativePath: "stale.md", body: "old", docStatus: "deprecated" });
    const rows: ReadonlyArray<InMemoryAnnRow> = [
      [chunkA, [1, 0, 0]],
      // A stale row that the InMemory port excludes (include_stale=false).
      [stale, [1, 0, 0]],
    ];
    // RecordingEmbeddingsClient returns a 1024-dim vector; InMemoryAnnPort.cosine raises on a length
    // mismatch with the 3-dim rows, so we inject a 3-dim embedder double for this no-override case.
    const threeDim: EmbeddingsPort = {
      async embed(): Promise<EmbedResult> {
        return {
          vectors: [[0.9, 0.1, 0]],
          model_name: "m",
          model_version: "v",
          cache_hits: 0,
        };
      },
    };
    const retriever = new AnnRetriever({
      port: new InMemoryAnnPort({ rows }),
      embeddings: threeDim,
      modelName: "m",
    });
    const query = KnowledgeQueryV1.parse({
      query: "find alpha",
      installation_id: INSTALLATION_ID,
      repo_id: REPO_ID,
      top_k: 5,
    });

    const out = await retriever.retrieve(query);

    expect(out.degraded).toBe(false);
    // Only the active chunk survives; the deprecated one is filtered.
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.chunk.relative_path).toBe("a.md");
    expect(out.items[0]!.stage).toBe("ann");
  });
});
