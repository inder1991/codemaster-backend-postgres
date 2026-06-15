// Postgres read repo for the purpose resolver (ADR-0060 step 1). Returns every purpose pin LEFT JOINed to
// its catalog model's enabled + validation state, so PurposeModelResolver can drop a pin whose model is
// disabled or has not passed preflight. (The fk_llm_purpose_model_model_id FK guarantees a pin always
// references an existing model, so the LEFT JOIN never misses in practice — the null branch in the
// resolver is purely defensive.)

import { type Kysely, sql } from "kysely";

import type { PurposeModelReadRepo, PurposeModelRow } from "#backend/llm/purpose_model_resolver.js";

export class PostgresPurposeModelReadRepo implements PurposeModelReadRepo {
  private readonly db: Kysely<unknown>;

  public constructor(args: { db: Kysely<unknown> }) {
    this.db = args.db;
  }

  public async listPurposeModelsWithState(): Promise<ReadonlyArray<PurposeModelRow>> {
    const r = await sql<{
      purpose: string;
      model_id: string;
      enabled: boolean;
      last_validation_status: string | null;
    }>`
      SELECT pm.purpose, pm.model_id, COALESCE(m.enabled, false) AS enabled, m.last_validation_status
      FROM core.llm_purpose_model pm
      LEFT JOIN core.llm_models m ON m.model_id = pm.model_id
    `.execute(this.db);
    return r.rows;
  }
}
