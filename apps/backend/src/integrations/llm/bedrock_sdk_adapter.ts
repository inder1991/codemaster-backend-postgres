/**
 * `AnthropicBedrockSdkAdapter` — REAL `@anthropic-ai/bedrock-sdk` adapter (de-stub step 3).
 *
 * 1:1 TypeScript port of the frozen Python spine adapter
 * `vendor/codemaster-py/codemaster/integrations/llm/sdk_adapter.py::AnthropicBedrockSdkAdapter`.
 *
 * This is the REAL adapter — NO stub on the shipped path. It satisfies the {@link LlmSdk} Protocol
 * ({@link "./client.js"}) that {@link LlmClient} consumes, backed by the real
 * `@anthropic-ai/bedrock-sdk` `AnthropicBedrock` client. On every {@link AnthropicBedrockSdkAdapter.createMessage}
 * call it:
 *
 *   1. `await provider.current(role)` → fresh per-role {@link LlmCredentials} (the TTL-refreshing
 *      provider; a UI-driven rotation propagates within the TTL window without a pod restart).
 *   2. Builds (or reuses — see the SDK cache below) an `AnthropicBedrock` instance keyed on the
 *      credential triple, then hoists `role="system"` entries out of `messages` into the top-level
 *      `system` kwarg (the Messages API rejects `role="system"` inside `messages` with HTTP 400).
 *   3. `client.messages.create({ model, messages, max_tokens, system?, tools? })` runs; the response
 *      (the SDK's `Message`, already a plain JS object — the `.model_dump()` analogue) is returned as
 *      the `Record<string, unknown>` shape the upstream {@link LlmClient} consumes.
 *   4. On error, maps the SDK exception to a specific `Llm*` subclass via {@link mapAnthropicException}.
 *
 * ── Bearer-token authentication ──
 * The Python constructs `AsyncAnthropicBedrock(api_key=creds.api_key, aws_region=creds.region)` — the
 * SDK's first-class `AWS_BEARER_TOKEN_BEDROCK` path, which sets `Authorization: Bearer <token>`
 * directly (no SigV4 + IAM chain). `@anthropic-ai/bedrock-sdk` ^0.29 has the same first-class bearer
 * path: `ClientOptions.apiKey` ("API key for Bearer token authentication"). So {@link
 * defaultBedrockSdkFactory} passes the decrypted token straight through as `apiKey` (+ `awsRegion`),
 * a 1:1 match with the Python — no SigV4, no subclass. The plaintext token is threaded through the
 * constructor arg, never `process.env`/`AWS_BEARER_TOKEN_BEDROCK` (CLAUDE.md "no secrets in env vars").
 *
 * ── Lazy import (matches the Python `_sdk_for` lazy `from anthropic import ...`) ──
 * The default factory `await import("@anthropic-ai/bedrock-sdk")` lazily — the heavy SDK is only pulled
 * in when production actually constructs a client. Tests inject a recorded-response SDK double via the
 * `sdkFactory` seam, so the real lazy import is NEVER triggered in test (the recorded cassette stands
 * in for the unreachable Bedrock service — the user-approved double). Mirrors the Python's
 * `from anthropic import AsyncAnthropicBedrock` inside `_sdk_for`.
 *
 * ── SDK cache rebuild rule (ADR-0061 D2) ──
 * The constructed SDK is cached and reused while the credential triple is unchanged (httpx/undici
 * keep-alive amortizes across calls). A credential change (rotation) rebuilds the SDK; the rebuild
 * does NOT eagerly close the prior instance — the adapter is shared across concurrent `role` callers
 * holding a live SDK reference across their network `await`, and an eager close would sever an
 * in-flight call. A rebuild-without-close leaks at most one SDK per credential rotation (rare,
 * operator-driven); {@link AnthropicBedrockSdkAdapter.aclose} at worker shutdown closes the cached
 * SDK deterministically (rather than leaving it for GC, which is the ADR-0061 crash class).
 *
 * ── Security ──
 * The plaintext token is consumed transiently — threaded into the bearer header inside the closure;
 * NEVER logged, stored, or surfaced.
 */

import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";

import {
  type LlmCredentials,
  type LlmCredentialsProvider,
} from "#backend/integrations/llm/credentials_provider.js";
import {
  LlmAuthError,
  LlmInvocationError,
  LlmRateLimitError,
  LlmServerError,
  LlmTimeoutError,
} from "#backend/integrations/llm/errors.js";

// ─── The SDK seam (the slice of `AnthropicBedrock` this adapter drives) ─────────────────────────

/**
 * The minimal slice of the `@anthropic-ai/bedrock-sdk` client this adapter drives: a
 * `messages.create(...)` returning the response object, plus an optional `close()` (the SDK's pool
 * teardown). Modeled as a structural type so the {@link defaultBedrockSdkFactory} (real SDK) AND a
 * recorded-response test double both satisfy it WITHOUT a static `@anthropic-ai/*` import in test code.
 *
 * The Python `AsyncAnthropicBedrock` exposes `messages.create(**kwargs)` and `close()`; this is that
 * surface.
 */
export type BedrockSdk = {
  readonly messages: {
    create(
      params: BedrockCreateParams,
      options?: BedrockRequestOptions,
    ): Promise<Record<string, unknown>>;
  };
  /** Close the SDK's connection pool (the Python `close()`, NOT `aclose()`). Optional — a double may omit it. */
  close?(): Promise<void>;
};

/**
 * The minimal `RequestOptions`-shaped slice this adapter passes as the SECOND positional arg of
 * `messages.create(params, options?)` — only the cooperative-cancellation `signal` (de-Temporal Phase 2
 * W4.2b, gate ①). `@anthropic-ai/sdk` ^0.100 `messages.create(body, options?: RequestOptions)` accepts
 * this options object (`RequestOptions.signal?: AbortSignal | undefined | null`, confirmed in the installed
 * `internal/request-options.d.ts`), and `@anthropic-ai/bedrock-sdk` ^0.29 re-exports the same SDK surface,
 * so the real SDK (reached via the `as unknown as BedrockSdk` cast in {@link defaultBedrockSdkFactory})
 * structurally satisfies this — and a recorded-response test double captures the arg WITHOUT a static
 * `@anthropic-ai/*` import. Structural-minimal on purpose: the adapter only ever forwards `signal`.
 */
export type BedrockRequestOptions = {
  readonly signal?: AbortSignal;
};

/** The `messages.create` request shape — the kwargs the Python builds (system/tools are conditional). */
export type BedrockCreateParams = {
  readonly model: string;
  readonly messages: Array<Record<string, unknown>>;
  readonly max_tokens: number;
  readonly system?: string;
  readonly tools?: Array<Record<string, unknown>>;
};

/**
 * Constructs a {@link BedrockSdk} from a credential triple. The production default
 * ({@link defaultBedrockSdkFactory}) lazily imports `@anthropic-ai/bedrock-sdk` and builds the REAL
 * bearer-authed client; tests inject a factory returning a recorded-response double.
 */
export type BedrockSdkFactory = (creds: LlmCredentials) => Promise<BedrockSdk>;

// ─── system-message hoist (port of `hoist_system_messages`) ─────────────────────────────────────

/**
 * Split `role="system"` entries out of an Anthropic messages list.
 *
 * The Messages API rejects `role="system"` inside `messages` with HTTP 400 "Unexpected role 'system'"
 * — `system` must be a top-level kwarg on `messages.create(...)`. Callers upstream of the SDK adapter
 * build their message lists with a leading `role="system"` entry; this hoists those into a single
 * concatenated string and returns the remaining user/assistant entries unchanged.
 *
 * Returns `[systemPrompt, userAssistantMessages]` where `systemPrompt` is `null` if no system entries
 * were present. Multiple system entries (rare) are joined with `"\n\n"` in document order. 1:1 with the
 * Python `hoist_system_messages` (including the `str(content)` coercion of a non-string content).
 */
export function hoistSystemMessages(
  messages: Array<Record<string, unknown>>,
): [string | null, Array<Record<string, unknown>>] {
  const systemParts: Array<string> = [];
  const userAssistantMessages: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m["role"] === "system") {
      const content = m["content"];
      systemParts.push(typeof content === "string" ? content : String(content));
    } else {
      userAssistantMessages.push(m);
    }
  }
  const systemPrompt = systemParts.length > 0 ? systemParts.join("\n\n") : null;
  return [systemPrompt, userAssistantMessages];
}

// ─── exception mapping (port of `_map_anthropic_exception`) ──────────────────────────────────────

/**
 * Map an `@anthropic-ai/sdk` exception to a specific `Llm*` subclass.
 *
 * Per the frozen Python spec §6.2 — the same mapping the Python `_map_anthropic_exception` applies, so
 * the workflow-level retry behavior is symmetric:
 *   - timeout            → {@link LlmTimeoutError}     (retryable)
 *   - 429 / rate limit   → {@link LlmRateLimitError}   (retryable with backoff)
 *   - 401 / 403          → {@link LlmAuthError}        (NON-retryable; operator-visible misconfig)
 *   - connection / 5xx   → {@link LlmServerError}      (retryable)
 *   - anything else      → {@link LlmInvocationError}  (generic)
 *
 * Port-fidelity note: the pinned base SDK names the timeout class `APIConnectionTimeoutError` (a
 * subclass of `APIConnectionError`), not the Python's `APITimeoutError` — so timeout is checked BEFORE
 * the connection-error branch, exactly as the Python checks `APITimeoutError` before `APIConnectionError`.
 * The Python `asyncio.TimeoutError` branch has no TS analogue (no cooperative-cancellation timeout
 * type); a raw `AbortError`-style timeout still surfaces as a generic `LlmInvocationError`, which is
 * retried at the activity level the same as `LlmTimeoutError`. There is no separate `APIStatusError`
 * class in this SDK — `APIError` itself carries `status`, so the 5xx check reads `APIError.status`.
 */
export function mapAnthropicException(exc: unknown): LlmInvocationError {
  const excMsg = errorMessage(exc);

  // Check in order of specificity (mirrors the Python isinstance ladder).
  if (exc instanceof APIConnectionTimeoutError) {
    return new LlmTimeoutError(excMsg);
  }
  if (exc instanceof RateLimitError) {
    return new LlmRateLimitError(excMsg);
  }
  if (exc instanceof AuthenticationError || exc instanceof PermissionDeniedError) {
    return new LlmAuthError(excMsg);
  }
  if (exc instanceof APIConnectionError) {
    return new LlmServerError(excMsg);
  }
  if (exc instanceof APIError) {
    // 5xx responses are retryable; map to LlmServerError (the Python `APIStatusError` 5xx branch).
    const status = exc.status;
    if (typeof status === "number" && status >= 500 && status < 600) {
      return new LlmServerError(excMsg);
    }
  }
  // Default: wrap unknown exceptions as a generic LlmInvocationError.
  return new LlmInvocationError(excMsg);
}

/** Message extraction for the mapped error (the Python `str(exc)`). */
function errorMessage(exc: unknown): string {
  if (exc instanceof Error) {
    return exc.message;
  }
  return String(exc);
}

// ─── default REAL SDK factory (bearer-token authed `@anthropic-ai/bedrock-sdk`) ──────────────────

/**
 * The production default {@link BedrockSdkFactory}: lazily imports `@anthropic-ai/bedrock-sdk` and
 * constructs a bearer-token-authed `AnthropicBedrock`.
 *
 * `@anthropic-ai/bedrock-sdk` ^0.29 supports bearer-token auth as a first-class `ClientOptions.apiKey`
 * ("API key for Bearer token authentication"; defaults to `AWS_BEARER_TOKEN_BEDROCK`) — the direct
 * equivalent of the Python `AsyncAnthropicBedrock(api_key=..., aws_region=...)`. So we pass the
 * decrypted token straight through (`apiKey` + `awsRegion`), no SigV4 + IAM chain, no subclass hack.
 * The plaintext token is threaded through the constructor arg, never `process.env` (CLAUDE.md
 * "no secrets in env vars").
 *
 * (NB on the pin: 0.12.x was incompatible with modern `@anthropic-ai/sdk` — it imported the removed
 * `@anthropic-ai/sdk/core` subpath and threw `ERR_PACKAGE_PATH_NOT_EXPORTED` at import. ^0.29 fixes
 * that AND adds the native bearer path used here.)
 *
 * Lazy import: matches the Python `_sdk_for` lazy `from anthropic import AsyncAnthropicBedrock`. In
 * test the recorded-response double is injected, so this real import is never triggered.
 */
export const defaultBedrockSdkFactory: BedrockSdkFactory = async (
  creds: LlmCredentials,
): Promise<BedrockSdk> => {
  const { AnthropicBedrock } = await import("@anthropic-ai/bedrock-sdk");
  return new AnthropicBedrock({
    apiKey: creds.apiKey,
    awsRegion: creds.region,
  }) as unknown as BedrockSdk;
};

// ─── the adapter ─────────────────────────────────────────────────────────────────────────────────

export type AnthropicBedrockSdkAdapterOptions = {
  readonly provider: LlmCredentialsProvider;
  /** SDK construction seam. Default: {@link defaultBedrockSdkFactory} (the REAL bearer-authed SDK). */
  readonly sdkFactory?: BedrockSdkFactory;
};

/**
 * Concrete {@link BedrockSdk}-driving adapter backed by the real `@anthropic-ai/bedrock-sdk`.
 *
 * Constructed once per process (per provider slot) at worker bootstrap and passed as the `sdk=` of an
 * {@link LlmClient} (the {@link LlmClientCache} `client_factory` does exactly this). The credentials
 * are resolved by role on every call; the SDK is cached + rebuilt on credential change.
 */
export class AnthropicBedrockSdkAdapter {
  private readonly provider: LlmCredentialsProvider;
  private readonly sdkFactory: BedrockSdkFactory;

  // Cached SDK instance + the credential triple it was built for. Rebuilt when credentials change
  // (different api_key/region pair); reused otherwise so keep-alive amortizes across calls.
  private cachedCreds: LlmCredentials | null = null;
  private cachedSdk: BedrockSdk | null = null;

  public constructor(options: AnthropicBedrockSdkAdapterOptions) {
    this.provider = options.provider;
    this.sdkFactory = options.sdkFactory ?? defaultBedrockSdkFactory;
  }

  /**
   * Invoke the Bedrock SDK with credentials resolved by `role`.
   *
   * Hoists `role="system"` entries into the top-level `system` kwarg, conditionally attaches `tools`,
   * runs `messages.create`, and returns the response object (the `.model_dump()` analogue). Any SDK
   * error is mapped to a specific `Llm*` subclass via {@link mapAnthropicException}; an already-mapped
   * {@link LlmInvocationError} (e.g. raised by the SDK double) is re-thrown unchanged.
   *
   * Port-fidelity divergence: the Python `**_legacy_kwargs` deploy-ordering shim (swallowing a stale
   * `installation_id=`) is a Python-rollout artifact with no analogue in this fresh TS codebase, so it
   * is intentionally NOT ported.
   */
  public async createMessage(args: {
    model: string;
    messages: Array<Record<string, unknown>>;
    maxTokens: number;
    tools?: Array<Record<string, unknown>> | null;
    role: "primary" | "secondary";
    // de-Temporal Phase 2 (W4.2b, gate ①) — OPTIONAL cooperative-cancellation signal threaded down from
    // {@link LlmClient.invokeModel}'s paid-MISS edge. Forwarded into the SDK request options below so an
    // in-flight Bedrock call RECEIVES it and aborts when the job is cancelled mid-flight. Absent → the
    // 2nd `messages.create` arg is omitted entirely (byte-identical to the pre-W4.2b / Temporal path).
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    const creds = await this.provider.current(args.role);
    const sdk = await this.sdkFor(creds);

    const [systemPrompt, userAssistantMessages] = hoistSystemMessages(args.messages);
    const params: BedrockCreateParams = {
      model: args.model,
      messages: userAssistantMessages,
      max_tokens: args.maxTokens,
      // exactOptionalPropertyTypes: only spread the optional keys when present.
      ...(systemPrompt !== null ? { system: systemPrompt } : {}),
      ...(args.tools !== null && args.tools !== undefined ? { tools: args.tools } : {}),
    };

    try {
      // W4.2b (gate ①) — pass the caller's signal as the SDK's `RequestOptions.signal`. Array-spread the
      // OPTIONAL second positional arg so the absent case calls `create(params)` with exactly one arg
      // (byte-identical to the Temporal path); the present case calls `create(params, { signal })`.
      return await sdk.messages.create(
        params,
        ...(args.signal !== undefined ? [{ signal: args.signal }] : []),
      );
    } catch (exc) {
      if (exc instanceof LlmInvocationError) {
        throw exc;
      }
      throw mapAnthropicException(exc);
    }
  }

  /**
   * Return the {@link BedrockSdk} for `creds`, rebuilding when the credential triple has changed.
   *
   * A credential-rotation rebuild REPLACES (does not close) the prior SDK by design — no eager
   * rebuild-close (concurrency-unsafe: a concurrent caller may hold the prior SDK across an in-flight
   * network `await`). The leaked prior SDK is bounded by the credential-rotation count until shutdown.
   */
  private async sdkFor(creds: LlmCredentials): Promise<BedrockSdk> {
    if (this.cachedSdk !== null && this.cachedCreds !== null && credsEqual(this.cachedCreds, creds)) {
      return this.cachedSdk;
    }
    const sdk = await this.sdkFactory(creds);
    this.cachedSdk = sdk;
    this.cachedCreds = creds;
    return sdk;
  }

  /**
   * Close the cached SDK's connection pool (ADR-0061 D2).
   *
   * Called at worker shutdown so the cached SDK is closed deterministically rather than left for GC —
   * a GC-reclaimed client would run its teardown on whatever loop is live (frequently the Temporal
   * workflow sandbox loop), the ADR-0061 crash class. The SDK's close method is `close()` (NOT
   * `aclose()`). Idempotent: safe when no SDK was built. NOT called on a credential rebuild inside
   * {@link sdkFor} — eager close would sever an in-flight call held by a concurrent role caller.
   */
  public async aclose(): Promise<void> {
    const sdk = this.cachedSdk;
    this.cachedSdk = null;
    this.cachedCreds = null;
    if (sdk !== null && sdk.close !== undefined) {
      await sdk.close();
    }
  }
}

/** Credential-triple equality (the Python frozen-dataclass `==`). Rebuilds the SDK on any field change. */
function credsEqual(a: LlmCredentials, b: LlmCredentials): boolean {
  return a.apiKey === b.apiKey && a.region === b.region && a.modelId === b.modelId;
}
