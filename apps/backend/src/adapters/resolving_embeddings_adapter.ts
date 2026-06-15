// ResolvingEmbeddingsAdapter (Phase 5 / D4) — the production EmbeddingsPort for the DB-backed embedder.
// On each embed it (1) reads the cheap non-secret digest, (2) reuses the cached inner OpenAI-compat
// adapter when the digest is unchanged or rebuilds it from a freshly-resolved EffectiveEmbedderConfig when
// it changed, and (3) STAMPS the EmbedResult.model_name with the CONFIGURED model so the recorded
// provenance can never drift from the model that was actually requested (single-resolve guarantee, 7-5).
// When no config resolves (no validated DB row + no env fallback) it throws EmbedderDisabledError — the
// retrieval path catches that and degrades to lexical-only; the ingest path lets it propagate (fail-closed).

import {
  type EmbedRequest,
  type EmbedResult,
  type EmbeddingsPort,
  EmbedderDisabledError,
  EmbeddingsConnectivityError,
} from "#backend/adapters/embeddings_port.js";
import {
  type EffectiveConfigDigestParts,
  type EffectiveEmbedderConfig,
  effectiveConfigDigest,
} from "#backend/adapters/effective_embedder_config.js";
import { OpenAICompatibleEmbeddingsAdapter } from "#backend/integrations/openai_compat/adapter.js";

/** Default inner-adapter factory: the real OpenAI-compat HTTP adapter (keyless when apiKey is null). */
function defaultBuildInner(config: EffectiveEmbedderConfig): EmbeddingsPort {
  return new OpenAICompatibleEmbeddingsAdapter({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    modelName: config.modelName,
  });
}

export type ResolvingEmbeddingsAdapterDeps = {
  /** Resolve the single EffectiveEmbedderConfig (DB-validated > env > none); null → disabled. */
  resolveConfig: () => Promise<EffectiveEmbedderConfig | null>;
  /** Cheap non-secret read for cache invalidation (the repo's readNonSecret mapped to digest parts). */
  readDigestParts: () => Promise<EffectiveConfigDigestParts | null>;
  /** Inner-adapter factory (injectable for tests); defaults to the real OpenAI-compat adapter. */
  buildInner?: (config: EffectiveEmbedderConfig) => EmbeddingsPort;
};

type Cache = {
  readonly digest: string;
  readonly config: EffectiveEmbedderConfig;
  readonly inner: EmbeddingsPort;
};

/** A {@link EmbeddingsPort} that resolves + caches the DB-backed embedder config per the digest. */
export class ResolvingEmbeddingsAdapter implements EmbeddingsPort {
  private readonly resolveConfig: () => Promise<EffectiveEmbedderConfig | null>;
  private readonly readDigestParts: () => Promise<EffectiveConfigDigestParts | null>;
  private readonly buildInner: (config: EffectiveEmbedderConfig) => EmbeddingsPort;
  private cache: Cache | null = null;

  public constructor(deps: ResolvingEmbeddingsAdapterDeps) {
    this.resolveConfig = deps.resolveConfig;
    this.readDigestParts = deps.readDigestParts;
    this.buildInner = deps.buildInner ?? defaultBuildInner;
  }

  /** Resolve (cached by digest) and return the current effective config, or null if disabled. Used by the
   *  EffectiveEmbedderConfigReader for provenance at sites that record without an embed call. */
  public async effectiveConfig(): Promise<EffectiveEmbedderConfig | null> {
    try {
      return await this.ensureCurrent();
    } catch (e) {
      if (e instanceof EmbedderDisabledError) {
        return null;
      }
      throw e;
    }
  }

  public async embed(req: EmbedRequest): Promise<EmbedResult> {
    const { config, inner } = await this.ensureCurrentOrThrow();
    const result = await inner.embed(req);
    // 7-5: the SAME resolved config drives both the request AND the recorded provenance — stamp the
    // configured model so a mid-batch config change can never split requested vs recorded model.
    return { ...result, model_name: config.modelName };
  }

  /** Resolve with caching; returns null (does NOT throw) when disabled. A transient DB error on either DB
   *  read is normalized to the documented taxonomy: serve the existing valid cache if present, else
   *  fail-closed (null → EmbedderDisabledError → retrieval degrades to lexical-only, ingest fails-closed).
   *  Without this, a raw pg error on the cheap digest read would escape embed() and break the retrieval
   *  fail-soft contract (ann_retriever catches only the typed embeddings errors). */
  private async ensureCurrent(): Promise<EffectiveEmbedderConfig | null> {
    let digest: string;
    try {
      digest = effectiveConfigDigest(await this.readDigestParts());
    } catch {
      return this.onDbReadError();
    }
    if (this.cache !== null && this.cache.digest === digest) {
      return this.cache.config;
    }
    let config: EffectiveEmbedderConfig | null;
    try {
      config = await this.resolveConfig();
    } catch {
      return this.onDbReadError();
    }
    if (config === null) {
      this.cache = null; // a disabled config invalidates any cached adapter
      return null;
    }
    this.cache = { digest, config, inner: this.buildInner(config) };
    return config;
  }

  /** A DB read failed (digest read or resolve). Serve the warm cache if present; else this is a transient
   *  OUTAGE, NOT "no config" — throw a connectivity-class error (review rr-1) so the legacy-env fallback
   *  (which only catches EmbedderDisabledError) does NOT mask it by embedding with the env model. Retrieval
   *  catches connectivity → lexical-only; ingest does not catch it → fails-closed (no wrong-model corpus). */
  private onDbReadError(): EffectiveEmbedderConfig {
    if (this.cache !== null) {
      return this.cache.config;
    }
    throw new EmbeddingsConnectivityError(
      "embedder config DB read failed with no cached config — transient outage, not a disabled embedder",
    );
  }

  /** Resolve with caching; throws EmbedderDisabledError when disabled. */
  private async ensureCurrentOrThrow(): Promise<Cache> {
    const config = await this.ensureCurrent();
    if (config === null || this.cache === null) {
      throw new EmbedderDisabledError(
        "no embedder is configured — save a base URL + model in the Embedding admin tab and run /test " +
          "(or set the CODEMASTER_EMBEDDER_* env fallback). Semantic embedding is unavailable until then.",
      );
    }
    return this.cache;
  }
}
