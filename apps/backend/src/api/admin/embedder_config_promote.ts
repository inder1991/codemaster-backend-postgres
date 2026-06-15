// promoteValidatedEmbedderConfig (Phase 6 / r7 D9) — the ONE transaction that adopts a /test-validated
// embedder config as the runtime config. It is the entire r7 concurrency + consistency model in one place:
//
//   1. SELECT … FOR UPDATE the settings singleton (serialize concurrent promotes, 7-9);
//   2. COMPARE-AND-SWAP on updated_at: the row must be byte-identical to what /test probed (7-1) — a
//      concurrent PUT that re-staged the config between probe and promote → EmbedderConfigChangedError (409),
//      so a validated config can never be silently replaced by an unvalidated one;
//   3. CONTRACT-CHANGE gate (7-2): only when the staged {model, provider, dimension} differs from the ACTIVE
//      generation's do we require a greenfield corpus (assertEmbedderGreenfield) — a re-test of the unchanged
//      active config is always allowed, even on a live corpus;
//   4. set validation='ok' (CAS-guarded), update the ACTIVE generation's provenance (model + provider,
//      dimension-gated → EmbedderProvenanceError if the width disagrees, 7-4), set runtime active_model_name,
//      and bump config_version — all atomically. Any throw rolls the whole thing back.
//
// The four typed errors map to HTTP 409 (config-changed / not-greenfield / provenance-mismatch) at the route.

import { type Kysely, type Transaction, sql } from "kysely";

/** A concurrent PUT re-staged the config between /test's probe and its promote (the CAS failed). → 409. */
export class EmbedderConfigChangedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EmbedderConfigChangedError";
  }
}

/** The embedding contract (model/provider/dimension) changed but the corpus is not greenfield. → 409. */
export class EmbedderNotGreenfieldError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EmbedderNotGreenfieldError";
  }
}

/** The active generation's embedding_dimension disagrees with the validated dimension. → 409. */
export class EmbedderProvenanceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EmbedderProvenanceError";
  }
}

/** The four pgvector corpus tables + the generation baseline that define "greenfield" (mirrors the
 *  set-embedding-dimension one-shot guard: a model/dimension change once ingest exists is the day-2
 *  re-embed path, not this one). */
async function assertEmbedderGreenfield(trx: Transaction<unknown>): Promise<void> {
  // tenant:exempt reason=platform-singleton-embedder-greenfield-gate follow_up=PERMANENT-EXEMPTION-embedder
  const counts = await sql<{
    knowledge_chunks: number;
    confluence_chunks: number;
    chunk_embeddings: number;
    cache_embeddings: number;
    active_generation: number;
    pending_generation: number | null;
    generation_count: number;
  }>`
    SELECT
      (SELECT count(*)::int FROM core.knowledge_chunks)                         AS knowledge_chunks,
      (SELECT count(*)::int FROM core.confluence_chunks)                        AS confluence_chunks,
      (SELECT count(*)::int FROM core.chunk_embeddings)                         AS chunk_embeddings,
      (SELECT count(*)::int FROM cache.cache_embeddings)                        AS cache_embeddings,
      (SELECT active_generation::int FROM core.embedder_runtime_state WHERE singleton = true)  AS active_generation,
      (SELECT pending_generation::int FROM core.embedder_runtime_state WHERE singleton = true) AS pending_generation,
      (SELECT count(*)::int FROM core.embedding_generations)                    AS generation_count
  `.execute(trx);
  const c = counts.rows[0]!;
  const corpus =
    c.knowledge_chunks + c.confluence_chunks + c.chunk_embeddings + c.cache_embeddings;
  if (
    corpus > 0 ||
    c.active_generation !== 1 ||
    c.pending_generation !== null ||
    c.generation_count !== 1
  ) {
    throw new EmbedderNotGreenfieldError(
      `refusing to change the embedding model/dimension on a non-greenfield corpus ` +
        `(vector rows=${corpus}, active_generation=${c.active_generation}, ` +
        `pending_generation=${String(c.pending_generation)}, generations=${c.generation_count}). ` +
        `Changing the model once content is ingested is the day-2 re-embed path, not /test.`,
    );
  }
}

export type PromoteValidatedEmbedderConfigArgs = {
  /** The settings.updated_at captured BEFORE the probe — the CAS token. */
  expectedToken: Date;
  modelName: string;
  provider: "openai_compat";
  /** The validated dimension (EMBEDDING_DIM) the probe asserted; gates the generation provenance update. */
  expectedDimension: number;
  /** Audit actor for last validation / config bump (resolved email or shim). */
  actorEmail: string;
};

/**
 * Promote a /test-validated config to the runtime, atomically. Throws (rolls back) on a CAS miss
 * ({@link EmbedderConfigChangedError}), a contract change on a non-greenfield corpus
 * ({@link EmbedderNotGreenfieldError}), or a dimension disagreement ({@link EmbedderProvenanceError}).
 */
export async function promoteValidatedEmbedderConfig(
  db: Kysely<unknown>,
  args: PromoteValidatedEmbedderConfigArgs,
): Promise<void> {
  await db.transaction().execute(async (txTyped) => {
    const trx = txTyped as unknown as Transaction<unknown>;

    // 1. Lock the settings singleton (serialize concurrent promotes) + read its current token + model.
    // tenant:exempt reason=platform-singleton-embedder-settings follow_up=PERMANENT-EXEMPTION-embedder
    const locked = await sql<{ updated_at: Date }>`
      SELECT updated_at FROM core.embedder_provider_settings WHERE singleton = true FOR UPDATE
    `.execute(trx);
    const settings = locked.rows[0];
    if (settings === undefined) {
      throw new EmbedderConfigChangedError("no embedder config row to promote (it was removed)");
    }
    // 2. CAS: the row must be exactly what /test probed. The compare is against the FOR-UPDATE-locked
    //    row's updated_at — both this and the token come back from pg as JS Dates (millisecond precision),
    //    so they truncate identically; a concurrent re-stage moves updated_at by far more than 1ms. The
    //    row lock held until COMMIT means no write can slip in between this check and the updates below, so
    //    this getTime() comparison IS the compare-and-swap (the subsequent UPDATEs filter on the singleton,
    //    NOT on updated_at — equality against the microsecond-precision column would never match a ms Date).
    if (settings.updated_at.getTime() !== args.expectedToken.getTime()) {
      throw new EmbedderConfigChangedError(
        "the embedder config changed during validation — re-run /test against the current config",
      );
    }

    // 3. Read the active generation's contract (model/provider/dimension) to decide contract-change.
    // tenant:exempt reason=platform-singleton-embedder-runtime-state follow_up=PERMANENT-EXEMPTION-embedder
    const rt = await sql<{ active_generation: number }>`
      SELECT active_generation::int AS active_generation
        FROM core.embedder_runtime_state WHERE singleton = true
    `.execute(trx);
    const activeGeneration = rt.rows[0]?.active_generation;
    if (activeGeneration === undefined || activeGeneration === null) {
      throw new EmbedderProvenanceError("no active embedding generation to record provenance on");
    }
    // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
    const genRows = await sql<{ model_name: string; provider_name: string; embedding_dimension: number }>`
      SELECT model_name, provider_name, embedding_dimension
        FROM core.embedding_generations WHERE generation_id = ${activeGeneration}
    `.execute(trx);
    const gen = genRows.rows[0];
    if (gen === undefined) {
      throw new EmbedderProvenanceError(`active generation ${activeGeneration} not found`);
    }

    // 4. Contract-change gate (7-2): greenfield required ONLY when the contract actually changes.
    const contractChanged =
      gen.model_name !== args.modelName ||
      gen.provider_name !== args.provider ||
      gen.embedding_dimension !== args.expectedDimension;
    if (contractChanged) {
      await assertEmbedderGreenfield(trx);
    }

    // 5. Set validation='ok' under the row lock (the step-2 CAS already proved the token). Does NOT touch
    //    updated_at — the token stays stable so a later re-test of the same config still matches.
    // tenant:exempt reason=platform-singleton-embedder-settings follow_up=PERMANENT-EXEMPTION-embedder
    const valUpd = await sql`
      UPDATE core.embedder_provider_settings
         SET last_validation_status = 'ok', last_validated_at = now(), last_validation_error = NULL
       WHERE singleton = true
    `.execute(trx);
    if ((valUpd.numAffectedRows ?? 0n) !== 1n) {
      throw new EmbedderConfigChangedError(
        "the embedder config changed during validation — re-run /test against the current config",
      );
    }

    // 6. updateActiveProvenance (7-4): set the active generation's model + provider, dimension-gated.
    // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
    const provUpd = await sql`
      UPDATE core.embedding_generations
         SET model_name = ${args.modelName}, provider_name = ${args.provider}
       WHERE generation_id = ${activeGeneration} AND embedding_dimension = ${args.expectedDimension}
    `.execute(trx);
    if ((provUpd.numAffectedRows ?? 0n) !== 1n) {
      throw new EmbedderProvenanceError(
        `active generation ${activeGeneration} dimension != validated dimension ${args.expectedDimension} ` +
          `— refusing to record provenance against a mismatched width`,
      );
    }

    // 7. Set runtime active_model_name + bump config_version (review/embedder workers refresh creds).
    // tenant:exempt reason=platform-singleton-embedder-runtime-state follow_up=PERMANENT-EXEMPTION-embedder
    const rtUpd = await sql`
      UPDATE core.embedder_runtime_state
         SET active_model_name = ${args.modelName}, config_version = config_version + 1,
             updated_at = now(), updated_by_email = ${args.actorEmail}
       WHERE singleton = true
    `.execute(trx);
    if ((rtUpd.numAffectedRows ?? 0n) !== 1n) {
      throw new Error("embedder runtime-state promotion affected != 1 row");
    }
  });
}
