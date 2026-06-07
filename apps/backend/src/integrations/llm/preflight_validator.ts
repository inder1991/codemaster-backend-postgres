/**
 * LLM pre-save credential validator port — 1:1 port of the seam in
 * `vendor/codemaster-py/codemaster/integrations/llm/preflight_validator.py`.
 *
 * When an operator saves new LLM credentials via PUT /api/admin/llm-provider-config (or hits the
 * "Test connection" buttons), the admin pod issues a 1-token LLM ping to verify the token is recognised,
 * has permission to invoke the model, and (Bedrock) the region is reachable. A failed ping turns into a 400
 * with the sanitized upstream error and NO DB write — catching operator typos at save time.
 *
 * This module defines the PORT only (the injectable seam). The REAL provider validators
 * (BedrockPreflightValidator over `@anthropic-ai/bedrock-sdk`, AnthropicDirectPreflightValidator over the
 * direct SDK) are wired at the composition root — the admin routes consume a {@link GetPreflightValidator}
 * factory from `AdminRoutesOptions`, exactly as the Python router injects `get_preflight_validator`.
 * Tests inject an in-memory stub. The validators NEVER echo the plaintext token in error strings.
 */

/** Provider discriminator (matches the contract enum). */
export type LlmProvider = "bedrock" | "anthropic_direct";

/** Outcome of a pre-save ping. `errorMessage` is populated (token-redacted) only when `ok === false`. */
export type ValidationResult = {
  readonly ok: boolean;
  readonly errorMessage: string | null;
};

/**
 * A provider-specific preflight validator. `validate` names a model (used by the PUT save-path); the
 * model-less `validateCredentials` (ADR-0060) backs the "Test connection" button — for anthropic_direct a
 * zero-token `models.list()`, for bedrock a 1-token ping against a default model the operator does not pick.
 */
export type PreflightValidatorPort = {
  validate(args: { apiKey: string; modelId: string; region: string | null }): Promise<ValidationResult>;
  validateCredentials(args: { apiKey: string; region: string | null }): Promise<ValidationResult>;
};

/** Factory injected into the admin routes — 1:1 with `get_preflight_validator(provider)`. */
export type GetPreflightValidator = (provider: LlmProvider) => PreflightValidatorPort;
