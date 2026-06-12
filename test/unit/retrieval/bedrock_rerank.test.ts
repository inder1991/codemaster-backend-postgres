// W1.3 RH9 — unit tests for the Bedrock RERANK-API adapter (BedrockRerankPort). Stubs the HTTP seam
// (no network): proves the native rerank request shape (Cohere / Amazon variants), the score-array
// mapping back onto the FULL candidate list, the top-N submission cap, and that EVERY failure axis
// (missing credentials / missing region / HTTP error / transport abort / malformed payload) maps to
// LlmRerankUnavailableError — which LlmRerank.apply catches, falling back to the pre-rerank order
// with degraded=true (fail-open: a rerank fault never fails the review).

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BedrockRerankPort,
  type BedrockRerankCredentialsSource,
  type RerankHttpClient,
  RERANK_DOC_MAX_CHARS,
  UNSUBMITTED_CANDIDATE_SCORE,
  bedrockRerankEndpoint,
} from "#backend/retrieval/bedrock_rerank.js";
import { LlmRerank, LlmRerankUnavailableError } from "#backend/retrieval/llm_rerank.js";

import type { KnowledgeChunkV1, RetrievedKnowledgeV1 } from "#contracts/knowledge_chunks.v1.js";

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

const CANDIDATES = [
  knowledgeChunk("a", "alpha body text"),
  knowledgeChunk("b", "beta body text"),
  knowledgeChunk("c", "gamma body text"),
];

const CREDS: BedrockRerankCredentialsSource = async () => ({
  apiKey: "test-bearer-token-abcdef",
  region: "us-east-1",
});

type CapturedRequest = { url: string; init: Parameters<RerankHttpClient>[1] };

/** HTTP stub: captures the request, returns the canned JSON body with the given status. */
function httpReturning(
  body: unknown,
  captured: Array<CapturedRequest>,
  status = 200,
): RerankHttpClient {
  return async (url, init) => {
    captured.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  };
}

function port(args: {
  http: RerankHttpClient;
  modelId?: string;
  region?: string | null;
  topN?: number;
  credentials?: BedrockRerankCredentialsSource;
}): BedrockRerankPort {
  return new BedrockRerankPort({
    modelId: args.modelId ?? "cohere.rerank-v3-5:0",
    region: args.region !== undefined ? args.region : "us-west-2",
    topN: args.topN ?? 25,
    credentials: args.credentials ?? CREDS,
    http: args.http,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BedrockRerankPort — request shape", () => {
  it("Cohere: POSTs the native rerank body (query/documents/top_n/api_version) with bearer auth", async () => {
    const captured: Array<CapturedRequest> = [];
    const http = httpReturning(
      { results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.2 }, { index: 2, relevance_score: 0.3 }] },
      captured,
    );
    await port({ http }).rerank({ query: "the query", candidates: CANDIDATES });

    expect(captured).toHaveLength(1);
    const { url, init } = captured[0]!;
    expect(url).toBe(bedrockRerankEndpoint("us-west-2", "cohere.rerank-v3-5:0"));
    expect(url).toBe(
      "https://bedrock-runtime.us-west-2.amazonaws.com/model/cohere.rerank-v3-5%3A0/invoke",
    );
    expect(init.method).toBe("POST");
    expect(init.headers["authorization"]).toBe("Bearer test-bearer-token-abcdef");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({
      query: "the query",
      documents: [
        "docs/a.md\nalpha body text",
        "docs/b.md\nbeta body text",
        "docs/c.md\ngamma body text",
      ],
      top_n: 3,
      api_version: 2,
    });
  });

  it("Amazon: the body carries NO api_version (Cohere-only field)", async () => {
    const captured: Array<CapturedRequest> = [];
    const http = httpReturning({ results: [{ index: 0, relevance_score: 0.5 }] }, captured);
    await port({ http, modelId: "amazon.rerank-v1:0" }).rerank({
      query: "q",
      candidates: [CANDIDATES[0]!],
    });
    expect(JSON.parse(captured[0]!.init.body)).toEqual({
      query: "q",
      documents: ["docs/a.md\nalpha body text"],
      top_n: 1,
    });
  });

  it("submits only the leading top-N candidates and clamps each document body", async () => {
    const captured: Array<CapturedRequest> = [];
    const http = httpReturning(
      { results: [{ index: 0, relevance_score: 0.4 }, { index: 1, relevance_score: 0.8 }] },
      captured,
    );
    const longBody = "x".repeat(RERANK_DOC_MAX_CHARS + 500);
    const candidates = [knowledgeChunk("long", longBody), CANDIDATES[1]!, CANDIDATES[2]!];
    const scores = await port({ http, topN: 2 }).rerank({ query: "q", candidates });

    const body = JSON.parse(captured[0]!.init.body) as { documents: Array<string>; top_n: number };
    expect(body.documents).toHaveLength(2);
    expect(body.top_n).toBe(2);
    expect(body.documents[0]).toBe(`docs/long.md\n${longBody.slice(0, RERANK_DOC_MAX_CHARS)}`);
    // The unsubmitted tail scores strictly below every possible relevance score, preserving its
    // pre-rerank relative order under LlmRerank's stable sort.
    expect(scores).toEqual([0.4, 0.8, UNSUBMITTED_CANDIDATE_SCORE]);
  });

  it("a null config region falls back to the platform credential row's region", async () => {
    const captured: Array<CapturedRequest> = [];
    const http = httpReturning({ results: [{ index: 0, relevance_score: 1 }] }, captured);
    await port({ http, region: null }).rerank({ query: "q", candidates: [CANDIDATES[0]!] });
    expect(captured[0]!.url).toContain("bedrock-runtime.us-east-1.amazonaws.com");
  });

  it("empty candidates → [] without touching credentials or the network", async () => {
    const credentials: BedrockRerankCredentialsSource = async () => {
      throw new Error("must not be called");
    };
    const http: RerankHttpClient = async () => {
      throw new Error("must not be called");
    };
    await expect(
      new BedrockRerankPort({ modelId: "amazon.rerank-v1:0", region: "us-east-1", topN: 5, credentials, http })
        .rerank({ query: "q", candidates: [] }),
    ).resolves.toEqual([]);
  });
});

describe("BedrockRerankPort — score mapping", () => {
  it("maps out-of-order results back onto candidate order; an omitted submitted index scores 0", async () => {
    const http = httpReturning(
      { results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.3 }] },
      [],
    );
    const scores = await port({ http }).rerank({ query: "q", candidates: CANDIDATES });
    expect(scores).toEqual([0.3, 0, 0.9]);
  });
});

describe("BedrockRerankPort — fail-open mapping (every fault → LlmRerankUnavailableError)", () => {
  it("no enabled bedrock credential row → unavailable, network untouched, structured WARN", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const http: RerankHttpClient = async () => {
      throw new Error("must not be called");
    };
    await expect(
      port({ http, credentials: async () => null }).rerank({ query: "q", candidates: CANDIDATES }),
    ).rejects.toThrow(LlmRerankUnavailableError);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("bedrock_rerank_failed");
  });

  it("no region anywhere (config null + credential row null) → unavailable before any call", async () => {
    const http: RerankHttpClient = async () => {
      throw new Error("must not be called");
    };
    const credentials: BedrockRerankCredentialsSource = async () => ({ apiKey: "k-123456789", region: null });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      port({ http, region: null, credentials }).rerank({ query: "q", candidates: CANDIDATES }),
    ).rejects.toThrow(LlmRerankUnavailableError);
  });

  it("a non-2xx response → unavailable; the WARN carries the status but NEVER the bearer token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const http = httpReturning({ message: "Too many requests" }, [], 429);
    await expect(
      port({ http }).rerank({ query: "q", candidates: CANDIDATES }),
    ).rejects.toThrow(LlmRerankUnavailableError);
    const logged = String(warn.mock.calls[0]?.[0]);
    expect(logged).toContain("429");
    expect(logged).not.toContain("test-bearer-token-abcdef");
  });

  it("a transport failure (abort/ECONNREFUSED) → unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const http: RerankHttpClient = async () => {
      throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    };
    await expect(
      port({ http }).rerank({ query: "q", candidates: CANDIDATES }),
    ).rejects.toThrow(LlmRerankUnavailableError);
  });

  it.each([
    ["not JSON at all", "<html>boom</html>"],
    ["no results key", JSON.stringify({ outputs: [] })],
    ["out-of-range index", JSON.stringify({ results: [{ index: 99, relevance_score: 0.5 }] })],
    ["non-numeric score", JSON.stringify({ results: [{ index: 0, relevance_score: "high" }] })],
  ])("malformed payload (%s) → unavailable", async (_name, raw) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const http: RerankHttpClient = async () => ({ ok: true, status: 200, text: async () => raw });
    await expect(
      port({ http }).rerank({ query: "q", candidates: CANDIDATES }),
    ).rejects.toThrow(LlmRerankUnavailableError);
  });
});

describe("BedrockRerankPort under LlmRerank.apply (the slot-level fail-open proof)", () => {
  const retrieved: RetrievedKnowledgeV1 = {
    schema_version: 1,
    items: CANDIDATES.map((chunk) => ({ schema_version: 1 as const, chunk, score: 0.5, stage: "rrf" })),
    degraded: false,
    degradation_reason: "",
    starvation_tiers: [],
    source_counts: {},
  };

  it("a rerank fault falls back to the pre-rerank order with degraded=true (review never fails)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const http = httpReturning({ message: "boom" }, [], 500);
    const rerank = new LlmRerank({ port: port({ http }) });
    const out = await rerank.apply({ query: "q", candidates: retrieved });
    expect(out.items.map((i) => i.chunk.chunk_id)).toEqual(["a", "b", "c"]);
    expect(out.degraded).toBe(true);
    expect(out.degradation_reason).toMatch(/rerank/i);
  });

  it("a healthy response REORDERS the candidates by relevance", async () => {
    const http = httpReturning(
      {
        results: [
          { index: 2, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.4 },
          { index: 1, relevance_score: 0.1 },
        ],
      },
      [],
    );
    const rerank = new LlmRerank({ port: port({ http }) });
    const out = await rerank.apply({ query: "q", candidates: retrieved });
    expect(out.items.map((i) => i.chunk.chunk_id)).toEqual(["c", "a", "b"]);
    expect(out.degraded).toBe(false);
  });
});
