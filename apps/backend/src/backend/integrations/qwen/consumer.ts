// QwenEmbeddingsConsumer — port of the frozen Python
// vendor/codemaster-py/codemaster/integrations/qwen/consumer.py
// (Sprint 20 megasprint / S17.X-qwen-embedder-wiring; ADR-0015 closure).
//
// Production {@link EmbeddingsPort} impl against the platform-team-operated Qwen3 HTTP service.
//
// Wire contract (FAITHFUL to the frozen Python):
//   - POST {dsn}/embed                            (dsn trailing slash stripped at construction)
//   - Request body: {texts, model_name, purpose}  (the EmbedRequest JSON dump — exact keys)
//   - NO auth header (the platform service is reached over the mesh; auth is mTLS at the boundary).
//   - 10s default per-call timeout, NO retry (a single attempt; the caller decides on backoff via the
//     typed error).
//
// Status mapping (1:1 with the Python):
//   - 200 + valid EmbedResult shape            → EmbedResult
//   - 200 + unexpected shape                   → EmbeddingsConnectivityError (transient contract drift)
//   - 429                                      → EmbeddingsRateLimitedError
//   - 5xx                                      → EmbeddingsConnectivityError
//   - other 4xx                                → EmbeddingsValidationError
//   - connect error / timeout / network error  → EmbeddingsConnectivityError
//   - any other status (1xx/3xx)               → EmbeddingsConnectivityError (defensive)

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

/** Strip a trailing slash; the adapter appends `/embed` (Python `_normalise_dsn`). */
function normaliseDsn(dsn: string): string {
  return dsn.replace(/\/+$/, "");
}

/** Truncate a response-body snippet for an error message (Python `resp.text[:200]`). */
function snippet(bodyText: string): string {
  return bodyText.slice(0, 200);
}

/**
 * Narrow an arbitrary JSON value to an {@link EmbedResult}. Mirrors the Python
 * `EmbedResult.model_validate(resp.json())` — a wrong shape raises (the caller maps it to a transient
 * connectivity error). The Pydantic model coerces `vectors` items to floats and requires
 * `model_name` / `model_version` strings; we do the structural equivalent.
 */
function parseEmbedResult(body: unknown): EmbedResult {
  if (typeof body !== "object" || body === null) {
    throw new Error(`response is not a JSON object: ${typeof body}`);
  }
  const obj = body as Record<string, unknown>;
  const rawVectors = obj["vectors"];
  if (!Array.isArray(rawVectors)) {
    throw new Error(`'vectors' field is not a list: ${typeof rawVectors}`);
  }
  const vectors: Array<Array<number>> = [];
  for (const row of rawVectors) {
    if (!Array.isArray(row)) {
      throw new Error(`'vectors' entry is not a list: ${typeof row}`);
    }
    const vec: Array<number> = [];
    for (const x of row) {
      if (typeof x !== "number" || !Number.isFinite(x)) {
        throw new Error(`'vectors[][]' entry is not a finite number: ${typeof x}`);
      }
      vec.push(x);
    }
    vectors.push(vec);
  }
  const modelName = obj["model_name"];
  if (typeof modelName !== "string") {
    throw new Error(`'model_name' field is not a string: ${typeof modelName}`);
  }
  const modelVersion = obj["model_version"];
  if (typeof modelVersion !== "string") {
    throw new Error(`'model_version' field is not a string: ${typeof modelVersion}`);
  }
  // cache_hits defaults to 0 (Python `cache_hits: int = 0`).
  const rawCacheHits = obj["cache_hits"];
  const cacheHits =
    rawCacheHits === undefined
      ? 0
      : typeof rawCacheHits === "number" && Number.isFinite(rawCacheHits)
        ? Math.trunc(rawCacheHits)
        : (() => {
            throw new Error(`'cache_hits' field is not a number: ${typeof rawCacheHits}`);
          })();
  return { vectors, model_name: modelName, model_version: modelVersion, cache_hits: cacheHits };
}

export type QwenEmbeddingsConsumerOptions = {
  dsn: string;
  http?: EmbeddingsHttpClient;
  timeoutSeconds?: number;
};

/** HTTP-based {@link EmbeddingsPort} impl against the platform-team Qwen3 service. */
export class QwenEmbeddingsConsumer implements EmbeddingsPort {
  private readonly dsn: string;
  private readonly http: EmbeddingsHttpClient;

  public constructor({ dsn, http, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS }: QwenEmbeddingsConsumerOptions) {
    this.dsn = normaliseDsn(dsn);
    this.http = http ?? new FetchEmbeddingsHttpClient({ timeoutSeconds });
  }

  public async embed(req: EmbedRequest): Promise<EmbedResult> {
    validateEmbedRequest(req);
    const url = `${this.dsn}/embed`;
    // The EmbedRequest JSON dump — exact Python wire keys {texts, model_name, purpose}.
    const jsonBody = { texts: [...req.texts], model_name: req.model_name, purpose: req.purpose };

    let resp;
    try {
      resp = await this.http.post({ url, headers: {}, jsonBody });
    } catch (e) {
      if (e instanceof EmbeddingsTransportError) {
        throw new EmbeddingsConnectivityError(`qwen network error: ${e.message}`);
      }
      throw e;
    }

    if (resp.status === HTTP_OK) {
      try {
        return parseEmbedResult(JSON.parse(resp.bodyText) as unknown);
      } catch (e) {
        // Treat an unexpected 200 shape as transient (platform-team service may have shipped a
        // contract change; back off rather than surface as a permanent failure).
        throw new EmbeddingsConnectivityError(
          `qwen 200 with unexpected response shape: ${e instanceof Error ? e.message : "unknown"}`,
        );
      }
    }
    if (resp.status === HTTP_TOO_MANY_REQUESTS) {
      throw new EmbeddingsRateLimitedError(`qwen rate-limited (429): ${snippet(resp.bodyText)}`);
    }
    if (resp.status >= HTTP_SERVER_ERROR_MIN && resp.status < HTTP_SERVER_ERROR_MAX) {
      throw new EmbeddingsConnectivityError(`qwen ${resp.status}: ${snippet(resp.bodyText)}`);
    }
    if (resp.status >= HTTP_CLIENT_ERROR_MIN && resp.status < HTTP_SERVER_ERROR_MIN) {
      throw new EmbeddingsValidationError(`qwen ${resp.status}: ${snippet(resp.bodyText)}`);
    }
    // Defensive: any other status code (1xx/3xx/etc.) is unexpected; treat as connectivity error.
    throw new EmbeddingsConnectivityError(
      `qwen unexpected status ${resp.status}: ${snippet(resp.bodyText)}`,
    );
  }
}
