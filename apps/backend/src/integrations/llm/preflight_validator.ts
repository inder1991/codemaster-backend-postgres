/**
 * LLM pre-save credential validator port — when an operator saves new LLM credentials the admin pod
 * issues a 1-token LLM ping to verify the token is recognised, has permission to invoke the model,
 * and (Bedrock) the region is reachable. A failed ping → 400 with the sanitized error and NO DB write.
 *
 * PORT only (injectable seam). REAL validators are wired at the composition root. Tests inject a stub.
 * The validators NEVER echo the plaintext token in error strings.
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
