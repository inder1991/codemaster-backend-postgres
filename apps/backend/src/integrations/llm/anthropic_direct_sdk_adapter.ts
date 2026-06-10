/**
 * `AnthropicDirectSdkAdapter` — REAL `@anthropic-ai/sdk` adapter that calls `api.anthropic.com` directly
 * (NOT Bedrock). 1:1 port of the frozen Python
 * `vendor/codemaster-py/codemaster/integrations/llm/anthropic_direct_sdk_adapter.py::AnthropicDirectSdkAdapter`.
 *
 * The sibling of {@link "./bedrock_sdk_adapter.js".AnthropicBedrockSdkAdapter}: it satisfies the SAME
 * `LlmSdk` Protocol (`createMessage(...)`), so review/walkthrough activities are provider-agnostic behind
 * {@link LlmClient}. The {@link "./client_cache.js".defaultSdkFactory} picks this adapter when the
 * `core.llm_provider_settings` row's `provider = "anthropic_direct"`, and the Bedrock adapter when
 * `provider = "bedrock"` (ADR-0028 — relaxes the Anthropic-on-Bedrock stack lock-in).
 *
 * ── Why per-call construction (NO SDK caching, unlike the Bedrock sibling) ──
 * The api key is resolved from {@link LlmCredentialsProvider.current} on EVERY call, so an operator can
 * rotate the key via the admin UI and the next call picks up the new key without bouncing the worker.
 * Caching the SDK would defeat that. The `new Anthropic({ apiKey })` constructor is cheap; connection-pool
 * amortization isn't worth the rotation defeat at our call rate. (The Bedrock adapter caches because its
 * bearer credential is comparatively static.)
 *
 * ── Shared logic ──
 * `hoist_system_messages` (the Messages API rejects `role="system"` inside `messages` with HTTP 400) and
 * `_map_anthropic_exception` (SDK exception → `Llm*` subclass, so workflow retry behavior is symmetric
 * across providers) are imported from the Bedrock adapter module — the SAME helpers the Python reuses.
 *
 * ── Security ── the plaintext api key is consumed transiently (threaded into the SDK constructor inside the
 * per-call closure); NEVER logged, stored, or surfaced, and NEVER read from `process.env` (CLAUDE.md).
 */

import {
  hoistSystemMessages,
  mapAnthropicException,
} from "#backend/integrations/llm/bedrock_sdk_adapter.js";
import {
  type LlmCredentials,
  type LlmCredentialsProvider,
} from "#backend/integrations/llm/credentials_provider.js";
import { LlmInvocationError } from "#backend/integrations/llm/errors.js";

/** The `messages.create` request shape (the kwargs the Python builds; system/tools are conditional). */
export type AnthropicDirectCreateParams = {
  readonly model: string;
  readonly messages: Array<Record<string, unknown>>;
  readonly max_tokens: number;
  readonly system?: string;
  readonly tools?: Array<Record<string, unknown>>;
};

/**
 * The minimal slice of the `@anthropic-ai/sdk` `Anthropic` client this adapter drives: `messages.create`
 * returning the response object, plus an optional `close()`. Structural so the {@link
 * defaultAnthropicDirectSdkFactory} (real SDK) AND a recorded-response test double both satisfy it.
 */
export type AnthropicDirectSdk = {
  readonly messages: {
    create(
      params: AnthropicDirectCreateParams,
      options?: AnthropicDirectRequestOptions,
    ): Promise<Record<string, unknown>>;
  };
  close?(): Promise<void>;
};

/**
 * The minimal `RequestOptions`-shaped slice this adapter passes as the SECOND positional arg of
 * `messages.create(params, options?)` — only the cooperative-cancellation `signal` (de-Temporal Phase 2
 * W4.2b, gate ①). `@anthropic-ai/sdk` ^0.100 `messages.create(body, options?: RequestOptions)` accepts
 * this options object (`RequestOptions.signal?: AbortSignal | undefined | null`, confirmed in the installed
 * `internal/request-options.d.ts`), so the real SDK (reached via the `as unknown as AnthropicDirectSdk`
 * cast in {@link defaultAnthropicDirectSdkFactory}) structurally satisfies this — and a recorded-response
 * test double captures the arg WITHOUT a static `@anthropic-ai/*` import. Mirrors the Bedrock sibling's
 * `BedrockRequestOptions`; structural-minimal on purpose (the adapter only ever forwards `signal`).
 */
export type AnthropicDirectRequestOptions = {
  readonly signal?: AbortSignal;
};

/** Constructs an {@link AnthropicDirectSdk} from a credential triple. */
export type AnthropicDirectSdkFactory = (creds: LlmCredentials) => Promise<AnthropicDirectSdk>;

/**
 * The production default factory: lazily imports `@anthropic-ai/sdk` and constructs an api-key-authed
 * `Anthropic` client pointed at `api.anthropic.com`. NO AWS region (the direct API needs none — that empty
 * region is exactly what breaks the Bedrock client under an `anthropic_direct` config). Lazy import mirrors
 * the Python `from anthropic import AsyncAnthropic` inside the per-call body; tests inject a double.
 */
export const defaultAnthropicDirectSdkFactory: AnthropicDirectSdkFactory = async (
  creds: LlmCredentials,
): Promise<AnthropicDirectSdk> => {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  return new Anthropic({ apiKey: creds.apiKey }) as unknown as AnthropicDirectSdk;
};

export type AnthropicDirectSdkAdapterOptions = {
  readonly provider: LlmCredentialsProvider;
  /** SDK construction seam. Default: {@link defaultAnthropicDirectSdkFactory} (the REAL `@anthropic-ai/sdk`). */
  readonly sdkFactory?: AnthropicDirectSdkFactory;
};

/**
 * Concrete `LlmSdk`-satisfying adapter backed by the real `@anthropic-ai/sdk`. Constructed once per
 * process (per provider slot) at worker bootstrap and passed as the `sdk=` of an {@link LlmClient}. The
 * credentials AND the SDK are resolved/constructed on EVERY call (no caching — see the class docs).
 */
export class AnthropicDirectSdkAdapter {
  private readonly provider: LlmCredentialsProvider;
  private readonly sdkFactory: AnthropicDirectSdkFactory;

  public constructor(options: AnthropicDirectSdkAdapterOptions) {
    this.provider = options.provider;
    this.sdkFactory = options.sdkFactory ?? defaultAnthropicDirectSdkFactory;
  }

  /**
   * Invoke the Anthropic Direct API with credentials resolved by `role`. Hoists `role="system"` entries
   * into the top-level `system` kwarg, conditionally attaches `tools`, runs `messages.create`, and returns
   * the response object. Any SDK error is mapped to a specific `Llm*` subclass via {@link
   * mapAnthropicException}; an already-mapped {@link LlmInvocationError} (e.g. from the SDK double) is
   * re-thrown unchanged.
   */
  public async createMessage(args: {
    model: string;
    messages: Array<Record<string, unknown>>;
    maxTokens: number;
    tools?: Array<Record<string, unknown>> | null;
    role: "primary" | "secondary";
    // de-Temporal Phase 2 (W4.2b, gate ①) — OPTIONAL cooperative-cancellation signal threaded down from
    // {@link LlmClient.invokeModel}'s paid-MISS edge. Forwarded into the SDK request options below so an
    // in-flight Anthropic Direct call RECEIVES it and aborts when the job is cancelled mid-flight. Absent
    // → the 2nd `messages.create` arg is omitted entirely (byte-identical to the pre-W4.2b path).
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    const creds = await this.provider.current(args.role);
    // Per-call construct (+ close) — NO caching, so a key rotation propagates on the next call.
    const sdk = await this.sdkFactory(creds);

    const [systemPrompt, userAssistantMessages] = hoistSystemMessages(args.messages);
    const params: AnthropicDirectCreateParams = {
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
      // (byte-identical to the pre-W4.2b path); the present case calls `create(params, { signal })`.
      const response = await sdk.messages.create(
        params,
        ...(args.signal !== undefined ? [{ signal: args.signal }] : []),
      );
      await closeQuietly(sdk);
      return response;
    } catch (exc) {
      await closeQuietly(sdk);
      if (exc instanceof LlmInvocationError) {
        throw exc;
      }
      throw mapAnthropicException(exc);
    }
  }

  /**
   * No-op (Protocol symmetry with the Bedrock adapter's `aclose`). This adapter constructs AND closes its
   * SDK per call (above), so it caches nothing to tear down at worker shutdown.
   */
  public async aclose(): Promise<void> {
    return;
  }
}

/** Best-effort SDK teardown — a close failure must not mask the call's result or error. */
async function closeQuietly(sdk: AnthropicDirectSdk): Promise<void> {
  if (sdk.close !== undefined) {
    try {
      await sdk.close();
    } catch {
      // intentionally swallowed
    }
  }
}
