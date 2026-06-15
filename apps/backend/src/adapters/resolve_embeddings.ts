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
  type EmbedRequest,
  type EmbedResult,
  type EmbeddingsPort,
  EmbedderDisabledError,
  RecordingEmbeddingsClient,
} from "#backend/adapters/embeddings_port.js";
import {
  type EffectiveConfigDigestParts,
  resolveEffectiveEmbedderConfig,
} from "#backend/adapters/effective_embedder_config.js";
import { ResolvingEmbeddingsAdapter } from "#backend/adapters/resolving_embeddings_adapter.js";
import {
  type EmbedderEffectiveDbConfig,
  type EmbedderSettingsNonSecret,
  PostgresEmbedderProviderSettingsRepo,
} from "#backend/integrations/embedder/embedder_provider_settings_repo.js";
import { OpenAICompatibleEmbeddingsAdapter } from "#backend/integrations/openai_compat/adapter.js";
import { QwenEmbeddingsConsumer } from "#backend/integrations/qwen/consumer.js";
import { getAuditKeyRegistry } from "#backend/security/audit_field_codec.js";

/** The DB-backed embedder config reads the ResolvingEmbeddingsAdapter needs (the settings repo satisfies
 *  this structurally). When supplied, the worker embeds through the DB-validated > env > none resolver. */
export type EmbedderConfigReadPort = {
  readForResolve(): Promise<EmbedderEffectiveDbConfig | null>;
  readNonSecret(): Promise<EmbedderSettingsNonSecret | null>;
};

/** Optional deps for {@link resolveEmbeddingsConsumer}. With `embedderConfigPort` the worker uses the
 *  DB-backed ResolvingEmbeddingsAdapter; without it, the legacy env-only selection runs unchanged. */
export type ResolveEmbeddingsDeps = {
  embedderConfigPort?: EmbedderConfigReadPort;
  env?: NodeJS.ProcessEnv;
};

/**
 * The runtime embedder for a composition root: the DB-backed ResolvingEmbeddingsAdapter when the
 * field-codec registry is installed (production), else the legacy env-only selection. ONE place for the
 * registry-gated DB-vs-env decision so EVERY runtime — the review pipeline (build_activities), the
 * background-runner INGEST handlers (confluence_ingest / refresh_semantic_docs), and the ANN-fallback —
 * embeds with the SAME UI-saved model. Otherwise the corpus could be ingested with one model and queried
 * with another (silent retrieval breakage), which is exactly what wiring only build_activities missed.
 */
export function resolveRuntimeEmbedder(args: { dsn: string }): EmbeddingsPort {
  const registry = getAuditKeyRegistry();
  if (registry === null) {
    // No field-key registry → cannot read DB creds; the legacy env-only selection is the whole story.
    return resolveEmbeddingsConsumer();
  }
  // DB-config > FULL legacy env > disabled. The ResolvingEmbeddingsAdapter covers DB-validated +
  // openai_compat-env; when it has nothing (no DB row, no CODEMASTER_EMBEDDER_* env) it throws
  // EmbedderDisabledError, and we fall back to the FULL legacy resolveEmbeddingsConsumer() — which ALSO
  // honors the platform/Qwen DSN (incl. the stub://recording dev sentinel). So an env-configured
  // deployment keeps working with the registry installed, and EmbedderDisabledError only surfaces when
  // there is genuinely NO embedder anywhere (then retrieval fails-soft, ingest fails-closed).
  const dbAdapter = resolveEmbeddingsConsumer({
    embedderConfigPort: PostgresEmbedderProviderSettingsRepo.fromDsn({ dsn: args.dsn, registry }),
  });
  return new DbThenLegacyEnvEmbedder(dbAdapter);
}

/** DB-backed embedder with a legacy-env fallback: on EmbedderDisabledError (no DB row + no openai_compat
 *  env), delegate to the full env-based resolveEmbeddingsConsumer() (platform/Qwen, openai_compat, or the
 *  recording stub). If THAT is also unconfigured (fail-loud), re-throw the original EmbedderDisabledError
 *  so the documented fail-soft / fail-closed handling still fires. The legacy factory is injectable for
 *  tests; production defaults to resolveEmbeddingsConsumer. */
export class DbThenLegacyEnvEmbedder implements EmbeddingsPort {
  private legacy: EmbeddingsPort | undefined;
  public constructor(
    private readonly db: EmbeddingsPort,
    private readonly makeLegacy: () => EmbeddingsPort = () => resolveEmbeddingsConsumer(),
  ) {}
  public async embed(req: EmbedRequest): Promise<EmbedResult> {
    try {
      return await this.db.embed(req);
    } catch (e) {
      if (!(e instanceof EmbedderDisabledError)) {
        throw e;
      }
      try {
        this.legacy ??= this.makeLegacy();
      } catch {
        throw e; // legacy env not configured either → genuinely no embedder
      }
      return this.legacy.embed(req);
    }
  }
}

/**
 * A LAZY {@link resolveRuntimeEmbedder}: resolves the runtime embedder on the FIRST embed (not at
 * construction), so a composition root that must stay bootable in DSN-less / pre-registry contexts (the
 * background runner) does not eagerly read the registry/env or fail-loud at build time. By first embed
 * (a real ingest job) the boot path has installed the field-key registry, so the DB path is selected.
 */
export function makeLazyRuntimeEmbedder(args: { dsn?: string | undefined } = {}): EmbeddingsPort {
  let memo: EmbeddingsPort | undefined;
  return {
    async embed(req) {
      if (memo === undefined) {
        const dsn = args.dsn ?? process.env["CODEMASTER_PG_CORE_DSN"];
        memo = dsn !== undefined && dsn !== "" ? resolveRuntimeEmbedder({ dsn }) : resolveEmbeddingsConsumer();
      }
      return memo.embed(req);
    },
  };
}

/** Map the repo's non-secret view to the digest parts the adapter cache keys on (never the plaintext key). */
function nonSecretToDigestParts(ns: EmbedderSettingsNonSecret | null): EffectiveConfigDigestParts | null {
  return ns === null
    ? null
    : {
        baseUrl: ns.baseUrl,
        modelName: ns.modelName,
        keyPresent: ns.keyPresent,
        lastRotatedAt: ns.lastRotatedAt,
        enabled: ns.enabled,
        validationStatus: ns.lastValidationStatus,
      };
}

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
export function resolveEmbeddingsConsumer(deps?: ResolveEmbeddingsDeps): EmbeddingsPort {
  // DB-backed path (Phase 5): when a config port is wired, the worker embeds through the
  // ResolvingEmbeddingsAdapter — DB-validated > env(openai_compat) > disabled — so the UI-saved model is
  // what's used + recorded. The legacy env-only selection below is reached only WITHOUT a port (tests,
  // and the platform-team Qwen path), keeping every existing caller's behavior unchanged.
  if (deps?.embedderConfigPort !== undefined) {
    const port = deps.embedderConfigPort;
    const env = deps.env ?? process.env;
    return new ResolvingEmbeddingsAdapter({
      resolveConfig: () =>
        resolveEffectiveEmbedderConfig({ readDbConfig: () => port.readForResolve(), env }),
      readDigestParts: async () => nonSecretToDigestParts(await port.readNonSecret()),
    });
  }

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
