// Unit tests for buildRerankOverride (E) — the flag-gated per-invocation LLM rerank construction in the
// retrieve_knowledge activity. The HybridRetriever-honors-the-override behavior is covered in
// test/unit/retrieval/hybrid_retriever.test.ts; here we cover the flag/cache gating of the builder.

import { describe, expect, it } from "vitest";

import { buildRerankOverride } from "#backend/activities/retrieve_knowledge.activity.js";
import type { LlmClient } from "#backend/integrations/llm/client.js";
import type { RerankLlmCacheLike } from "#backend/retrieval/llm_backed_rerank.js";
import { LlmRerank } from "#backend/retrieval/llm_rerank.js";

import type { KnowledgeChunkV1, RetrievedKnowledgeV1 } from "#contracts/knowledge_chunks.v1.js";
import type { PurposeModelResolverLike } from "#backend/llm/purpose_model_resolver.js";

// A cache stub whose forRole is never invoked by buildRerankOverride (construction only — no rerank call).
const fakeCache: RerankLlmCacheLike = {
  forRole: async () => {
    throw new Error("forRole must not be called during construction");
  },
};

describe("buildRerankOverride (E flag-gated LLM reranker)", () => {
  it("disabled → undefined (HybridRetriever runs its static IdentityRerankPort no-op)", () => {
    expect(
      buildRerankOverride({ enabled: false, cache: fakeCache, installationId: "i1" }),
    ).toBeUndefined();
  });

  it("enabled but no cache wired → undefined (cannot build an LLM-backed port without a cache)", () => {
    expect(
      buildRerankOverride({ enabled: true, cache: undefined, installationId: "i1" }),
    ).toBeUndefined();
  });

  it("enabled + cache → an LlmRerank (the LLM-backed override)", () => {
    const override = buildRerankOverride({ enabled: true, cache: fakeCache, installationId: "i1" });
    expect(override).toBeInstanceOf(LlmRerank);
  });
});

// ─── TEST 2: buildRerankOverride threads the resolver to the rerank port ─────────────────────────
//
// Proves the full factory chain: buildRerankOverride → LlmBackedRerankPort → resolver.
// A future edit dropping the resolver from the LlmBackedRerankPort constructor args must fail here.

function knowledgeChunk(id: string, body: string): KnowledgeChunkV1 {
  return {
    schema_version: 2,
    chunk_id: id,
    installation_id: "11111111-1111-1111-1111-111111111111",
    repo_id: "22222222-2222-2222-2222-222222222222",
    relative_path: `docs/${id}.md`,
    chunk_index: 0,
    heading_path: [],
    body,
    doc_kind: "other",
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

describe("buildRerankOverride — resolver is threaded to LlmBackedRerankPort", () => {
  it("captures invokeModel model === sentinel when resolver returns sentinel-rerank", async () => {
    const SENTINEL = "sentinel-rerank";
    let capturedModel: string | undefined;

    // A fake LlmClient that captures the `model` arg to invokeModel and returns a well-formed
    // scores response so the port's parse succeeds and LlmRerank.apply runs to completion.
    const fakeClient: LlmClient = {
      invokeModel: async (args: { model?: string }): Promise<{
        raw_content_blocks: Array<{ type: string; name: string; input: { scores: Array<number> } }>;
      }> => {
        capturedModel = args.model;
        return {
          raw_content_blocks: [
            { type: "tool_use", name: "submit_relevance_scores", input: { scores: [0.9] } },
          ],
        };
      },
    } as unknown as LlmClient;

    const cacheReturningFakeClient: RerankLlmCacheLike = {
      forRole: async () => fakeClient,
    };

    const resolverReturningsentinel: PurposeModelResolverLike = {
      resolve: async () => SENTINEL,
    };

    const reranker = buildRerankOverride({
      enabled: true,
      cache: cacheReturningFakeClient,
      installationId: "00000000-0000-0000-0000-000000000001",
      resolver: resolverReturningsentinel,
    });

    expect(reranker).toBeInstanceOf(LlmRerank);

    const chunk = knowledgeChunk("c1", "some body text for the candidate");
    const candidates: RetrievedKnowledgeV1 = {
      schema_version: 1,
      items: [{ schema_version: 1, chunk, score: 0.5, stage: "rrf" }],
      degraded: false,
      degradation_reason: "",
      starvation_tiers: [],
      source_counts: {},
    };

    await reranker!.apply({ query: "find auth issues", candidates });

    expect(capturedModel).toBe(SENTINEL);
  });
});
