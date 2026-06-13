/**
 * REAL preflight validators — each issues a 1-token LLM ping (or a model-less models.list for
 * anthropic_direct) against the operator's NEW credentials, mapping success/failure to a
 * token-redacted ValidationResult.
 *
 * The SDK client is constructed PER-CALL via an injectable factory (default: lazy-import the official
 * Anthropic SDK), matching the bedrock_sdk_adapter idiom — tests inject a fake client and never load the SDK.
 * Bedrock uses @anthropic-ai/bedrock-sdk (bearer-token AnthropicBedrock); anthropic_direct uses
 * @anthropic-ai/sdk (Anthropic). Both already on disk (the latter is a transitive dep of the former).
 */

import {
  type GetPreflightValidator,
  type LlmProvider,
  type PreflightValidatorPort,
  type ValidationResult,
} from "#backend/integrations/llm/preflight_validator.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const PING_MAX_TOKENS = 1;
const PING_MESSAGES = [{ role: "user", content: "ok" }] as const;
/** Bedrock has no model-less list endpoint, so its credentials-test pings this default model (operator does
 *  not pick it). 1:1 with _BEDROCK_CREDS_TEST_MODEL. */
const BEDROCK_CREDS_TEST_MODEL = "claude-sonnet-4-6";

type PingClient = {
  messages: { create(args: { model: string; messages: typeof PING_MESSAGES; max_tokens: number }): Promise<unknown> };
};
type ListClient = { models: { list(args: { limit: number }): Promise<unknown> } };

export type BedrockClientFactory = (args: { apiKey: string; region: string; timeoutMs: number }) => Promise<PingClient>;
export type DirectClientFactory = (args: { apiKey: string; timeoutMs: number }) => Promise<PingClient & ListClient>;

/** Default REAL factory — lazily imports @anthropic-ai/bedrock-sdk (matches the Python lazy import). The
 *  plaintext token is threaded through the constructor arg, never process.env. */
export const defaultBedrockClientFactory: BedrockClientFactory = async ({ apiKey, region, timeoutMs }) => {
  const { AnthropicBedrock } = await import("@anthropic-ai/bedrock-sdk");
  return new AnthropicBedrock({ apiKey, awsRegion: region, timeout: timeoutMs, maxRetries: 0 }) as unknown as PingClient;
};
export const defaultDirectClientFactory: DirectClientFactory = async ({ apiKey, timeoutMs }) => {
  const { Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 0 }) as unknown as PingClient & ListClient;
};

const ok = (): ValidationResult => ({ ok: true, errorMessage: null });
const fail = (m: string): ValidationResult => ({ ok: false, errorMessage: m });

/** Redact the plaintext token from an upstream error string (1:1 with _strip_token: no-op for keys < 8 chars). */
function stripToken(message: string, apiKey: string): string {
  if (!apiKey || apiKey.length < 8) {
    return message;
  }
  return message.split(apiKey).join("<REDACTED-API-KEY>");
}

// Duck-typed error classification (avoids a static SDK import so the module loads without the SDK in test).
const isTimeout = (err: unknown): boolean => /timeout/i.test((err as { name?: string } | null)?.name ?? "");
const statusOf = (err: unknown): number | undefined => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
};
const typeName = (err: unknown): string =>
  (err as { constructor?: { name?: string } } | null)?.constructor?.name ?? "Error";
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const secs = (ms: number): string => (ms / 1000).toFixed(1);

export class BedrockPreflightValidator implements PreflightValidatorPort {
  private readonly timeoutMs: number;
  private readonly factory: BedrockClientFactory;
  public constructor(opts: { timeoutMs?: number; clientFactory?: BedrockClientFactory } = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.factory = opts.clientFactory ?? defaultBedrockClientFactory;
  }

  public async validate(args: { apiKey: string; modelId: string; region: string | null }): Promise<ValidationResult> {
    const region = args.region ?? "";
    try {
      const client = await this.factory({ apiKey: args.apiKey, region, timeoutMs: this.timeoutMs });
      await client.messages.create({ model: args.modelId, messages: PING_MESSAGES, max_tokens: PING_MAX_TOKENS });
    } catch (err) {
      if (isTimeout(err)) {
        return fail(
          `timeout: Bedrock did not respond within ${secs(this.timeoutMs)}s (region='${region}', model_id='${args.modelId}'); check that the worker pod's NetworkPolicy allows egress to bedrock-runtime.<region>.amazonaws.com:443.`,
        );
      }
      const status = statusOf(err);
      if (status !== undefined) {
        return fail(`upstream returned ${status}: ${typeName(err)}: ${stripToken(errMsg(err), args.apiKey)}`);
      }
      return fail(`unexpected error during preflight: ${typeName(err)}: ${stripToken(errMsg(err), args.apiKey)}`);
    }
    return ok();
  }

  public async validateCredentials(args: { apiKey: string; region: string | null }): Promise<ValidationResult> {
    return this.validate({ apiKey: args.apiKey, modelId: BEDROCK_CREDS_TEST_MODEL, region: args.region ?? "" });
  }
}

export class AnthropicDirectPreflightValidator implements PreflightValidatorPort {
  private readonly timeoutMs: number;
  private readonly factory: DirectClientFactory;
  public constructor(opts: { timeoutMs?: number; clientFactory?: DirectClientFactory } = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.factory = opts.clientFactory ?? defaultDirectClientFactory;
  }

  public async validate(args: { apiKey: string; modelId: string; region: string | null }): Promise<ValidationResult> {
    try {
      const client = await this.factory({ apiKey: args.apiKey, timeoutMs: this.timeoutMs });
      await client.messages.create({ model: args.modelId, messages: PING_MESSAGES, max_tokens: PING_MAX_TOKENS });
    } catch (err) {
      return this.mapError(err, args.apiKey);
    }
    return ok();
  }

  /** Model-LESS credentials check (ADR-0060) — a zero-token models.list, NOT a model invocation. */
  public async validateCredentials(args: { apiKey: string; region: string | null }): Promise<ValidationResult> {
    try {
      const client = await this.factory({ apiKey: args.apiKey, timeoutMs: this.timeoutMs });
      await client.models.list({ limit: 1 });
    } catch (err) {
      return this.mapError(err, args.apiKey);
    }
    return ok();
  }

  private mapError(err: unknown, apiKey: string): ValidationResult {
    if (isTimeout(err)) {
      return fail(
        `timeout: Anthropic Direct did not respond within ${secs(this.timeoutMs)}s; check that the admin pod has network egress to api.anthropic.com:443.`,
      );
    }
    const status = statusOf(err);
    const prefix = status !== undefined ? `${status}: ` : "";
    return fail(stripToken(prefix + errMsg(err), apiKey));
  }
}

/** Production factory wired into AdminRoutesOptions.getPreflightValidator. 1:1 with get_preflight_validator. */
export const getPreflightValidator: GetPreflightValidator = (provider: LlmProvider): PreflightValidatorPort =>
  provider === "bedrock" ? new BedrockPreflightValidator() : new AnthropicDirectPreflightValidator();
