// LLM model-catalog + purpose-routing writes — 1:1 port of the WRITE methods in llm_models_router.py's
// repos (postgres_llm_purpose_model_repo.upsert; llm-models upsert/delete land here next). Pure DB, no
// Temporal, no audit (the purpose-routing PUT emits no audit event in the Python).

import { type Kysely, sql } from "kysely";

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
