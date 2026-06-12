// W2.2 (prompt caching) — doReview assembles the CACHE-ORDERED request:
//
//   messages = [ system, stable PR prefix, per-chunk suffix ]   + cachePrefixMessages = 2
//
// so the adapter can mark the stable/variable boundary with cache_control:{type:"ephemeral"} and the
// N-chunk fan-out re-bills the (tools + system + PR-prefix) bytes at ~10% instead of full price.
//
// THE W2.2 PIN, asserted at the SDK seam (the bytes that actually leave the process): across two
// chunk calls of the SAME review — every per-chunk field different — the system message AND the
// stable-prefix message are BYTE-IDENTICAL, and only the suffix differs. Any nondeterminism or
// per-chunk leak into the prefix fails here before it can silently zero the production hit rate.

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { InMemoryCostCapEnforcer } from "#backend/cost/enforcer.js";
import { LlmClient, type LlmSdk } from "#backend/integrations/llm/client.js";
import { buildSystemPrompt } from "#backend/llm/review_prompt.js";
import { buildCachedReviewPrompt } from "#backend/review/prompt_builder.js";
import { doReview, type LlmClientCacheLike } from "#backend/review/review_activity.js";

import { InMemoryBlobStoreAdapter } from "../../support/llm/cassette_sdk.js";

import { computeChunkId } from "#contracts/diff_chunking.v1.js";
import { ReviewContextV1 } from "#contracts/review_context.v1.js";

const PR_ID = "11111111-1111-4111-8111-111111111111";
const INST_ID = "22222222-2222-4222-8222-222222222222";

type CapturedCall = {
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>> | null;
  cachePrefixMessages?: number;
};

/** A capturing SDK double returning a clean text-only response. */
class CapturingSdk implements LlmSdk {
  public readonly calls: Array<CapturedCall> = [];
  public async createMessage(args: {
    model: string;
    messages: Array<Record<string, unknown>>;
    maxTokens: number;
    tools: Array<Record<string, unknown>> | null;
    role: "primary" | "secondary";
    cachePrefixMessages?: number;
  }): Promise<Record<string, unknown>> {
    this.calls.push({
      messages: args.messages,
      tools: args.tools,
      ...(args.cachePrefixMessages !== undefined
        ? { cachePrefixMessages: args.cachePrefixMessages }
        : {}),
    });
    return {
      content: [{ type: "text", text: "No issues identified." }],
      usage: { input_tokens: 80, output_tokens: 12 },
      stop_reason: "end_turn",
    };
  }
}

function cacheOver(sdk: LlmSdk): LlmClientCacheLike {
  const client = new LlmClient({
    sdk,
    costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
    blobStore: new InMemoryBlobStoreAdapter(),
    clock: new FakeClock(),
  });
  return {
    async forRole(): Promise<LlmClient> {
      return client;
    },
  };
}

function contextForChunk(args: {
  path: string;
  body: string;
  startLine: number;
  endLine: number;
}): ReviewContextV1 {
  const chunkId = computeChunkId({
    path: args.path,
    start_line: args.startLine,
    end_line: args.endLine,
    body: args.body,
  });
  return ReviewContextV1.parse({
    pr_id: PR_ID,
    installation_id: INST_ID,
    repo: "acme/widgets",
    pr_title: "Refactor request handling",
    pr_description: "Multi-file refactor.",
    chunk: {
      chunk_id: chunkId,
      path: args.path,
      language: "typescript",
      start_line: args.startLine,
      end_line: args.endLine,
      body: args.body,
      chunk_kind: "function",
      token_estimate: 20,
    },
    policy_revision: 1,
    pr_topology_manifest: [
      {
        chunk_id: "44444444-4444-4444-8444-444444444444",
        path: "src/app/handler.ts",
        start_line: 10,
        end_line: 22,
        kind: "code",
      },
      {
        chunk_id: "55555555-5555-4555-8555-555555555555",
        path: "src/app/router.ts",
        start_line: 1,
        end_line: 40,
        kind: "code",
      },
    ],
  });
}

describe("doReview — cache-ordered message assembly (W2.2)", () => {
  it("sends [system, stable prefix, chunk suffix] with cachePrefixMessages=2", async () => {
    const sdk = new CapturingSdk();
    const ctx = contextForChunk({
      path: "src/app/handler.ts",
      body: "export function handler(): Response {\n  return new Response('ok');\n}",
      startLine: 10,
      endLine: 22,
    });
    await doReview(ctx, { cache: cacheOver(sdk) });

    expect(sdk.calls).toHaveLength(1);
    const call = sdk.calls[0]!;
    expect(call.cachePrefixMessages).toBe(2);
    expect(call.messages).toHaveLength(3);

    const split = buildCachedReviewPrompt(ctx);
    expect(call.messages[0]).toEqual({
      role: "system",
      content: buildSystemPrompt({ policyRevision: ctx.policy_revision }),
    });
    expect(call.messages[1]).toEqual({ role: "user", content: split.stablePrefix });
    expect(call.messages[2]).toEqual({ role: "user", content: split.chunkSuffix });

    // the per-chunk diff lives ONLY past the boundary.
    expect(call.messages[1]!["content"]).not.toContain(ctx.chunk.body);
    expect(call.messages[2]!["content"]).toContain(ctx.chunk.body);
  });

  it("PIN: the stable prefix bytes are IDENTICAL across two chunks of the same review", async () => {
    const sdk = new CapturingSdk();
    const cache = cacheOver(sdk);
    await doReview(
      contextForChunk({
        path: "src/app/handler.ts",
        body: "export function handler(): Response {\n  return new Response('ok');\n}",
        startLine: 10,
        endLine: 22,
      }),
      { cache },
    );
    await doReview(
      contextForChunk({
        path: "src/app/router.ts",
        body: "export const route = (p: string): string => p.toLowerCase();",
        startLine: 1,
        endLine: 40,
      }),
      { cache },
    );

    expect(sdk.calls).toHaveLength(2);
    const [a, b] = sdk.calls as [CapturedCall, CapturedCall];
    // everything at or before the cache boundary is byte-identical…
    expect(a.messages[0]).toEqual(b.messages[0]);
    expect(a.messages[1]!["content"]).toBe(b.messages[1]!["content"]);
    // …the tool schemas too (they render BEFORE system in the prompt prefix)…
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    // …and only the per-chunk suffix differs.
    expect(a.messages[2]!["content"]).not.toBe(b.messages[2]!["content"]);
    expect(a.cachePrefixMessages).toBe(2);
    expect(b.cachePrefixMessages).toBe(2);
  });
});
