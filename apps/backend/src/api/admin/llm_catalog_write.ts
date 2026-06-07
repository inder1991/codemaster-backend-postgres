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
