// EmbeddingsPort — narrow interface the retrieval + aggregation layers depend on (Sprint 10 retrieval
// pipeline). codemaster is a CONSUMER of an embedding service (platform-team Qwen3 over HTTP, or any
// OpenAI-Embeddings-compatible provider). The typed-error taxonomy lets callers choose between graceful
// degradation (fall back to lexical-only / skip the semantic merge) and hard failure.
//
// ── ADAPTER-LOCAL contracts (NOT #contracts schema-version models) ──
// EmbedRequest / EmbedResult are adapter-private wire types, never persisted, never carried across a
// Temporal activity boundary as a versioned contract. They live HERE in apps/backend (not in
// libs/contracts) and are validated structurally at the HTTP boundary.
//
// ── EmbeddingsPort is a TYPE (structural), not a class ──
// Production impls: QwenEmbeddingsConsumer (integrations/qwen/consumer.ts) and
// OpenAICompatibleEmbeddingsAdapter (integrations/openai_compat/adapter.ts). The
// RecordingEmbeddingsClient below is a DETERMINISTIC test/dev double — it is wired ONLY via the
// explicit `stub://recording` DSN sentinel in resolveEmbeddingsConsumer (dev environments without a
// real embedder), NEVER on a production-configured path.
//
// ── HTTP-transport seam ──
// Both production adapters POST over an INJECTED {@link EmbeddingsHttpClient} (mirroring
// FetchVaultHttpClient / FetchLangfuseHttpClient): production defaults to {@link
// FetchEmbeddingsHttpClient} (a thin global-`fetch` wrapper — NO new dependency); the transport
// timeout is armed via `transportAbortSignal` (the check_clock_random-sanctioned seam). Tests inject a
// recording transport that captures the request + returns scripted responses. There is NO faking stub
// on the production path — the production transport REALLY POSTs.

import { transportAbortSignal } from "#platform/transport_timeout.js";

// ─── Adapter-local wire contracts ──────────────────────────────────────────────────────────────

/**
 * One batch embed request.
 *
 * Field bounds (enforced by {@link validateEmbedRequest}):
 *   - `texts`: 1..128 items.
 *   - `model_name`: the platform model id (e.g. `"qwen3-embed-0.6b"`). NOTE: the OpenAI-compat
 *     adapter IGNORES this — its model is fixed at construction (credential rotation, not per-call).
 *   - `purpose`: why this embed is computed (`"review_query"`, `"confluence_chunk"`, `"in_repo_doc"`,
 *     `"portal"`, `"symbol"`, `"learning"`); free string on the wire.
 *
 * snake_case members match the platform service contract JSON keys POSTed to `/embed` exactly.
 */
export type EmbedRequest = {
  texts: ReadonlyArray<string>;
  model_name: string;
  purpose: string;
};

/**
 * Response to an embed request: one vector per input text.
 *
 *   - `vectors`: `vectors.length === req.texts.length` (the port invariant).
 *   - `model_name` / `model_version`: echoed from the service response.
 *   - `cache_hits`: how many of the inputs were served from the service's cache (0 when the
 *     provider does not surface it — OpenAI-compat hardcodes 0).
 */
export type EmbedResult = {
  vectors: ReadonlyArray<ReadonlyArray<number>>;
  model_name: string;
  model_version: string;
  cache_hits: number;
};

/**
 * The narrow interface the retrieval + aggregation layers depend on. `embed` returns one vector per
 * input text (`vectors.length === req.texts.length`).
 */
export type EmbeddingsPort = {
  embed(req: EmbedRequest): Promise<EmbedResult>;
};

// ─── Request validation ───────────────────────────────────────────────────────────────────────────

/** Lower / upper bounds on `EmbedRequest.texts`. */
export const MIN_TEXTS = 1;
export const MAX_TEXTS = 128;

/**
 * Validate an {@link EmbedRequest} against the field bounds. Throws {@link EmbeddingsValidationError}
 * on a malformed batch — caught locally (the same 4xx-class semantics the service would return) rather
 * than POSTed.
 */
export function validateEmbedRequest(req: EmbedRequest): void {
  if (req.texts.length < MIN_TEXTS) {
    throw new EmbeddingsValidationError(
      `embed request texts must have at least ${MIN_TEXTS} item(s); got ${req.texts.length}`,
    );
  }
  if (req.texts.length > MAX_TEXTS) {
    throw new EmbeddingsValidationError(
      `embed request texts must have at most ${MAX_TEXTS} item(s); got ${req.texts.length}`,
    );
  }
}

// ─── Typed exceptions ─────────────────────────────────────────────────────────────────────────────

/** Base for embeddings adapter errors. */
export class EmbeddingsError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EmbeddingsError";
  }
}

/**
 * Service unreachable / transient (Python `EmbeddingsConnectivityError`). The retrieval layer falls
 * back to lexical-only; the aggregation layer skips the semantic merge. Maps from: connection error,
 * timeout, 5xx, and an unexpected 200 shape (treated as a transient platform contract drift, NOT a
 * permanent failure).
 */
export class EmbeddingsConnectivityError extends EmbeddingsError {
  public constructor(message: string) {
    super(message);
    this.name = "EmbeddingsConnectivityError";
  }
}

/** Service rate-limited us; caller should back off. Maps from 429. */
export class EmbeddingsRateLimitedError extends EmbeddingsError {
  public constructor(message: string) {
    super(message);
    this.name = "EmbeddingsRateLimitedError";
  }
}

/**
 * Request shape rejected; non-retryable. Maps from a 4xx other than 429, and from local
 * {@link validateEmbedRequest} failures.
 */
export class EmbeddingsValidationError extends EmbeddingsError {
  public constructor(message: string) {
    super(message);
    this.name = "EmbeddingsValidationError";
  }
}

// ─── Test/dev implementation ─────────────────────────────────────────────────────────────────────

/** pgvector HNSW/ivfflat indexes on the `vector` type cap at 2000 dimensions. */
export const MAX_HNSW_VECTOR_DIM = 2000;

/**
 * Pure: resolve the deploy-time embedding dimension from `CODEMASTER_EMBEDDING_DIMENSION`
 * (default 1024). Validated to 1..{@link MAX_HNSW_VECTOR_DIM} — a native >2000 model must
 * Matryoshka-truncate its output (or wait for the `halfvec` day-2 path).
 */
export function resolveEmbeddingDim(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CODEMASTER_EMBEDDING_DIMENSION;
  if (raw === undefined || raw.trim() === "") {
    return 1024;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_HNSW_VECTOR_DIM) {
    throw new Error(
      `CODEMASTER_EMBEDDING_DIMENSION must be an integer in 1..${MAX_HNSW_VECTOR_DIM} ` +
        `(pgvector caps HNSW vector indexes at ${MAX_HNSW_VECTOR_DIM}; for a larger native dim, ` +
        `Matryoshka-truncate the model output or use the halfvec day-2 path). Got: ${raw}`,
    );
  }
  return n;
}

/**
 * Embedding dimensionality of the configured platform model (default 1024). Used by the deterministic
 * {@link RecordingEmbeddingsClient} and by the platform-model pgvector column width. The pgvector column
 * width (migration 0007) and `CODEMASTER_EMBEDDING_DIMENSION` MUST agree — both derive from this env.
 *
 * NOTE: the live OpenAI-compat / Ollama path returns the PROVIDER's dimensionality. The aggregation merge
 * uses cosine similarity, which is dim-agnostic, so it MUST NOT assert `vector.length === EMBEDDING_DIM`.
 * Only the platform-model pgvector write path cares about this exact width.
 */
export const EMBEDDING_DIM = resolveEmbeddingDim();

/**
 * Deterministic dev/test {@link EmbeddingsPort}. Records every call and returns a reproducible
 * synthetic vector per input text. Wired ONLY via the `stub://recording` DSN sentinel in
 * {@link resolveEmbeddingsConsumer} (dev environments without a real embedder); NEVER on a
 * production-configured path.
 *
 * ── Determinism ──
 * Cross-language reproduction of the CPython hash + Mersenne Twister PRNG is impractical. Because
 * this client only needs determinism WITHIN the TS runtime (the aggregation merge compares vectors
 * produced by the SAME client, with cosine), we use a fully self-contained, documented, reproducible
 * TS algorithm instead:
 *
 *   1. seed = FNV-1a-32 over the UTF-8 bytes of `text` (offset basis 2166136261, prime 16777619,
 *      mod 2**32). Empty string → the offset basis (2166136261).
 *   2. A 32-bit xorshift PRNG (xorshift32) seeded with `(seed | 1)` (avoid the zero fixed-point):
 *        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;   (all in uint32)
 *      Each step yields a uint32 `x`; the uniform float in [-1, 1] is `(x / 0xFFFFFFFF) * 2 - 1`.
 *   3. Emit {@link EMBEDDING_DIM} such floats, in order, as the vector.
 *
 * Same input → same vector (within a process AND across processes — there is no salt). A verifier can
 * reproduce any vector with the three steps above. `model_version` is the fixed sentinel `"test-v1"`.
 * `cache_hits` is 0 (this dev double does not simulate a cache).
 */
export class RecordingEmbeddingsClient implements EmbeddingsPort {
  /** Every request passed to {@link embed}, in call order (tests assert against this). */
  public readonly calls: Array<EmbedRequest> = [];
  private unreachable = false;
  private rateLimited = false;

  public async embed(req: EmbedRequest): Promise<EmbedResult> {
    if (this.unreachable) {
      throw new EmbeddingsConnectivityError("simulated connectivity failure");
    }
    if (this.rateLimited) {
      throw new EmbeddingsRateLimitedError("simulated rate limit");
    }
    validateEmbedRequest(req);
    this.calls.push(req);

    const vectors: Array<Array<number>> = [];
    for (const text of req.texts) {
      vectors.push(deterministicVector(text));
    }
    return {
      vectors,
      model_name: req.model_name,
      model_version: "test-v1",
      cache_hits: 0,
    };
  }

  /** Test-only: make the next `embed` raise {@link EmbeddingsConnectivityError}. */
  public simulateUnreachable(value = true): void {
    this.unreachable = value;
  }

  /** Test-only: make the next `embed` raise {@link EmbeddingsRateLimitedError}. */
  public simulateRateLimited(value = true): void {
    this.rateLimited = value;
  }

  /** Number of recorded calls (Python `call_count`). */
  public callCount(): number {
    return this.calls.length;
  }
}

/** FNV-1a-32 over the UTF-8 bytes of `text`. Returns a uint32. See {@link RecordingEmbeddingsClient}. */
function fnv1a32(text: string): number {
  const bytes = new TextEncoder().encode(text);
  let hash = 2166136261; // FNV offset basis (uint32)
  for (const byte of bytes) {
    hash ^= byte;
    // FNV prime 16777619; keep the product in uint32 via Math.imul + >>> 0.
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The deterministic synthetic vector for `text`: {@link EMBEDDING_DIM} xorshift32 draws mapped to
 * [-1, 1]. See {@link RecordingEmbeddingsClient} for the exact algorithm (the verifier's reference).
 */
function deterministicVector(text: string): Array<number> {
  // Seed the PRNG. `| 1` avoids the xorshift32 zero fixed-point (x=0 stays 0 forever).
  let x = (fnv1a32(text) | 1) >>> 0;
  const vec: Array<number> = [];
  for (let i = 0; i < EMBEDDING_DIM; i += 1) {
    // xorshift32 step (all ops kept in uint32 via >>> 0).
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    // Map the uint32 draw to a uniform float in [-1, 1]. push (not index-assign) keeps the
    // object-injection sink closed.
    vec.push((x / 0xffffffff) * 2 - 1);
  }
  return vec;
}

// ─── Injected HTTP-transport seam (shared by both production adapters) ────────────────────────────

/** Default per-request transport timeout, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 10.0;

/** The HTTP response shape the embeddings adapters consume. */
export type EmbeddingsHttpResponse = {
  status: number;
  bodyText: string;
};

/** Arguments to one embeddings HTTP request. */
export type EmbeddingsHttpRequestArgs = {
  url: string;
  headers: Record<string, string>;
  jsonBody: unknown;
};

/**
 * Thrown by {@link FetchEmbeddingsHttpClient} when the underlying `fetch` fails at the transport level
 * (network error, DNS failure, connection reset, or an `AbortSignal.timeout` firing). The adapters
 * catch this and map it to {@link EmbeddingsConnectivityError}.
 */
export class EmbeddingsTransportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EmbeddingsTransportError";
  }
}

/**
 * The injected HTTP transport. Production: {@link FetchEmbeddingsHttpClient}. Tests: a programmable
 * in-memory recorder whose `post` signature + return shape are a structural match.
 */
export type EmbeddingsHttpClient = {
  post(args: EmbeddingsHttpRequestArgs): Promise<EmbeddingsHttpResponse>;
};

/**
 * Production HTTP transport: a thin wrapper over Node's built-in global `fetch` (undici). NO new
 * dependency. The transport timeout is armed via {@link transportAbortSignal} (the
 * check_clock_random-sanctioned seam, NOT a raw `setTimeout` / `AbortSignal.timeout`). A timeout /
 * abort / network failure surfaces as a thrown {@link EmbeddingsTransportError} which the adapters map
 * to {@link EmbeddingsConnectivityError}.
 */
export class FetchEmbeddingsHttpClient implements EmbeddingsHttpClient {
  private readonly timeoutMs: number;

  public constructor({
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  }: { timeoutSeconds?: number } = {}) {
    this.timeoutMs = timeoutSeconds * 1000;
  }

  public async post(args: EmbeddingsHttpRequestArgs): Promise<EmbeddingsHttpResponse> {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json", ...args.headers },
      body: JSON.stringify(args.jsonBody),
      signal: transportAbortSignal(this.timeoutMs),
    };
    let resp: Response;
    try {
      resp = await fetch(args.url, init);
    } catch (e) {
      // Network failure, DNS failure, connection reset, or AbortSignal.timeout firing — all map to a
      // transport error the adapters convert to EmbeddingsConnectivityError.
      throw new EmbeddingsTransportError(
        `embeddings transport error: ${e instanceof Error ? e.name : "unknown"}`,
      );
    }
    const bodyText = await resp.text();
    return { status: resp.status, bodyText };
  }
}
