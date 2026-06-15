// EffectiveEmbedderConfig — the ONE resolved value that drives the embed HTTP request, the recorded
// provenance, the generation metadata, and config-status (plan §3 / 6-2). It is produced by ONE resolver
// (DB-validated > env > none) so the request model and the recorded model can never diverge. Phase 5's
// ResolvingEmbeddingsAdapter builds the inner OpenAI-compat adapter from it and returns the same value as
// the provenance; Phase 5b's EffectiveEmbedderConfigReader exposes {modelName, provider} to the activities.
//
// RESOLUTION POLICY (fail-closed):
//   - a DB row enabled AND validation='ok'   → source:'db' (the only runtime-adopted DB state);
//   - a DB row disabled OR validation != ok   → null (configured-but-not-ready does NOT silently use env);
//   - NO DB row                               → env bootstrap fallback (source:'env'); env NEVER promotes
//                                               provenance (7-6) — it just keeps the worker embedding until
//                                               an admin saves + /tests a DB config;
//   - a DB READ ERROR (cold start / outage)   → null, env NOT consulted (D2-val: no silent degradation).

import { type EmbedderEffectiveDbConfig } from "#backend/integrations/embedder/embedder_provider_settings_repo.js";

/** The single resolved embedder config. `source` records provenance origin; `apiKey` null = keyless. */
export type EffectiveEmbedderConfig = {
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly modelName: string;
  readonly provider: "openai_compat";
  readonly source: "db" | "env";
};

/** Injected dependencies for the resolver (so it is pure + unit-testable without a live DB/env). */
export type EmbedderConfigResolveDeps = {
  /** Decrypted DB read (the repo's readForResolve). Throwing → treated as a fail-closed outage. */
  readDbConfig: () => Promise<EmbedderEffectiveDbConfig | null>;
  /** Process env (injectable). Read only for the bootstrap fallback. */
  env?: NodeJS.ProcessEnv;
};

/** Resolve the env bootstrap fallback (openai_compat vars). Keyless when no api key var is set. */
function resolveEnvConfig(env: NodeJS.ProcessEnv): EffectiveEmbedderConfig | null {
  const baseUrl = (env["CODEMASTER_EMBEDDER_BASE_URL"] ?? "").trim();
  const modelName = (env["CODEMASTER_EMBEDDER_MODEL_NAME"] ?? "").trim();
  const rawKey = (env["CODEMASTER_EMBEDDER_API_KEY"] ?? "").trim();
  if (baseUrl === "" || modelName === "") {
    return null;
  }
  return {
    baseUrl,
    apiKey: rawKey === "" ? null : rawKey,
    modelName,
    provider: "openai_compat",
    source: "env",
  };
}

/** Resolve the single EffectiveEmbedderConfig (DB-validated > env > none), fail-closed. */
export async function resolveEffectiveEmbedderConfig(
  deps: EmbedderConfigResolveDeps,
): Promise<EffectiveEmbedderConfig | null> {
  let dbCfg: EmbedderEffectiveDbConfig | null;
  try {
    dbCfg = await deps.readDbConfig();
  } catch {
    // DB error / cold start with no safe cached state → fail-closed; do NOT silently fall to env.
    return null;
  }

  if (dbCfg !== null) {
    // A configured DB row is authoritative. Only an enabled + validated row is adopted; a
    // disabled/unvalidated row returns null (the admin owns this slot — don't shadow it with env).
    if (dbCfg.enabled && dbCfg.validationStatus === "ok") {
      return {
        baseUrl: dbCfg.baseUrl,
        apiKey: dbCfg.apiKey,
        modelName: dbCfg.modelName,
        provider: "openai_compat",
        source: "db",
      };
    }
    return null;
  }

  return resolveEnvConfig(deps.env ?? process.env);
}

/** The non-secret parts the Phase-5 adapter cache keys on (from readNonSecret — never the plaintext key). */
export type EffectiveConfigDigestParts = {
  readonly baseUrl: string;
  readonly modelName: string;
  readonly keyPresent: boolean;
  /** Bumped on every key set/clear → captures rotation (and resave) without exposing the key (6-12). */
  readonly lastRotatedAt: Date | null;
  readonly enabled: boolean;
  readonly validationStatus: string | null;
};

/**
 * A stable, non-secret digest of the config used to invalidate the ResolvingEmbeddingsAdapter's cached
 * inner adapter. Changes on ANY field change — including a key rotation/resave (via last_rotated_at), an
 * enable toggle, or a (re)validation — and is stable otherwise. `null` (no config) maps to a sentinel.
 */
export function effectiveConfigDigest(parts: EffectiveConfigDigestParts | null): string {
  if (parts === null) {
    return "none";
  }
  return [
    parts.baseUrl,
    parts.modelName,
    parts.keyPresent ? "k" : "-",
    parts.lastRotatedAt?.toISOString() ?? "-",
    parts.enabled ? "1" : "0",
    parts.validationStatus ?? "-",
  ].join("|");
}
