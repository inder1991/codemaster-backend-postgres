/**
 * PostgresEmbedderRuntimeStateRepo — accessor for the SINGLETON `core.embedder_runtime_state` row
 * (CHECK singleton=true → exactly one row).
 * The table owns the active/pending generation pointers + retrieval_mode + a MONOTONIC config_version.
 *
 * The load-bearing correctness property: every write bumps
 * `config_version` by exactly 1, ATOMICALLY with the field change, in ONE transaction. Workers poll
 * config_version and refresh their EmbedderCache on a bump (spec v4 §11.5 ≤30s propagation SLA).
 *
 * The (pending_generation, pending_model_name) pair is biconditional on disk
 * (`embedder_runtime_state_pending_pair_biconditional`): setPending writes BOTH, clearPending/activate
 * clear BOTH — so the half-populated shape the CHECK forbids is never written by this repo.
 *
 * Tenancy: this is a PLATFORM-WIDE table (no `installation_id`) → NOT in `TENANT_SCOPED_TABLES`, so the
 * raw-SQL tenancy gate does not fire. Inline `// tenant:exempt` markers mirror the platform-wide intent.
 *
 * ADR-0062: owns NO pool/engine cache; handed a `Kysely<unknown>` over the process-wide pool. Each write
 * runs inside `db.transaction()`.
 */

import { type Kysely, sql, type Transaction } from "kysely";

import type {
  EmbedderRuntimeStateRowV1,
  RetrievalMode,
} from "#contracts/embedder_runtime_state.v1.js";

/** The raw row shape pg hands back for the runtime-state projection (driver-native types). */
type RawStateRow = {
  active_generation: string | number;
  active_model_name: string;
  pending_generation: string | number | null;
  pending_model_name: string | null;
  config_version: string | number;
  retrieval_mode: RetrievalMode;
  updated_at: Date;
  updated_by_email: string | null;
};

/** Accessor for the singleton `core.embedder_runtime_state` row. */
export class PostgresEmbedderRuntimeStateRepo {
  private readonly db: Kysely<unknown>;

  public constructor({ db }: { db: Kysely<unknown> }) {
    this.db = db;
  }

  /** Fetch the singleton row (raises if the singleton is missing). */
  public async get(): Promise<EmbedderRuntimeStateRowV1> {
    // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
    const result = await sql<RawStateRow>`
      SELECT active_generation, active_model_name,
             pending_generation, pending_model_name,
             config_version, retrieval_mode,
             updated_at, updated_by_email
        FROM core.embedder_runtime_state WHERE singleton = true
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("embedder_runtime_state: singleton row is missing");
    }
    return {
      active_generation: Number(row.active_generation),
      active_model_name: String(row.active_model_name),
      pending_generation:
        row.pending_generation === null ? null : Number(row.pending_generation),
      pending_model_name: row.pending_model_name,
      config_version: Number(row.config_version),
      retrieval_mode: row.retrieval_mode,
      updated_at: row.updated_at,
      updated_by_email: row.updated_by_email,
    };
  }

  /**
   * Set the pending pair + bump config_version in one transaction. Writes BOTH pending fields so the
   * pending-pair biconditional holds.
   */
  public async setPending(args: {
    generationId: number;
    modelName: string;
    updatedByEmail: string;
  }): Promise<void> {
    await this.db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;
      // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
      await sql`
        UPDATE core.embedder_runtime_state
           SET pending_generation = ${args.generationId},
               pending_model_name = ${args.modelName},
               config_version = config_version + 1,
               updated_at = now(),
               updated_by_email = ${args.updatedByEmail}
         WHERE singleton = true
      `.execute(tx);
    });
  }

  /**
   * Clear the pending pair + bump config_version in one transaction. Clears BOTH pending fields so the
   * pending-pair biconditional holds.
   */
  public async clearPending(args: { updatedByEmail: string }): Promise<void> {
    await this.db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;
      // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
      await sql`
        UPDATE core.embedder_runtime_state
           SET pending_generation = NULL,
               pending_model_name = NULL,
               config_version = config_version + 1,
               updated_at = now(),
               updated_by_email = ${args.updatedByEmail}
         WHERE singleton = true
      `.execute(tx);
    });
  }

  /**
   * Set the active pointer, clear pending, bump config_version — atomically. Called by
   * EmbedderGenerationService.activate().
   */
  public async activate(args: {
    generationId: number;
    modelName: string;
    updatedByEmail: string;
  }): Promise<void> {
    await this.db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;
      // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
      await sql`
        UPDATE core.embedder_runtime_state
           SET active_generation = ${args.generationId},
               active_model_name = ${args.modelName},
               pending_generation = NULL,
               pending_model_name = NULL,
               config_version = config_version + 1,
               updated_at = now(),
               updated_by_email = ${args.updatedByEmail}
         WHERE singleton = true
      `.execute(tx);
    });
  }

  /**
   * Flip retrieval_mode + bump config_version atomically (spec v4 §8). Caller responsibility: verify
   * the coverage gate before flipping to 'generation_only';
   * the DB CHECK constraint provides the structural backstop on the vocabulary.
   */
  public async setRetrievalMode(args: {
    mode: RetrievalMode;
    updatedByEmail: string;
  }): Promise<void> {
    await this.db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;
      // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
      await sql`
        UPDATE core.embedder_runtime_state
           SET retrieval_mode = ${args.mode},
               config_version = config_version + 1,
               updated_at = now(),
               updated_by_email = ${args.updatedByEmail}
         WHERE singleton = true
      `.execute(tx);
    });
  }

  /**
   * Increment config_version WITHOUT changing any other field. Used by the platform-credentials admin
   * API to signal workers that the Qwen
   * credential rotated so they refresh their EmbedderCache within the v4 §11.5 ≤30s SLA.
   */
  public async bumpConfigVersion(args: { updatedByEmail: string }): Promise<void> {
    await this.db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;
      // tenant:exempt reason=embedder-platform-wide follow_up=PERMANENT-EXEMPTION-embedder
      await sql`
        UPDATE core.embedder_runtime_state
           SET config_version = config_version + 1,
               updated_at = now(),
               updated_by_email = ${args.updatedByEmail}
         WHERE singleton = true
      `.execute(tx);
    });
  }
}
