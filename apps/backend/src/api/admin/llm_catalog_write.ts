// LLM model-catalog + purpose-routing writes — 1:1 port of the WRITE methods in llm_models_router.py's
// repos (postgres_llm_purpose_model_repo.upsert; llm-models upsert/delete land here next). Pure DB, no
// Temporal, no audit (the purpose-routing PUT emits no audit event in the Python).

import { type Kysely, sql } from "kysely";

/** The engine's accepted model set (1:1 with integrations/llm/client.py BEDROCK_MODELS). A catalog upsert
 *  is rejected for any model_id outside this set, regardless of provider — the engine can't invoke it. */
export const BEDROCK_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
]);

/** Insert or update a catalog model. On conflict (provider, model_id) refreshes display_name + enabled +
 *  updated_at; validation columns + created_by_user_id are left untouched on the update branch. */
export async function upsertModel(
  db: Kysely<unknown>,
  args: {
    provider: string;
    modelId: string;
    displayName: string | null;
    enabled: boolean;
    createdByUserId: string | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO core.llm_models (provider, model_id, display_name, enabled, created_by_user_id)
    VALUES (${args.provider}, ${args.modelId}, ${args.displayName}, ${args.enabled}, ${args.createdByUserId})
    ON CONFLICT (provider, model_id) DO UPDATE SET
      display_name = EXCLUDED.display_name, enabled = EXCLUDED.enabled, updated_at = now()
  `.execute(db);
}

/** DELETE a catalog model by (provider, model_id). Returns true iff a row was deleted (route maps false→404). */
export async function deleteModel(
  db: Kysely<unknown>,
  args: { provider: string; modelId: string },
): Promise<boolean> {
  const r = await sql<{ model_id: string }>`
    DELETE FROM core.llm_models WHERE provider = ${args.provider} AND model_id = ${args.modelId}
    RETURNING model_id
  `.execute(db);
  return r.rows.length > 0;
}

/** Assign a purpose → model_id (INSERT … ON CONFLICT (purpose) DO UPDATE). Uses SQL now() (1:1 w/ Python). */
export async function upsertPurposeModel(
  db: Kysely<unknown>,
  args: { purpose: string; modelId: string; updatedByUserId: string },
): Promise<void> {
  await sql`
    INSERT INTO core.llm_purpose_model (purpose, model_id, updated_at, updated_by_user_id)
    VALUES (${args.purpose}, ${args.modelId}, now(), ${args.updatedByUserId})
    ON CONFLICT (purpose) DO UPDATE SET
      model_id = EXCLUDED.model_id, updated_at = now(), updated_by_user_id = EXCLUDED.updated_by_user_id
  `.execute(db);
}

// ─── W1.3 RH9 — the optional Bedrock re-ranker's platform-singleton config (core.rerank_settings) ───

/** The Bedrock RERANK-API models the engine can invoke (the rerank analogue of {@link BEDROCK_MODELS}).
 *  A PUT /api/admin/rerank-config naming any other model_id is rejected — the adapter only speaks the
 *  Cohere/Amazon rerank request shapes. Single-sourced from the retrieval-side config contract so the
 *  admin PUT, the env parse, and the adapter can never disagree on the accepted set. */
export { RERANK_MODELS } from "#backend/retrieval/rerank_config.js";

/** The stored rerank settings row (camelCase view of core.rerank_settings; migration 0047). */
export type RerankSettingsRow = {
  readonly enabled: boolean;
  readonly modelId: string;
  readonly region: string | null;
  readonly topN: number;
  readonly updatedAt: Date;
  readonly updatedByUserId: string;
};

type RerankSettingsDbRow = {
  readonly enabled: boolean;
  readonly model_id: string;
  readonly region: string | null;
  readonly top_n: number;
  readonly updated_at: Date;
  readonly updated_by_user_id: string;
};

/** Read the platform-singleton rerank settings row, or null when the operator never saved one (the
 *  DEFAULT-OFF posture — retrieval then falls back to the Helm/env config, then to disabled). */
export async function readRerankSettings(db: Kysely<unknown>): Promise<RerankSettingsRow | null> {
  // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-platform-llm-config
  const result = await sql<RerankSettingsDbRow>`
    SELECT enabled, model_id, region, top_n, updated_at, updated_by_user_id
      FROM core.rerank_settings
     WHERE scope = 'platform'
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    enabled: row.enabled,
    modelId: row.model_id,
    region: row.region,
    topN: row.top_n,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id,
  };
}

/** UPSERT the platform-singleton rerank settings row (the PUT /api/admin/rerank-config write). The
 *  scope PK makes the second save an UPDATE — exactly one row can ever exist. */
export async function upsertRerankSettings(
  db: Kysely<unknown>,
  args: {
    enabled: boolean;
    modelId: string;
    region: string | null;
    topN: number;
    updatedAt: Date;
    updatedByUserId: string;
  },
): Promise<void> {
  // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-platform-llm-config
  await sql`
    INSERT INTO core.rerank_settings (scope, enabled, model_id, region, top_n, updated_at, updated_by_user_id)
    VALUES ('platform', ${args.enabled}, ${args.modelId}, ${args.region}, ${args.topN},
            ${args.updatedAt}, ${args.updatedByUserId})
    ON CONFLICT (scope) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      model_id = EXCLUDED.model_id,
      region = EXCLUDED.region,
      top_n = EXCLUDED.top_n,
      updated_at = EXCLUDED.updated_at,
      updated_by_user_id = EXCLUDED.updated_by_user_id
  `.execute(db);
}

/** Record the outcome of a model-credential validation probe (llm-models /test). Bare UPDATE keyed by
 *  (provider, model_id) — no rowcount check, no raise (1:1 with Python set_validation): a /test on an
 *  unregistered model_id no-ops. `status` is narrowed to ok|failed (untested is the DDL default only). */
export async function setValidation(
  db: Kysely<unknown>,
  args: { provider: string; modelId: string; status: "ok" | "failed"; error: string | null; validatedAt: Date },
): Promise<void> {
  await sql`
    UPDATE core.llm_models SET
      last_validation_status = ${args.status},
      last_validation_error = ${args.error},
      last_validated_at = ${args.validatedAt},
      updated_at = now()
    WHERE provider = ${args.provider} AND model_id = ${args.modelId}
  `.execute(db);
}
