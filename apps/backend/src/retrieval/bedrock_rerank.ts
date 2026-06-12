// FOLLOW-UP (opus delta-review notes, refuted-but-acknowledged; revisit only if the reranker goes
// default-ON): (1) rerank spend is NOT counted against the W2.1 cost cap — the rerank API is a
// separate, cheap, opt-in cost outside the per-review LLM budget; (2) the Bedrock credential is
// decrypted per-retrieval (no TTL cache) when enabled — one Vault Transit decrypt per review-retrieval,
// acceptable for an opt-in default-OFF feature. Both fine while default-OFF; cap + cache if it ships on.
//
// BedrockRerankPort — W1.3 RH9 (master-hardening-plan): the OPTIONAL production reranker. Calls the
// AWS Bedrock RERANK API — the native rerank models (cohere.rerank-v3-5:0 / amazon.rerank-v1:0)
// invoked over the bedrock-runtime `/model/{modelId}/invoke` HTTP endpoint with their NATIVE
// query+documents request shape. This is DISTINCT from the invoke/converse Messages API the review
// fan-out uses (integrations/llm/client.ts is untouched): a rerank model takes the query plus a
// document list and returns `{results: [{index, relevance_score}]}` — no prompt, no completion, no
// tool_use parsing — purpose-built for re-scoring, cheaper and faster than the prompt-based
// LlmBackedRerankPort sibling.
//
// ── Auth / region (the SAME credential pattern as the rest of the Bedrock integration) ───────────
// The platform Bedrock credential is the bearer token (AWS_BEARER_TOKEN_BEDROCK-style API key) the
// admin rotates via /api/admin/llm-provider-config, stored Vault-Transit-encrypted on
// core.llm_provider_settings. The wiring injects {@link BedrockRerankCredentialsSource} (production:
// PostgresLlmProviderSettingsRepo.readDecryptedForProvider("bedrock")) and this adapter sends
// `Authorization: Bearer <token>` to `bedrock-runtime.<region>.amazonaws.com` — byte-compatible with
// the bearer path `@anthropic-ai/bedrock-sdk` uses for the review calls (no SigV4, no IAM chain).
// The region resolves config-first ({@link RerankConfig.region}), falling back to the credential
// row's region. The plaintext token is consumed transiently in the header closure — NEVER logged.
//
// ── Fail-open (a rerank fault must NEVER fail the review) ────────────────────────────────────────
// EVERY failure axis — missing/disabled credentials, missing region, HTTP error status, transport
// abort (the {@link transportAbortSignal} soft timeout), malformed payload — is mapped to
// {@link LlmRerankUnavailableError} after a structured WARN + a {@link getMeter} fault counter.
// {@link LlmRerank.apply} catches exactly that error and falls back to the pre-rerank order with
// degraded=true, so the review ships without the rerank polish instead of failing.
//
// ── top-N submission cap ─────────────────────────────────────────────────────────────────────────
// Only the leading `topN` candidates (the best of the pre-rerank RRF/merge order) are submitted —
// the operator's cost/latency bound. The unsubmitted tail receives {@link UNSUBMITTED_CANDIDATE_SCORE}
// (strictly below the rerank API's [0,1] relevance range), so under LlmRerank's stable sort it keeps
// its pre-rerank relative order BEHIND every re-scored candidate.

import { transportAbortSignal } from "#platform/transport_timeout.js";
import { type Counter, getMeter } from "#platform/observability/metrics.js";

import { LlmRerank, LlmRerankUnavailableError, type LlmRerankerPort } from "#backend/retrieval/llm_rerank.js";
import {
  type RerankConfig,
  type RerankStoredSettings,
  resolveEffectiveRerankConfig,
} from "#backend/retrieval/rerank_config.js";

import type { KnowledgeChunkV1 } from "#contracts/knowledge_chunks.v1.js";

// ─── Constants ────────────────────────────────────────────────────────────────────────────────────

/** Soft wall-clock bound on the rerank HTTP call (the same 4s budget as the sibling LLM-backed
 *  reranker). On expiry the fetch rejects with AbortError → fail-open fallback. */
export const DEFAULT_RERANK_TIMEOUT_MS = 4_000;

/** Per-document character clamp — bounds the request payload; the rerank models truncate long
 *  documents server-side anyway, so the tail carries no ranking signal worth shipping. */
export const RERANK_DOC_MAX_CHARS = 2_000;

/** Score assigned to candidates BEYOND the top-N submission cap: strictly below the rerank API's
 *  [0,1] relevance range, so the unsubmitted tail sorts after every re-scored candidate while the
 *  stable sort preserves its pre-rerank relative order. */
export const UNSUBMITTED_CANDIDATE_SCORE = -1;

/** Score for a SUBMITTED candidate the service omitted from `results` (defensive — with
 *  top_n == documents.length every index should come back): bottom of the valid range, above the
 *  unsubmitted tail. */
const OMITTED_SUBMITTED_SCORE = 0;

// ─── Observability (WARN + getMeter; the established degradation idiom) ──────────────────────────

/** Grafana-query-stable fault-counter name (renaming requires ADR). */
export const RERANK_FAULT_METRIC_NAME = "codemaster_retrieval_rerank_fault_total";

const METER = getMeter("codemaster.retrieval");
const RERANK_FAULT_COUNTER: Counter = METER.createCounter(RERANK_FAULT_METRIC_NAME, {
  description:
    "Count of Bedrock rerank calls that fell back to the pre-rerank order (fail-open), labeled by " +
    "reason ∈ {credentials_missing, region_missing, http_status, transport, malformed_response, " +
    "resolver_failed}. A sustained rate means the reranker is configured but not delivering.",
});

/** Structured WARN + bounded-cardinality fault counter, then the typed unavailable error the
 *  {@link LlmRerank.apply} fallback catches. The bearer token never reaches `detail`. */
function rerankFault(reason: string, detail: string): LlmRerankUnavailableError {
  console.warn(
    JSON.stringify({ event: "bedrock_rerank_failed", rule: "bedrock-rerank-fail-open", reason, detail }),
  );
  try {
    RERANK_FAULT_COUNTER.add(1, { reason });
  } catch {
    // Telemetry never perturbs retrieval.
  }
  return new LlmRerankUnavailableError(`bedrock rerank ${reason}: ${detail}`);
}

// ─── Seams ────────────────────────────────────────────────────────────────────────────────────────

/** The decrypted platform Bedrock credential slice the adapter consumes (production source:
 *  PostgresLlmProviderSettingsRepo.readDecryptedForProvider("bedrock") → {apiKey, region}).
 *  `null` ⇒ no ENABLED bedrock credential row exists — the adapter fails open. */
export type BedrockRerankCredentials = {
  readonly apiKey: string;
  readonly region: string | null;
};

/** Credential resolution seam — called per rerank so an operator rotation/disable takes effect on
 *  the next retrieval without a pod restart (the credentials-provider freshness posture). */
export type BedrockRerankCredentialsSource = () => Promise<BedrockRerankCredentials | null>;

/** The minimal fetch slice the adapter drives (default: global fetch). Structural so tests inject a
 *  recorder without touching the network. */
export type RerankHttpResponse = {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
};
export type RerankHttpClient = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<RerankHttpResponse>;

const defaultHttp: RerankHttpClient = (url, init) => fetch(url, init);

// ─── Request / response shapes ────────────────────────────────────────────────────────────────────

/** The bedrock-runtime InvokeModel endpoint for a rerank model (model id URL-encoded — the `:0`
 *  revision suffix must not read as a path segment). */
export function bedrockRerankEndpoint(region: string, modelId: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`;
}

/** Render one candidate into the rerank document string: path header + clamped body (the path is
 *  real ranking signal — file naming carries topic information). */
function toDocument(c: KnowledgeChunkV1): string {
  return `${c.relative_path}\n${c.body.slice(0, RERANK_DOC_MAX_CHARS)}`;
}

/** One `{index, relevance_score}` entry, structurally narrowed (the manual-narrow idiom of the
 *  sibling parseScores — this is a deterministic service payload, not LLM free text, so it is not a
 *  registered LLM-output contract). */
type RerankResult = { readonly index: number; readonly relevance_score: number };

/** Narrow the response body to the results list; null on ANY shape violation (the caller fails open).
 *  `submittedCount` bounds the indices — an index outside the submitted window is a malformed
 *  response, not a mappable score. */
export function parseRerankResults(
  raw: string,
  submittedCount: number,
): ReadonlyArray<RerankResult> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return null;
  }
  const out: Array<RerankResult> = [];
  for (const entry of results) {
    if (entry === null || typeof entry !== "object") {
      return null;
    }
    const index = (entry as { index?: unknown }).index;
    const score = (entry as { relevance_score?: unknown }).relevance_score;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= submittedCount ||
      typeof score !== "number" ||
      !Number.isFinite(score)
    ) {
      return null;
    }
    out.push({ index, relevance_score: score });
  }
  return out;
}

// ─── The adapter ──────────────────────────────────────────────────────────────────────────────────

export type BedrockRerankPortOptions = {
  /** A {@link RERANK_MODELS} member (validated at every config ingress). */
  readonly modelId: string;
  /** Config region override; null → the credential row's region. */
  readonly region: string | null;
  /** How many leading candidates are submitted for re-scoring (cost/latency bound). */
  readonly topN: number;
  readonly credentials: BedrockRerankCredentialsSource;
  /** HTTP seam (default: global fetch). */
  readonly http?: RerankHttpClient;
  readonly timeoutMs?: number;
};

/**
 * The Bedrock rerank-API {@link LlmRerankerPort}. Returns one score per candidate IN INPUT ORDER
 * (the port contract — {@link LlmRerank.apply} does the reorder + top-5 cut), throwing
 * {@link LlmRerankUnavailableError} on every fault so the slot-level fallback engages.
 */
export class BedrockRerankPort implements LlmRerankerPort {
  private readonly modelId: string;
  private readonly region: string | null;
  private readonly topN: number;
  private readonly credentials: BedrockRerankCredentialsSource;
  private readonly http: RerankHttpClient;
  private readonly timeoutMs: number;

  public constructor(options: BedrockRerankPortOptions) {
    this.modelId = options.modelId;
    this.region = options.region;
    this.topN = options.topN;
    this.credentials = options.credentials;
    this.http = options.http ?? defaultHttp;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RERANK_TIMEOUT_MS;
  }

  public async rerank(args: {
    query: string;
    candidates: ReadonlyArray<KnowledgeChunkV1>;
  }): Promise<ReadonlyArray<number>> {
    const { query, candidates } = args;
    if (candidates.length === 0) {
      return [];
    }

    let creds: BedrockRerankCredentials | null;
    try {
      creds = await this.credentials();
    } catch (e) {
      throw rerankFault("credentials_missing", `credential read failed: ${errMsg(e)}`);
    }
    if (creds === null) {
      throw rerankFault(
        "credentials_missing",
        "no enabled bedrock credential row (seed /api/admin/llm-provider-config)",
      );
    }

    const region = this.region ?? creds.region;
    if (region === null || region === "") {
      throw rerankFault(
        "region_missing",
        "no rerank region configured and the bedrock credential row has none",
      );
    }

    const submitted = candidates.slice(0, this.topN);
    const body: Record<string, unknown> = {
      query,
      documents: submitted.map(toDocument),
      top_n: submitted.length,
      // api_version is Cohere's versioning field; the Amazon rerank body has no such key.
      ...(this.modelId.startsWith("cohere.") ? { api_version: 2 } : {}),
    };

    let response: RerankHttpResponse;
    try {
      response = await this.http(bedrockRerankEndpoint(region, this.modelId), {
        method: "POST",
        headers: {
          // Transient bearer use only — the token never leaves this header closure.
          authorization: `Bearer ${creds.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: transportAbortSignal(this.timeoutMs),
      });
    } catch (e) {
      // Timeout (AbortError) / DNS / connect failures — fail open.
      throw rerankFault("transport", errMsg(e));
    }

    const rawText = await responseText(response);
    if (!response.ok) {
      throw rerankFault(
        "http_status",
        `status=${response.status} model=${this.modelId} body=${rawText.slice(0, 200)}`,
      );
    }

    const results = parseRerankResults(rawText, submitted.length);
    if (results === null) {
      throw rerankFault(
        "malformed_response",
        `unparseable rerank payload (model=${this.modelId}): ${rawText.slice(0, 200)}`,
      );
    }

    // Map back onto the FULL candidate list, in input order (the port contract).
    const scores: Array<number> = candidates.map((_, i) =>
      i < submitted.length ? OMITTED_SUBMITTED_SCORE : UNSUBMITTED_CANDIDATE_SCORE,
    );
    for (const r of results) {
      scores[r.index] = r.relevance_score;
    }
    return scores;
  }
}

// ─── The per-retrieval override resolver (the rerankOverride-seam producer) ──────────────────────

/** Reads the persisted admin config row (production: api/admin/llm_catalog_write.readRerankSettings
 *  over the shared core pool; the wiring injects it so retrieval never imports the api layer). */
export type RerankSettingsReader = () => Promise<RerankStoredSettings | null>;

/** Produces the per-retrieval rerank override, or undefined when the effective config is disabled
 *  (the IdentityRerankPort pass-through then stands). */
export type BedrockRerankOverrideResolver = () => Promise<LlmRerank | undefined>;

/**
 * Build the per-retrieval Bedrock rerank resolver: re-reads the admin row EVERY retrieval (an admin
 * save/kill-flip takes effect on the next review, no redeploy — one single-row PK SELECT), resolves
 * the DB > env > default precedence ({@link resolveEffectiveRerankConfig}), and when enabled returns
 * a fresh {@link LlmRerank} over a {@link BedrockRerankPort} carrying that config.
 *
 * FAIL-OPEN: a settings-read fault degrades to the env baseline (WARN + fault counter) — a DB blip
 * neither fails retrieval nor silently diverges from the Helm intent.
 */
export function buildBedrockRerankOverrideResolver(args: {
  readSettings: RerankSettingsReader;
  credentials: BedrockRerankCredentialsSource;
  /** The boot-parsed Helm baseline (rerank_config.parseRerankEnv — fail-loud at parse, not here). */
  env: RerankConfig;
  http?: RerankHttpClient;
  timeoutMs?: number;
}): BedrockRerankOverrideResolver {
  return async (): Promise<LlmRerank | undefined> => {
    let row: RerankStoredSettings | null;
    try {
      row = await args.readSettings();
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "bedrock_rerank_failed",
          rule: "bedrock-rerank-fail-open",
          reason: "resolver_failed",
          detail: `rerank settings read failed; using the env baseline: ${errMsg(e)}`,
        }),
      );
      try {
        RERANK_FAULT_COUNTER.add(1, { reason: "resolver_failed" });
      } catch {
        // Telemetry never perturbs retrieval.
      }
      row = null;
    }
    const { config } = resolveEffectiveRerankConfig({ row, env: args.env });
    if (!config.enabled || config.modelId === null) {
      return undefined;
    }
    return new LlmRerank({
      port: new BedrockRerankPort({
        modelId: config.modelId,
        region: config.region,
        topN: config.topN,
        credentials: args.credentials,
        ...(args.http !== undefined ? { http: args.http } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      }),
    });
  };
}

/** Read the response body defensively (a failed body read is a transport-class fault → ""). */
async function responseText(response: RerankHttpResponse): Promise<string> {
  try {
    return await response.text();
  } catch (e) {
    console.warn(
      JSON.stringify({ event: "bedrock_rerank_body_read_failed", detail: errMsg(e) }),
    );
    return "";
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
