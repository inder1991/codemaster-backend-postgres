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
  EMBEDDING_DIM,
} from "#backend/adapters/embeddings_port.js";
import { OpenAICompatibleEmbeddingsAdapter } from "#backend/integrations/openai_compat/adapter.js";

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
      return { ok: false, detail: "embedder returned no vectors for the probe input", dimension: null };
    }
    modelEcho = result.model_name;
    dim = vec.length;
  } catch (e) {
    // Typed adapter errors (Connectivity / RateLimited / Validation) carry their name; surface it so the
    // operator sees WHY (unreachable vs auth rejected vs rate-limited) in the admin UI.
    const name = e instanceof EmbeddingsError ? e.name : "UnknownError";
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: `${name}: ${message}`, dimension: null };
  }

  if (dim !== expectedDim) {
    return {
      ok: false,
      detail:
        `embedder returned dimension ${dim} but this deployment is configured for ${expectedDim} ` +
        `(CODEMASTER_EMBEDDING_DIMENSION). Pick a model whose output width matches, or re-deploy with a ` +
        `matching dimension before ingest.`,
      dimension: dim,
    };
  }

  return {
    ok: true,
    detail: `ok — model '${modelEcho}' returned ${dim}-dimension vectors`,
    dimension: dim,
  };
}
