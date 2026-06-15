// LlmBackedRerankPort — a bounded LLM reranker. Implements {@link LlmRerankerPort}: a small LLM (Haiku) scores each
// RRF-fused candidate in [0,1] for relevance to the query; LlmRerank keeps the top-5.
//
// Bounded on three axes the user asked for:
//   - TIMEOUT: a soft wall-clock bound. The SAME AbortSignal that fires the timeout is threaded into
//     invokeModel (F8 / P1-D), so on timeout the in-flight Bedrock call is ABORTED — not left running in
//     the background charging its cost. The bound is now on both review latency AND the request.
//   - COST CAP: enforced INSIDE invokeModel (BedrockBudgetExceededError). Unlike the curator (which
//     re-raises it), rerank is optional polish — a cost-cap breach maps to LlmRerankUnavailableError so
//     LlmRerank.apply falls back to the RRF order instead of failing the review.
//   - TRACE ROWS: emitted by invokeModel (telemetry.llm_calls + Langfuse), attributed to the PR's
//     installation_id + the `retrieval_rerank` purpose bucket.
//
// FALLBACK: every failure (role resolution, timeout, cost cap, invocation error, malformed scores) is
// mapped to {@link LlmRerankUnavailableError}; {@link LlmRerank.apply} catches it and falls back to the
// RRF order with degraded=true, so a rerank flake never fails the review.
//
// OPT-IN: IdentityRerankPort stays the safe default. The retrieve_knowledge activity constructs THIS
// port per-invocation with the query's installation_id (cost attribution) + a configured "secondary"
// role; until the owner seeds that role + flips the wiring, identity rerank runs. The
// port carries installation_id at construction because LlmRerankerPort.rerank() does not receive it.

import { createHash } from "node:crypto";

import { transportAbortSignal } from "#platform/transport_timeout.js";

import { BedrockBudgetExceededError } from "#backend/cost/enforcer.js";
import type { LlmClient } from "#backend/integrations/llm/client.js";
import { purposeChunkId } from "#backend/integrations/llm/invocation_ledger.js";
import { staticPurposeModelResolver, type PurposeModelResolverLike } from "#backend/llm/purpose_model_resolver.js";
import { LlmRerankUnavailableError, type LlmRerankerPort } from "#backend/retrieval/llm_rerank.js";

import type { KnowledgeChunkV1 } from "#contracts/knowledge_chunks.v1.js";
import type { LlmMessage } from "#contracts/llm_message.v1.js";

/** The narrow cache the reranker resolves its LlmClient from (mirrors LlmClientCache.forRole). */
export type RerankLlmCacheLike = {
  forRole(role: string): Promise<LlmClient>;
};

/** Cost-attribution bucket for rerank spend (distinct from review / curation). */
const RERANK_PURPOSE = "retrieval_rerank";
const RERANK_TOOL_NAME = "submit_relevance_scores";
/** Per-candidate body snippet rendered into the prompt — enough signal, bounded prompt cost. */
const BODY_SNIPPET_CHARS = 600;
const DEFAULT_TIMEOUT_MS = 4_000;
/** The scores array is tiny (≤ pre-rerank-top-k floats) — a small completion cap keeps cost down. */
const RERANK_MAX_TOKENS = 256;

const RERANK_SYSTEM_PROMPT =
  "You rank candidate knowledge documents by their relevance to a code-review query. You will be given " +
  "the query and a numbered list of candidates. Call the submit_relevance_scores tool with one score " +
  "in the range [0.0, 1.0] for EACH candidate, in the SAME order and the SAME count as the list. A " +
  "higher score means more relevant. Do not add commentary.";

/** Structured-output tool: one relevance score in [0,1] per candidate, in order. */
export const RERANK_TOOL_SCHEMA = {
  name: RERANK_TOOL_NAME,
  description:
    "Submit one relevance score in [0.0, 1.0] for each candidate document, in the SAME order and count " +
    "as the numbered list.",
  input_schema: {
    type: "object",
    properties: {
      scores: {
        type: "array",
        items: { type: "number", minimum: 0, maximum: 1 },
        description: "One score per candidate; same order; same length as the candidate list.",
      },
    },
    required: ["scores"],
  },
} as const;

/**
 * de-Temporal Phase 2 (D2 / W2.2) — the tool-schema-version component of the rerank's LLM-invocation
 * idempotency key. A content-addressable digest of RERANK_TOOL_SCHEMA: a tool-schema change (which changes
 * the SHAPE of the structured output, and therefore the parse) changes the key, so a stale stored response
 * is NOT replayed. Per-site (distinct from the other PR-level purposes' digests). `createHash` is the
 * gate-sanctioned hashing primitive (clock_random gate bans random fns, NOT createHash; mirrors
 * review_activity.ts:55).
 */
export const RERANK_TOOL_SCHEMA_VERSION = `rrts-${createHash("sha256")
  .update(Buffer.from(JSON.stringify(RERANK_TOOL_SCHEMA), "utf-8"))
  .digest("hex")
  .slice(0, 16)}`;

/** Typed soft-timeout marker (internal; mapped to LlmRerankUnavailableError below). */
class RerankTimeoutError extends Error {
  public constructor(ms: number) {
    super(`rerank LLM call exceeded ${ms}ms`);
    this.name = "RerankTimeoutError";
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Sentinel the timeout branch resolves with (so a won race never leaves an unhandled rejection). */
const TIMED_OUT: unique symbol = Symbol("rerank-timeout");

/**
 * Race `p` against a soft timeout driven by `signal` (the caller creates it via {@link transportAbortSignal}
 * and ALSO passes it into invokeModel, so a timeout cancels the in-flight call — F8 / P1-D). The timeout
 * branch RESOLVES with {@link TIMED_OUT} (never rejects), so when `p` wins the still-pending timeout settles
 * harmlessly. Throws {@link RerankTimeoutError} when the signal aborts first.
 */
async function withTimeout<T>(p: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    if (signal.aborted) {
      resolve(TIMED_OUT);
      return;
    }
    signal.addEventListener("abort", () => resolve(TIMED_OUT), { once: true });
  });
  const winner = await Promise.race([p, timeout]);
  if (winner === TIMED_OUT) {
    throw new RerankTimeoutError(ms);
  }
  return winner;
}

/** Render the user prompt: the query + a numbered, snippet-clamped candidate list. */
function buildRerankUserMessage(
  query: string,
  candidates: ReadonlyArray<KnowledgeChunkV1>,
): string {
  const lines: Array<string> = [`Query: ${query}`, "", "Candidates:"];
  candidates.forEach((c, i) => {
    const snippet = c.body.slice(0, BODY_SNIPPET_CHARS).replace(/\s+/g, " ").trim();
    lines.push(`${i + 1}. [${c.relative_path}] ${snippet}`);
  });
  lines.push("", `Return exactly ${candidates.length} score(s) via submit_relevance_scores.`);
  return lines.join("\n");
}

/** Extract the scores array from the first well-formed submit_relevance_scores tool_use block. */
function parseScores(
  blocks: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<number> | null {
  for (const block of blocks) {
    if (block["type"] !== "tool_use" || block["name"] !== RERANK_TOOL_NAME) {
      continue;
    }
    const input = block["input"];
    if (input === null || typeof input !== "object") {
      continue;
    }
    const scores = (input as { scores?: unknown }).scores;
    if (
      Array.isArray(scores) &&
      scores.every((s) => typeof s === "number" && Number.isFinite(s))
    ) {
      return scores as ReadonlyArray<number>;
    }
  }
  return null;
}

/**
 * LLM-backed {@link LlmRerankerPort}. Carries `installationId` (cost attribution) since the port
 * interface does not pass it. Construct per retrieve_knowledge invocation with the query's id.
 */
export class LlmBackedRerankPort implements LlmRerankerPort {
  private readonly cache: RerankLlmCacheLike;
  private readonly installationId: string;
  private readonly timeoutMs: number;
  private readonly modelOverride: string | undefined;
  // de-Temporal Phase 2 (D2 / W2.2) — OPTIONAL review/PR identity for the LLM-invocation ledger. The
  // LlmRerankerPort.rerank() signature is fixed ({query, candidates}) and RetrieveKnowledgeInputV1 carries
  // no review_id, so review_id is threaded as an ADDITIVE OPTIONAL constructor field. When PRESENT, the
  // paid rerank call passes an idempotency context (keyed by purposeChunkId("rerank")), so a retry replays
  // the stored scores instead of buying a second Haiku completion. When ABSENT (the current wiring until a
  // review_id is plumbed through), the call carries no idempotency context → no ledgering → back-compat
  // with the Temporal-legacy path (invoke, no replay) — back-compat with no ledgering.
  private readonly reviewId: string | undefined;

  private readonly resolver: PurposeModelResolverLike;

  public constructor(args: {
    cache: RerankLlmCacheLike;
    installationId: string;
    timeoutMs?: number;
    modelOverride?: string;
    /** de-Temporal Phase 2 (D2) — additive optional; absent → no ledgering (back-compat). */
    reviewId?: string;
    resolver?: PurposeModelResolverLike;
  }) {
    this.cache = args.cache;
    this.installationId = args.installationId;
    this.timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.modelOverride = args.modelOverride;
    this.reviewId = args.reviewId;
    this.resolver = args.resolver ?? staticPurposeModelResolver;
  }

  public async rerank(args: {
    query: string;
    candidates: ReadonlyArray<KnowledgeChunkV1>;
  }): Promise<ReadonlyArray<number>> {
    const { query, candidates } = args;
    if (candidates.length === 0) {
      return [];
    }

    let client: LlmClient;
    try {
      client = await this.cache.forRole("secondary");
    } catch (e) {
      // A role-resolution failure (not-configured / disabled) → fall back to RRF order.
      throw new LlmRerankUnavailableError(`rerank role resolution failed: ${errMsg(e)}`);
    }

    const messages: Array<LlmMessage> = [
      { role: "system", content: RERANK_SYSTEM_PROMPT },
      { role: "user", content: buildRerankUserMessage(query, candidates) },
    ];
    // Haiku (cheap, fast) for rerank — the curator's secondary model. An explicit override wins (tests).
    const model = this.modelOverride ?? (await this.resolver.resolve("analysis_curator"));

    // F8 / P1-D: ONE signal drives both the soft-timeout race AND the in-flight invokeModel call, so a
    // timeout aborts the Bedrock request instead of leaving it to run + bill in the background.
    const timeoutSignal = transportAbortSignal(this.timeoutMs);
    let result: Awaited<ReturnType<LlmClient["invokeModel"]>>;
    try {
      result = await withTimeout(
        client.invokeModel({
          role: "secondary",
          model: model as Parameters<LlmClient["invokeModel"]>[0]["model"],
          messages,
          tools: [RERANK_TOOL_SCHEMA as unknown as Record<string, unknown>],
          maxTokens: RERANK_MAX_TOKENS,
          purpose: RERANK_PURPOSE,
          installationId: this.installationId,
          signal: timeoutSignal,
          // de-Temporal Phase 2 (D2 / W2.2 / F9) — ledger this PR-level paid call by PURPOSE, but ONLY when a
          // review_id was threaded in (additive optional). The stable key is review_id + the purpose chunk-key
          // surrogate (purposeChunkId("rerank"), E8) + role + model + prompt hash + RERANK_TOOL_SCHEMA_VERSION.
          // run_id is deliberately NOT in the key (D2: output need not change per run). On a retry the stored
          // scores replay instead of buying a second Haiku completion. F9: the SAME "rerank" token drives BOTH
          // the chunk-key surrogate AND the metric purpose label. ABSENT review_id → no idempotency context →
          // no ledgering (back-compat with the Temporal-legacy path). The client also no-ops when it has no
          // ledger (unit tests / platform jobs).
          ...(this.reviewId !== undefined
            ? {
                idempotency: {
                  reviewId: this.reviewId,
                  chunkId: purposeChunkId("rerank"),
                  toolSchemaVersion: RERANK_TOOL_SCHEMA_VERSION,
                  ledgerPurpose: "rerank",
                },
              }
            : {}),
        }),
        timeoutSignal,
        this.timeoutMs,
      );
    } catch (e) {
      // Cost-cap breach / invocation failure / soft timeout → rerank is best-effort polish, so map to
      // LlmRerankUnavailableError (LlmRerank.apply falls back to RRF order). invokeModel already enforced
      // the cost cap + emitted the trace row. UNLIKE the curator, we do NOT re-raise the budget error:
      // skipping rerank degrades quality but loses no findings.
      if (e instanceof BedrockBudgetExceededError) {
        throw new LlmRerankUnavailableError(`rerank cost-cap reached: ${e.message}`);
      }
      throw new LlmRerankUnavailableError(`rerank LLM call failed: ${errMsg(e)}`);
    }

    const scores = parseScores([...result.raw_content_blocks]);
    if (scores === null) {
      throw new LlmRerankUnavailableError(
        "rerank response had no parseable submit_relevance_scores tool_use block",
      );
    }
    // A score-count mismatch is intentionally NOT raised here — LlmRerank.apply detects it and falls
    // back, so the single mismatch-handling path lives in one place.
    return scores;
  }
}
