// IO wrapper for the deploy preflight: builds the real {@link ObserveDeps} from a live DB pool, the
// Vault-Agent secrets dir, and the process environment. Kept apart from deploy_preflight.ts so the
// evaluator + contract stay pure (no kysely / fs imports) and exhaustively unit-testable.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { sql, type Kysely } from "kysely";

import { WallClock } from "#platform/clock.js";

import { DEFAULT_VAULT_SECRETS_DIR } from "./adapters/vault_file_kv.js";
import { makeReadVaultKv } from "./config/vault_reader_factory.js";
import {
  type EmbeddingDimensionObserveDeps,
  type ObserveDeps,
  type PartitionRunwayObservation,
  parseRenderedSecret,
  type RunwayObserveDeps,
} from "./deploy_preflight.js";
import { EMBEDDING_DIM } from "#backend/adapters/embeddings_port.js";

/**
 * Build the real preflight IO deps. `db` is any Kysely over the core pool; `secretsDir` defaults to
 * the Vault-Agent mount (env override honored); `env` defaults to process.env (injectable for tests).
 */
export function makeObserveDeps(args: {
  db: Kysely<unknown>;
  secretsDir?: string;
  env?: Record<string, string | undefined>;
}): ObserveDeps {
  const env = args.env ?? process.env;
  const secretsDir =
    args.secretsDir ?? env["CODEMASTER_VAULT_SECRETS_DIR"] ?? DEFAULT_VAULT_SECRETS_DIR;
  // SA-auth Vault reader so the preflight can ACTUALLY read + validate the field-encryption keyset in vault
  // mode (review N4). Lazy: makeReadVaultKv builds the K8s-auth client but only logs in on first call, and the
  // observer calls it only on the vault field-key branch. clock for the lease timing (one-shot read).
  const clock = new WallClock();
  const readVaultKv = makeReadVaultKv({ env, now: () => clock.now().getTime() });

  return {
    env: (name) => env[name],
    readVaultKv,
    readSecretFile: async (fileName) => {
      try {
        return parseRenderedSecret(await readFile(join(secretsDir, fileName), "utf-8"));
      } catch {
        // ENOENT (secret not rendered) or any read error → treat as absent; the validator reports it.
        return null;
      }
    },
    listExtensions: async () => {
      const r = await sql<{ extname: string }>`SELECT extname FROM pg_catalog.pg_extension`.execute(
        args.db,
      );
      return r.rows.map((row) => row.extname);
    },
    listSchemas: async () => {
      const r = await sql<{ nspname: string }>`SELECT nspname FROM pg_catalog.pg_namespace`.execute(
        args.db,
      );
      return r.rows.map((row) => row.nspname);
    },
  };
}

/**
 * Build the runway-check IO deps (F1 / P0-1): the furthest future upper bound per registered pg_partman
 * parent. A LEFT JOIN so a parent registered in part_config with NO range child (only its *_default)
 * surfaces as furthestBoundMs=null. The bound is parsed from `FOR VALUES … TO ('<ts>')` — DEFAULT
 * partitions (whose expr is the literal `DEFAULT`) don't match the pattern and are excluded.
 */
export function makeRunwayObserveDeps(args: { db: Kysely<unknown> }): RunwayObserveDeps {
  return {
    now: () => new WallClock().now(),
    listPartitionRunways: async () => {
      // tenant:exempt reason=cluster-wide-partition-catalog-runway-check follow_up=PERMANENT-EXEMPTION-partition-maintenance
      const r = await sql<{ parent: string; furthest: string | null }>`
        SELECT pc.parent_table AS parent,
               max(substring(pg_get_expr(k.relpartbound, k.oid) FROM 'TO \\(''([^'']+)''')) AS furthest
          FROM partman.part_config pc
          JOIN pg_class p ON p.oid = to_regclass(pc.parent_table)
          LEFT JOIN pg_inherits i ON i.inhparent = p.oid
          LEFT JOIN pg_class k ON k.oid = i.inhrelid
                              AND pg_get_expr(k.relpartbound, k.oid) LIKE 'FOR VALUES FROM%'
         GROUP BY pc.parent_table
      `.execute(args.db);
      return r.rows.map<PartitionRunwayObservation>((row) => ({
        parent: row.parent,
        furthestBoundMs: row.furthest === null ? null : Date.parse(row.furthest),
      }));
    },
  };
}

/** Build the embedding-dimension observation: the configured EMBEDDING_DIM + the DB's recorded widths. */
export function makeEmbeddingDimensionObserveDeps(args: {
  db: Kysely<unknown>;
}): EmbeddingDimensionObserveDeps {
  return {
    observeEmbeddingDimension: async () => {
      // tenant:exempt reason=platform-singleton-embedder-dimension-preflight follow_up=PERMANENT-EXEMPTION-embedder-dimension
      const st = await sql<{ active_gen_dim: number | null; active_embedding_dimension: number | null }>`
        SELECT g.embedding_dimension AS active_gen_dim,
               s.active_embedding_dimension AS active_embedding_dimension
          FROM core.embedder_runtime_state s
          LEFT JOIN core.embedding_generations g ON g.generation_id = s.active_generation
         WHERE s.singleton = true
      `.execute(args.db);
      // pgvector stores the dimension directly in atttypmod (-1 = unconstrained).
      const cols = await sql<{ col: string; dim: number }>`
        SELECT format('%s.%s.%s', n.nspname, c.relname, a.attname) AS col, a.atttypmod AS dim
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_type t ON t.oid = a.atttypid
         WHERE t.typname = 'vector' AND a.atttypmod > 0
           AND (n.nspname, c.relname, a.attname) IN (
             ('core', 'chunk_embeddings', 'embedding'),
             ('core', 'knowledge_chunks', 'vector'),
             ('core', 'confluence_chunks', 'embedding'),
             ('cache', 'cache_embeddings', 'embedding')
           )
      `.execute(args.db);
      return {
        configuredDim: EMBEDDING_DIM,
        activeGenerationDim: st.rows[0]?.active_gen_dim ?? null,
        activeEmbeddingDimension: st.rows[0]?.active_embedding_dimension ?? null,
        columnDims: cols.rows.map((r) => ({ column: r.col, dim: r.dim })),
      };
    },
  };
}
