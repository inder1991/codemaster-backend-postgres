// Rerank config contract — W1.3 RH9 (master-hardening-plan): the OPTIONAL Bedrock re-ranker's
// effective-config resolution. Two operator surfaces feed one effective config:
//
//   1. The admin LLM-settings API (PUT /api/admin/rerank-config → core.rerank_settings, migration
//      0047) — the RUNTIME source of truth. A saved row takes effect on the next retrieval without
//      a redeploy (the resolver re-reads it per retrieval), exactly like the credential rotation
//      flow on core.llm_provider_settings.
//   2. The Helm chart (`config.rerank` → CODEMASTER_RERANK_* env) — the BOOT-TIME baseline,
//      mirroring the runtime-mode / embeddings-provider pattern. {@link parseRerankEnv} is
//      FAIL-LOUD on a malformed value (the resolveMinSimilarity posture: a silently ignored
//      misconfiguration would leave an operator believing they enabled rerank when they did not).
//
// PRECEDENCE ({@link resolveEffectiveRerankConfig}): a DB row — the operator's explicit UI action —
// wins over env ENTIRELY (including DISABLING an env-enabled reranker, so a UI kill-flip takes
// effect without a rollout); env applies when no row exists; with neither, the config is the
// DISABLED default and retrieval keeps the IdentityRerankPort pass-through byte-identically
// (DEFAULT OFF).
//
// This module is the retrieval-side contract: pure functions + types, no I/O — the DB read lives in
// api/admin/llm_catalog_write.ts (readRerankSettings) and is injected by the wiring (retrievers.ts).

/** The Bedrock RERANK-API models the adapter can invoke — the ONLY accepted model ids, enforced at
 *  every config ingress (admin PUT, env parse, Helm values.schema.json enum). The adapter speaks the
 *  Cohere / Amazon rerank request shapes only, so membership here is a correctness gate, not taste. */
export const RERANK_MODELS: ReadonlySet<string> = new Set([
  "cohere.rerank-v3-5:0",
  "amazon.rerank-v1:0",
]);

/** Default cap on how many leading pre-rerank candidates are submitted for re-scoring. 25 covers the
 *  full PRE_FUSION_TOP_K=20 fused width (plus confluence-merged extras) while bounding payload size;
 *  operators tune it down for latency/cost. */
export const DEFAULT_RERANK_TOP_N = 25;

/** AWS region shape (the contracts' LLM_REGION_RE twin — e.g. us-west-2). */
const RERANK_REGION_RE = /^[a-z]{2}-[a-z]+-\d+$/;

/** The effective rerank config consumed by the retrieval wiring. `modelId === null` only ever
 *  coexists with `enabled === false` (both ingresses enforce it). */
export type RerankConfig = {
  readonly enabled: boolean;
  readonly modelId: string | null;
  readonly region: string | null;
  readonly topN: number;
};

/** Structural twin of the stored core.rerank_settings row (api/admin/llm_catalog_write.ts
 *  RerankSettingsRow satisfies it) — declared here so retrieval never imports the api layer. */
export type RerankStoredSettings = {
  readonly enabled: boolean;
  readonly modelId: string;
  readonly region: string | null;
  readonly topN: number;
};

/** Where the effective config came from — surfaced on GET /api/admin/rerank-config so the UI can
 *  show whether a Helm baseline or an explicit admin save is in force. */
export type RerankConfigSource = "database" | "environment" | "default";

/** The env subset {@link parseRerankEnv} reads (injectable for tests). */
export type RerankEnv = {
  readonly CODEMASTER_RERANK_ENABLED?: string | undefined;
  readonly CODEMASTER_RERANK_MODEL_ID?: string | undefined;
  readonly CODEMASTER_RERANK_REGION?: string | undefined;
  readonly CODEMASTER_RERANK_TOP_N?: string | undefined;
};

function parseEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") {
    return false;
  }
  const v = raw.toLowerCase();
  if (v === "true" || v === "1") {
    return true;
  }
  if (v === "false" || v === "0") {
    return false;
  }
  throw new Error(
    `CODEMASTER_RERANK_ENABLED must be true|false; got ${JSON.stringify(raw)}`,
  );
}

function parseTopN(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    return DEFAULT_RERANK_TOP_N;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error(
      `CODEMASTER_RERANK_TOP_N must be an integer in [1, 100]; got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/**
 * Parse the Helm-rendered CODEMASTER_RERANK_* env into a {@link RerankConfig}. FAIL-LOUD on any
 * malformed value (boot-time misconfig must surface, never silently disable). A model id may be
 * STAGED while disabled (operators pre-stage, then flip `enabled`), but enabling without a model is
 * refused — there is nothing to invoke.
 */
export function parseRerankEnv(env: RerankEnv = process.env): RerankConfig {
  const enabled = parseEnabled(env.CODEMASTER_RERANK_ENABLED);
  const topN = parseTopN(env.CODEMASTER_RERANK_TOP_N);

  const rawModel = env.CODEMASTER_RERANK_MODEL_ID;
  const modelId = rawModel !== undefined && rawModel !== "" ? rawModel : null;
  if (modelId !== null && !RERANK_MODELS.has(modelId)) {
    throw new Error(
      `CODEMASTER_RERANK_MODEL_ID must be one of [${[...RERANK_MODELS].join(", ")}]; ` +
        `got ${JSON.stringify(modelId)}`,
    );
  }
  if (enabled && modelId === null) {
    throw new Error(
      "CODEMASTER_RERANK_ENABLED=true requires CODEMASTER_RERANK_MODEL_ID to be set",
    );
  }

  const rawRegion = env.CODEMASTER_RERANK_REGION;
  const region = rawRegion !== undefined && rawRegion !== "" ? rawRegion : null;
  if (region !== null && !RERANK_REGION_RE.test(region)) {
    throw new Error(
      `CODEMASTER_RERANK_REGION must be an AWS region (e.g. us-west-2); got ${JSON.stringify(region)}`,
    );
  }

  return { enabled, modelId, region, topN };
}

/**
 * Resolve the effective rerank config: DB row > env > disabled default (see the header for why a
 * row wins entirely). The env config "exists" when it carries a model id — `enabled` alone cannot
 * exist env-side without one ({@link parseRerankEnv} refuses it).
 */
export function resolveEffectiveRerankConfig(args: {
  row: RerankStoredSettings | null;
  env: RerankConfig;
}): { config: RerankConfig; source: RerankConfigSource } {
  if (args.row !== null) {
    const { enabled, modelId, region, topN } = args.row;
    return { config: { enabled, modelId, region, topN }, source: "database" };
  }
  if (args.env.modelId !== null) {
    return { config: args.env, source: "environment" };
  }
  return {
    config: { enabled: false, modelId: null, region: null, topN: DEFAULT_RERANK_TOP_N },
    source: "default",
  };
}
