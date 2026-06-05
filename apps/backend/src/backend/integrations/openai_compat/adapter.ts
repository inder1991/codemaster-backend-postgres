// OpenAICompatibleEmbeddingsAdapter — port of the frozen Python
// vendor/codemaster-py/codemaster/integrations/openai_compat/adapter.py (ADR-0059).
//
// Production {@link EmbeddingsPort} impl speaking the OpenAI Embeddings API wire contract. Compatible
// providers: OpenAI, Ollama (`/v1/embeddings`), vLLM, Together, LM Studio, OpenRouter, TGI bridges.
//
// Wire contract (FAITHFUL to the frozen Python):
//   - POST {base_url}/v1/embeddings              (base_url trailing slash stripped at construction)
//   - Request body: {model: <constructor model_name>, input: [text, ...]}
//   - Header: Authorization: Bearer <api_key>    (Ollama ignores it; OpenAI requires a real sk-...).
//   - Response 200: {data: [{embedding: [...]}, ...], model: "..."}
//
// The EmbedRequest.model_name is IGNORED — the model is fixed at construction (operators rotate the
// model via credential rotation, NOT per-call). The response `model` is echoed into BOTH
// `EmbedResult.model_name` and `EmbedResult.model_version` (the OpenAI protocol has no separate version
// field); `cache_hits` is hardcoded 0 (OpenAI-compat does not surface it).
//
// Status mapping mirrors QwenEmbeddingsConsumer's taxonomy so the EmbeddingsPort surface stays uniform:
//   200 ok → EmbedResult; 200 bad-shape → Connectivity; 429 → RateLimited; 5xx → Connectivity;
//   other 4xx → Validation; connect/timeout/network → Connectivity; other status → Connectivity.

import {
  type EmbedRequest,
  type EmbedResult,
  type EmbeddingsHttpClient,
  type EmbeddingsPort,
  DEFAULT_TIMEOUT_SECONDS,
  EmbeddingsConnectivityError,
  EmbeddingsRateLimitedError,
  EmbeddingsTransportError,
  EmbeddingsValidationError,
  FetchEmbeddingsHttpClient,
  validateEmbedRequest,
} from "#backend/adapters/embeddings_port.js";

// HTTP status sentinels (module-scope, mirroring the Python named constants).
const HTTP_OK = 200;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_SERVER_ERROR_MAX = 600; // exclusive upper bound

/** Strip a trailing slash; the adapter appends `/v1/embeddings` (Python `_normalise_base_url`). */
function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** Truncate a response-body snippet for an error message (Python `resp.text[:200]`). */
function snippet(bodyText: string): string {
  return bodyText.slice(0, 200);
}

/**
 * Translate an OpenAI Embeddings response body to an {@link EmbedResult}. 1:1 with the Python
 * `_openai_body_to_embed_result`: `data[].embedding` lists → vectors; the response `model` echoes into
 * both `model_name` and `model_version`; `cache_hits` is 0. A wrong shape throws (the caller maps it to
 * a transient connectivity error).
 */
function openaiBodyToEmbedResult(body: unknown): EmbedResult {
  if (typeof body !== "object" || body === null) {
    throw new Error(`openai response is not a JSON object: ${typeof body}`);
  }
  const obj = body as Record<string, unknown>;
  const data = obj["data"];
  if (!Array.isArray(data)) {
    throw new Error(`openai response 'data' field is not a list: ${typeof data}`);
  }
  const vectors: Array<Array<number>> = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`openai response 'data' entry not a dict: ${typeof entry}`);
    }
    const embedding = (entry as Record<string, unknown>)["embedding"];
    if (!Array.isArray(embedding)) {
      throw new Error(`openai response 'data[].embedding' not a list: ${typeof embedding}`);
    }
    const vec: Array<number> = [];
    for (const x of embedding) {
      if (typeof x !== "number" || !Number.isFinite(x)) {
        throw new Error(`openai response 'data[].embedding[]' not a finite number: ${typeof x}`);
      }
      vec.push(x);
    }
    vectors.push(vec);
  }
  const rawModel = obj["model"];
  const model = rawModel === undefined ? "unknown" : rawModel;
  if (typeof model !== "string") {
    throw new Error(`openai response 'model' field not a string: ${typeof model}`);
  }
  return { vectors, model_name: model, model_version: model, cache_hits: 0 };
}

export type OpenAICompatibleEmbeddingsAdapterOptions = {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  http?: EmbeddingsHttpClient;
  timeoutSeconds?: number;
};

/** OpenAI Embeddings API wire-format {@link EmbeddingsPort} impl. */
export class OpenAICompatibleEmbeddingsAdapter implements EmbeddingsPort {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fixedModelName: string;
  private readonly http: EmbeddingsHttpClient;

  public constructor({
    baseUrl,
    apiKey,
    modelName,
    http,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  }: OpenAICompatibleEmbeddingsAdapterOptions) {
    this.baseUrl = normaliseBaseUrl(baseUrl);
    this.apiKey = apiKey;
    this.fixedModelName = modelName;
    this.http = http ?? new FetchEmbeddingsHttpClient({ timeoutSeconds });
  }

  /** The construction-time model id sent in every request body (Python `model_name` property). */
  public get modelName(): string {
    return this.fixedModelName;
  }

  public async embed(req: EmbedRequest): Promise<EmbedResult> {
    validateEmbedRequest(req);
    const url = `${this.baseUrl}/v1/embeddings`;
    // The construction-time model is authoritative; req.model_name is IGNORED (per ADR-0059).
    const jsonBody = { model: this.fixedModelName, input: [...req.texts] };
    const headers = { Authorization: `Bearer ${this.apiKey}` };

    let resp;
    try {
      resp = await this.http.post({ url, headers, jsonBody });
    } catch (e) {
      if (e instanceof EmbeddingsTransportError) {
        throw new EmbeddingsConnectivityError(`openai-compat network error: ${e.message}`);
      }
      throw e;
    }

    if (resp.status === HTTP_OK) {
      try {
        return openaiBodyToEmbedResult(JSON.parse(resp.bodyText) as unknown);
      } catch (e) {
        // Treat an unexpected 200 shape as transient (provider may have shipped a contract change;
        // back off rather than surface as a permanent failure).
        throw new EmbeddingsConnectivityError(
          `openai-compat 200 with unexpected response shape: ${e instanceof Error ? e.message : "unknown"}`,
        );
      }
    }
    if (resp.status === HTTP_TOO_MANY_REQUESTS) {
      throw new EmbeddingsRateLimitedError(
        `openai-compat rate-limited (429): ${snippet(resp.bodyText)}`,
      );
    }
    if (resp.status >= HTTP_SERVER_ERROR_MIN && resp.status < HTTP_SERVER_ERROR_MAX) {
      throw new EmbeddingsConnectivityError(`openai-compat ${resp.status}: ${snippet(resp.bodyText)}`);
    }
    if (resp.status >= HTTP_CLIENT_ERROR_MIN && resp.status < HTTP_SERVER_ERROR_MIN) {
      throw new EmbeddingsValidationError(`openai-compat ${resp.status}: ${snippet(resp.bodyText)}`);
    }
    // Defensive: any other status code (1xx/3xx/etc.) is unexpected; treat as connectivity error.
    throw new EmbeddingsConnectivityError(
      `openai-compat unexpected status ${resp.status}: ${snippet(resp.bodyText)}`,
    );
  }
}
