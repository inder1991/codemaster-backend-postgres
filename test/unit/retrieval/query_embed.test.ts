// Unit tests for the W1.3 query-embed seam (RL-appendix embed-mode item, folded into RC4):
//
//   1. ONE unified query purpose — the frozen code embedded queries under TWO different purposes
//      ("in_repo_doc" on the memoized embed_query path vs "review_query" on AnnRetriever's per-chunk
//      fallback), so a chunk whose memoized embed failed got a DIFFERENT query vector than its
//      siblings. Both paths now share QUERY_EMBED_PURPOSE.
//
//   2. The Qwen query-vs-passage INSTRUCTION asymmetry — Qwen3-style embedders score best when the
//      QUERY (not the passage) carries an instruction prefix. Whether the platform Qwen service
//      already applies it server-side (keyed on `purpose`) is NOT empirically verified, so the
//      client-side prefix ships BEHIND `CODEMASTER_EMBED_QUERY_INSTRUCTION_ENABLED` (default OFF —
//      double-prefixing would hurt relevance). One seam (`buildQueryEmbedText`) feeds BOTH embed
//      paths so query vectors stay mutually consistent whichever way the flag is set.

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildQueryEmbedText,
  QUERY_EMBED_PURPOSE,
  QWEN_QUERY_INSTRUCTION,
} from "#backend/retrieval/query_embed.js";
import { AnnRetriever } from "#backend/retrieval/ann_retriever.js";

import type { EmbedRequest, EmbedResult, EmbeddingsPort } from "#backend/adapters/embeddings_port.js";
import { KnowledgeQueryV1 } from "#contracts/knowledge_chunks.v1.js";

describe("QUERY_EMBED_PURPOSE — the ONE query purpose", () => {
  it('is "review_query" (the query-mode metering bucket)', () => {
    expect(QUERY_EMBED_PURPOSE).toBe("review_query");
  });
});

describe("buildQueryEmbedText — flag-gated Qwen query instruction", () => {
  it("returns the query unchanged when the flag is unset (default OFF)", () => {
    expect(buildQueryEmbedText("find the lease", {})).toBe("find the lease");
    expect(
      buildQueryEmbedText("find the lease", { CODEMASTER_EMBED_QUERY_INSTRUCTION_ENABLED: "false" }),
    ).toBe("find the lease");
  });

  it("prepends the instruction exactly once when the flag is on", () => {
    const out = buildQueryEmbedText("find the lease", {
      CODEMASTER_EMBED_QUERY_INSTRUCTION_ENABLED: "true",
    });
    expect(out).toBe(`${QWEN_QUERY_INSTRUCTION}find the lease`);
    expect(out.startsWith("Instruct:")).toBe(true);
  });
});

describe("AnnRetriever fallback embed — shares the unified purpose + instruction seam", () => {
  it("embeds with QUERY_EMBED_PURPOSE on the no-override fallback path", async () => {
    const calls: Array<EmbedRequest> = [];
    const recording: EmbeddingsPort = {
      async embed(req): Promise<EmbedResult> {
        calls.push(req);
        return { vectors: [[1, 0, 0]], model_name: "m", model_version: "v", cache_hits: 0 };
      },
    };
    const retriever = new AnnRetriever({
      port: { search: async () => [] },
      embeddings: recording,
      modelName: "m",
    });
    await retriever.retrieve(
      KnowledgeQueryV1.parse({
        query: "find the lease",
        installation_id: randomUUID(),
        repo_id: randomUUID(),
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.purpose).toBe(QUERY_EMBED_PURPOSE);
    expect(calls[0]!.texts).toEqual([buildQueryEmbedText("find the lease")]);
  });
});
