// resolveEmbeddingsConsumer — env-var-driven selection of the production {@link EmbeddingsPort} impl
// (ADR-0059 Phase 1). This is the SHIPPED path — the REAL adapters embed over HTTP. The
// RecordingEmbeddingsClient is reachable ONLY via the explicit `stub://recording` DSN sentinel (dev
// environments without a real embedder), NEVER by default.
//
// Provider selection (CODEMASTER_EMBEDDINGS_PROVIDER ∈ {platform, openai_compat}, default platform):
//
//   - platform (default): the legacy QwenEmbeddingsConsumer reading CODEMASTER_QWEN_DSN. Honours the
//     `stub://recording` sentinel for dev environments without Qwen access (ADR-0015 closure). A
//     missing/empty DSN is FAIL-LOUD — no silent degradation on the production path.
//
//   - openai_compat: the OpenAICompatibleEmbeddingsAdapter reading CODEMASTER_EMBEDDER_BASE_URL /
//     CODEMASTER_EMBEDDER_API_KEY / CODEMASTER_EMBEDDER_MODEL_NAME. Any missing var is FAIL-LOUD.
//
// FAIL-LOUD posture: construction throws when the chosen provider's required env vars are missing.

import {
  type EmbeddingsPort,
  RecordingEmbeddingsClient,
} from "#backend/adapters/embeddings_port.js";
import { OpenAICompatibleEmbeddingsAdapter } from "#backend/integrations/openai_compat/adapter.js";
import { QwenEmbeddingsConsumer } from "#backend/integrations/qwen/consumer.js";

// Env var names + provider tokens.
const EMBED_PROVIDER_ENV = "CODEMASTER_EMBEDDINGS_PROVIDER";
const EMBED_PROVIDER_PLATFORM = "platform";
const EMBED_PROVIDER_OPENAI_COMPAT = "openai_compat";
const VALID_EMBED_PROVIDERS: ReadonlyArray<string> = [
  EMBED_PROVIDER_PLATFORM,
  EMBED_PROVIDER_OPENAI_COMPAT,
];

/** The dev-only DSN sentinel selecting the deterministic RecordingEmbeddingsClient. */
const STUB_RECORDING_DSN = "stub://recording";

/**
 * Construct the production {@link EmbeddingsPort} impl from env vars (ADR-0059 Phase 1).
 *
 * Throws on an unknown provider token, or when the chosen provider's required env vars are missing
 * (fail-loud per ADR-0015's no-silent-fallback rule — the only `RuntimeError` analogues).
 *
 * Static env access (no dynamic indexing) keeps the object-injection sink closed, mirroring the other
 * `fromEnv` constructors in this tree.
 */
export function resolveEmbeddingsConsumer(): EmbeddingsPort {
  const provider = (process.env["CODEMASTER_EMBEDDINGS_PROVIDER"] ?? EMBED_PROVIDER_PLATFORM).trim();
  if (!VALID_EMBED_PROVIDERS.includes(provider)) {
    throw new Error(
      `unknown ${EMBED_PROVIDER_ENV}=${JSON.stringify(provider)}; ` +
        `valid values: ${JSON.stringify([...VALID_EMBED_PROVIDERS].sort())}`,
    );
  }

  if (provider === EMBED_PROVIDER_PLATFORM) {
    const qwenDsn = (process.env["CODEMASTER_QWEN_DSN"] ?? "").trim();
    if (!qwenDsn) {
      throw new Error(
        `CODEMASTER_QWEN_DSN is required for the worker to start under ${EMBED_PROVIDER_ENV}=platform. ` +
          "Set to the platform-team Qwen3 service DSN (e.g. http://qwen.platform.svc:8080) for " +
          `production, or to the explicit \`${STUB_RECORDING_DSN}\` sentinel for dev environments ` +
          "without Qwen access. For non-platform-team embedders (Ollama, vLLM, OpenAI) set " +
          `${EMBED_PROVIDER_ENV}=${EMBED_PROVIDER_OPENAI_COMPAT} instead (see ADR-0059).`,
      );
    }
    if (qwenDsn === STUB_RECORDING_DSN) {
      return new RecordingEmbeddingsClient();
    }
    return new QwenEmbeddingsConsumer({ dsn: qwenDsn });
  }

  // provider === EMBED_PROVIDER_OPENAI_COMPAT
  const baseUrl = (process.env["CODEMASTER_EMBEDDER_BASE_URL"] ?? "").trim();
  const apiKey = (process.env["CODEMASTER_EMBEDDER_API_KEY"] ?? "").trim();
  const modelName = (process.env["CODEMASTER_EMBEDDER_MODEL_NAME"] ?? "").trim();
  const missing: Array<string> = [];
  if (!baseUrl) missing.push("CODEMASTER_EMBEDDER_BASE_URL");
  if (!apiKey) missing.push("CODEMASTER_EMBEDDER_API_KEY");
  if (!modelName) missing.push("CODEMASTER_EMBEDDER_MODEL_NAME");
  if (missing.length > 0) {
    throw new Error(
      `${EMBED_PROVIDER_ENV}=${EMBED_PROVIDER_OPENAI_COMPAT} requires these env vars: ` +
        `${JSON.stringify(missing)}. See ADR-0059 + docs/runbooks/embedder-provider-setup.md.`,
    );
  }
  return new OpenAICompatibleEmbeddingsAdapter({ baseUrl, apiKey, modelName });
}
