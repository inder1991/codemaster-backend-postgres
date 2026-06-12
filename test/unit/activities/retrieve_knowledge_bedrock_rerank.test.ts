// W1.3 RH9 — the activity-level dispatch of the Bedrock rerank override into the HybridRetriever
// rerankOverride seam. Proves: (a) an enabled resolver REPLACES the identity pass-through on the
// hybrid path; (b) with the resolver yielding undefined the behavior is byte-identical to today
// (DEFAULT OFF — no override reaches the seam); (c) a resolver fault is swallowed with a WARN and
// retrieval proceeds un-reranked (fail-open: a rerank fault never fails the review).

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RetrieveKnowledgeActivity } from "#backend/activities/retrieve_knowledge.activity.js";
import type { AnnRetriever } from "#backend/retrieval/ann_retriever.js";
import type { Bm25Retriever } from "#backend/retrieval/bm25_retriever.js";
import type { HybridRetriever } from "#backend/retrieval/hybrid_retriever.js";
import { IdentityRerankPort, LlmRerank } from "#backend/retrieval/llm_rerank.js";

import { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";
import type {
  KnowledgeQueryV1,
  RetrievedKnowledgeV1,
} from "#contracts/knowledge_chunks.v1.js";
import { PRContext } from "#contracts/pr_context.v1.js";
import type { RetrieveKnowledgeInputV1 } from "#contracts/retrieve_knowledge.v1.js";

const IID = randomUUID();
const RID = randomUUID();

const EMPTY_ENVELOPE: RetrievedKnowledgeV1 = {
  schema_version: 1,
  items: [],
  degraded: false,
  degradation_reason: "",
  starvation_tiers: [],
  source_counts: {},
};

/** A HybridRetriever stub capturing BOTH positional args (query, rerankOverride). */
class CapturingHybrid {
  public lastOverride: LlmRerank | undefined | "never-called" = "never-called";
  public async retrieve(
    _query: KnowledgeQueryV1,
    rerankOverride?: LlmRerank,
  ): Promise<RetrievedKnowledgeV1> {
    this.lastOverride = rerankOverride;
    return EMPTY_ENVELOPE;
  }
}

const PR_CTX = PRContext.parse({
  pr_id: randomUUID(),
  head_sha: "a".repeat(40),
  repo_default_branch: "main",
  changed_files: [{ path: "services/api/main.py", additions: 10, deletions: 2 }],
});

function gatedInput(): RetrieveKnowledgeInputV1 {
  return {
    schema_version: 1,
    installation_id: IID,
    repo_id: RID,
    query: "services/api/main.py PR title",
    top_k: 5,
    query_vector_override: [0.1, 0.2, 0.3],
    include_confluence: true,
    pr_context: PR_CTX,
    yaml_config: CodemasterConfigV1.parse({}),
    platform_exposed_labels: ["default"],
  };
}

const unusedRetriever = {
  retrieve: async (): Promise<RetrievedKnowledgeV1> => EMPTY_ENVELOPE,
};

function buildActivity(args: {
  hybrid: CapturingHybrid;
  bedrockRerankResolver?: () => Promise<LlmRerank | undefined>;
}): RetrieveKnowledgeActivity {
  return new RetrieveKnowledgeActivity({
    bm25Retriever: unusedRetriever as unknown as Bm25Retriever,
    annRetriever: unusedRetriever as unknown as AnnRetriever,
    hybridRetriever: args.hybrid as unknown as HybridRetriever,
    ...(args.bedrockRerankResolver !== undefined
      ? { bedrockRerankResolver: args.bedrockRerankResolver }
      : {}),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RetrieveKnowledgeActivity — Bedrock rerank override dispatch (hybrid path)", () => {
  it("an enabled resolver's LlmRerank reaches the HybridRetriever rerankOverride seam", async () => {
    const override = new LlmRerank({ port: new IdentityRerankPort() });
    const hybrid = new CapturingHybrid();
    const activity = buildActivity({ hybrid, bedrockRerankResolver: async () => override });
    await activity.retrieveKnowledge(gatedInput());
    expect(hybrid.lastOverride).toBe(override);
  });

  it("DEFAULT OFF: resolver yields undefined → no override (today's identity pass-through stands)", async () => {
    const hybrid = new CapturingHybrid();
    const activity = buildActivity({ hybrid, bedrockRerankResolver: async () => undefined });
    await activity.retrieveKnowledge(gatedInput());
    expect(hybrid.lastOverride).toBeUndefined();
  });

  it("no resolver wired at all → no override (back-compat with the pre-RH9 wiring)", async () => {
    const hybrid = new CapturingHybrid();
    const activity = buildActivity({ hybrid });
    await activity.retrieveKnowledge(gatedInput());
    expect(hybrid.lastOverride).toBeUndefined();
  });

  it("a resolver FAULT is swallowed with a WARN; retrieval proceeds un-reranked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hybrid = new CapturingHybrid();
    const activity = buildActivity({
      hybrid,
      bedrockRerankResolver: async () => {
        throw new Error("resolver exploded");
      },
    });
    const result = await activity.retrieveKnowledge(gatedInput());
    expect(result.retrieval_degraded).toBe(false); // retrieval itself succeeded
    expect(hybrid.lastOverride).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain("bedrock_rerank");
  });
});
