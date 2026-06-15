// Embedder /test probe (plan P-1, prerequisite for the admin /embedder-config/test route). Given a
// CANDIDATE config (the staged base_url + model_name + tri-state api_key), it constructs the
// keyless-capable OpenAI-compat adapter and embeds ONE probe text, then GATES on the dimension: the
// embedder must return vectors of exactly EMBEDDING_DIM (the deploy-time width the pgvector columns were
// sized for). A wrong dimension is a config error caught HERE — before any ingest writes garbage-width
// vectors (greenfield posture). The probe never throws: every failure maps to { ok:false, detail } so the
// admin route can persist last_validation_status='failed' + last_validation_error=detail.
//
// NOTE: the runtime aggregation path is dim-agnostic (cosine) and MUST NOT assert EMBEDDING_DIM (see
// embeddings_port.ts). The probe is the ONE place that does — it is the pre-ingest gate, not a hot path.

import {
  type EmbeddingsHttpClient,
  EmbeddingsError,
  EmbeddingsRateLimitedError,
  EmbeddingsValidationError,
  EMBEDDING_DIM,
} from "#backend/adapters/embeddings_port.js";
import { OpenAICompatibleEmbeddingsAdapter } from "#backend/integrations/openai_compat/adapter.js";
import { type PlatformTestErrorCode } from "#contracts/admin.v1.js";

/** The candidate embedder config under test (the EffectiveEmbedderConfig request triple). */
export type EmbedderProbeConfig = {
  baseUrl: string;
  apiKey: string | null;
  modelName: string;
};

/** Structured probe outcome. `ok` gates promotion; `detail` is persisted as last_validation_error/status. */
export type EmbedderProbeResult = {
  ok: boolean;
  detail: string;
  /** The dimension the embedder actually returned (null when the probe never got a vector). */
  dimension: number | null;
  /** A discriminating error code for the UI (null on success): auth_error / rate_limited /
   *  connectivity_error / dimension_mismatch / validation_failed — so a 401 vs a 429 vs an unreachable host
   *  are NOT all reported as connectivity_error. The route maps this to TestPlatformCredentialsResponseV1.error. */
  code: PlatformTestErrorCode | null;
};

const PROBE_TEXT = "codemaster embedder configuration probe";
const PROBE_PURPOSE = "config_test";

/**
 * Probe a candidate embedder config. Builds the adapter (keyless when apiKey === null), embeds one text,
 * and asserts the returned width == expectedDim (default {@link EMBEDDING_DIM}). Injected `http` lets
 * tests script the transport; production passes none (the adapter's real fetch transport is used).
 */
export async function probeEmbedder(
  config: EmbedderProbeConfig,
  opts: { http?: EmbeddingsHttpClient; expectedDim?: number } = {},
): Promise<EmbedderProbeResult> {
  const expectedDim = opts.expectedDim ?? EMBEDDING_DIM;
  const adapter = new OpenAICompatibleEmbeddingsAdapter({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    modelName: config.modelName,
    // Only pass `http` when injected — `exactOptionalPropertyTypes` forbids an explicit `undefined`.
    ...(opts.http ? { http: opts.http } : {}),
  });

  let modelEcho: string;
  let dim: number;
  try {
    const result = await adapter.embed({
      texts: [PROBE_TEXT],
      model_name: config.modelName,
      purpose: PROBE_PURPOSE,
    });
    const vec = result.vectors[0];
    if (vec === undefined) {
      return {
        ok: false,
        detail: "embedder returned no vectors for the probe input",
        dimension: null,
        code: "validation_failed",
      };
    }
    modelEcho = result.model_name;
    dim = vec.length;
  } catch (e) {
    // Map the typed adapter error to a discriminating code so the UI can prompt the right action
    // (check the API key vs back off vs the host is unreachable), not a blanket connectivity_error.
    const name = e instanceof EmbeddingsError ? e.name : "UnknownError";
    const message = e instanceof Error ? e.message : String(e);
    let code: PlatformTestErrorCode;
    if (e instanceof EmbeddingsRateLimitedError) {
      code = "rate_limited";
    } else if (e instanceof EmbeddingsValidationError) {
      // The adapter folds 401/403 (bad key) AND other 4xx into EmbeddingsValidationError; the status is in
      // the message, so a 401/403 → auth_error (actionable "check your API key"), else validation_failed.
      code = /\b40[13]\b/.test(message) ? "auth_error" : "validation_failed";
    } else {
      code = "connectivity_error"; // EmbeddingsConnectivityError (timeout / 5xx / network / bad-200-shape)
    }
    return { ok: false, detail: `${name}: ${message}`, dimension: null, code };
  }

  if (dim !== expectedDim) {
    return {
      ok: false,
      detail:
        `embedder returned dimension ${dim} but this deployment is configured for ${expectedDim} ` +
        `(CODEMASTER_EMBEDDING_DIMENSION). Pick a model whose output width matches, or re-deploy with a ` +
        `matching dimension before ingest.`,
      dimension: dim,
      code: "dimension_mismatch",
    };
  }

  return {
    ok: true,
    detail: `ok — model '${modelEcho}' returned ${dim}-dimension vectors`,
    dimension: dim,
    code: null,
  };
}
