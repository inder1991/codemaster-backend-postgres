/**
 * PostgresCodeOwnersRepo — 1:1 TS port of the frozen
 * `vendor/codemaster-py/codemaster/domain/repos/code_owners_repo.py`
 * (`PostgresCodeOwnersRepo`).
 *
 * Async repo over `core.code_owners`. Two public operations, ported method-for-method:
 *
 *  - {@link PostgresCodeOwnersRepo.upsertRules} — bulk INSERT with
 *    `ON CONFLICT (repository_id, path_pattern, source_file_sha) DO NOTHING`.
 *    Idempotent under replay: re-running with the same CODEOWNERS file SHA produces
 *    zero net change. Returns the count of rows the INSERT actually wrote (ON CONFLICT
 *    no-ops do NOT count). Empty `rules` returns 0 without touching the DB.
 *  - {@link PostgresCodeOwnersRepo.listRulesForRepository} — returns every CURRENT
 *    CODEOWNERS rule for one repository, deduped to the most-recently-synced
 *    `source_file_sha` via a CTE, ordered by `path_pattern ASC`. Returns the parser's
 *    `CodeOwnerRule` shape (`line_number` is 0 — the DB persists by-rule, not by-line).
 *
 * Tenancy (CLAUDE.md invariant #10 / "default deny everywhere"): every INSERT carries an
 * explicit `installation_id`; the single read filters `WHERE installation_id = :iid`. The
 * repo's {@link Kysely} instance installs {@link TenancyPlugin} for defense-in-depth on any
 * future builder-shaped query (raw `sql\`\`` templates bypass the AST walk by design — the
 * tenancy is carried explicitly in the WHERE here, mirroring the frozen Python `text()` SQL).
 *
 * Schema (confirmed live against the disposable PG, `\d core.code_owners`):
 *   code_owner_id   uuid        PK, default gen_random_uuid()
 *   installation_id uuid        NOT NULL, FK → core.installations
 *   repository_id   uuid        NOT NULL, FK → core.repositories (ON DELETE CASCADE)
 *   path_pattern    varchar(1024) NOT NULL, CHECK length >= 1
 *   owner_logins    text[]      NOT NULL, CHECK cardinality >= 1
 *   source_file_sha char(40)    NOT NULL
 *   synced_at       timestamptz NOT NULL, default now()
 *   UNIQUE (repository_id, path_pattern, source_file_sha)
 *
 * ADR-0062: the pg Pool + Kysely instance are MEMOIZED (one per DSN), never built per call.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import type { CodeOwnerRuleV1 } from "#contracts/code_owner_rule.v1.js";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";

/**
 * The parser's rule shape — TS port of
 * `vendor/codemaster-py/codemaster/integrations/github/codeowners_parser.py::CodeOwnerRule`.
 *
 * `listRulesForRepository` returns this (not the wire envelope {@link CodeOwnerRuleV1}) because
 * the downstream `rank_suggested_reviewers` pure function expects it. `line_number` is the
 * 1-indexed source-file line for diagnostics; the DB persists by-rule (not by-line), so the
 * read path sets it to 0 exactly as the Python source does.
 */
export type CodeOwnerRule = {
  readonly path_pattern: string;
  readonly owner_logins: ReadonlyArray<string>;
  readonly line_number: number;
};

/** Minimal Kysely table typing for `core.code_owners` (the only table this repo touches). */
type CodeOwnersTable = {
  code_owner_id: string;
  installation_id: string;
  repository_id: string;
  path_pattern: string;
  owner_logins: Array<string>;
  source_file_sha: string;
  synced_at: Date;
};

type CodeOwnersDb = {
  "core.code_owners": CodeOwnersTable;
};

// ── ADR-0062 memoization: one Pool + one Kysely per DSN, never per call ──

const POOL_BY_DSN = new Map<string, Pool>();
const DB_BY_DSN = new Map<string, Kysely<CodeOwnersDb>>();

/** Memoized pg Pool for a DSN (ADR-0062 — engine/pool caching, never per-call). */
export function getCodeOwnersPool(dsn: string): Pool {
  let pool = POOL_BY_DSN.get(dsn);
  if (pool === undefined) {
    pool = new Pool({ connectionString: dsn });
    POOL_BY_DSN.set(dsn, pool);
  }
  return pool;
}

/**
 * Memoized {@link Kysely} instance for a DSN, with {@link TenancyPlugin} installed so
 * installation_id scoping is enforced on builder-shaped tenant-scoped queries.
 */
export function getCodeOwnersDb(dsn: string): Kysely<CodeOwnersDb> {
  let db = DB_BY_DSN.get(dsn);
  if (db === undefined) {
    db = new Kysely<CodeOwnersDb>({
      dialect: new PostgresDialect({ pool: getCodeOwnersPool(dsn) }),
      plugins: [new TenancyPlugin()],
    });
    DB_BY_DSN.set(dsn, db);
  }
  return db;
}

/** Implements the `CodeOwnersRepoPort` against `core.code_owners`. */
export class PostgresCodeOwnersRepo {
  readonly #db: Kysely<CodeOwnersDb>;

  constructor(args: { db: Kysely<CodeOwnersDb> }) {
    this.#db = args.db;
  }

  /**
   * Bulk INSERT every rule; `ON CONFLICT DO NOTHING` absorbs replays.
   *
   * Returns the count of rows the INSERT actually wrote (i.e. excluding ON CONFLICT
   * no-ops). When the source file's SHA matches an already-persisted batch, every row
   * no-ops and the return value is 0. Empty `rules` returns 0 without touching the DB.
   *
   * 1:1 with `code_owners_repo.py::upsert_rules`: one transaction per call,
   * caller-independent; `synced_at` is set to `now()` by the DB (server clock — no client
   * wall-clock involved).
   */
  async upsertRules(args: {
    installationId: string;
    repositoryId: string;
    rules: ReadonlyArray<CodeOwnerRuleV1>;
  }): Promise<number> {
    const { installationId, repositoryId, rules } = args;
    if (rules.length === 0) {
      return 0;
    }

    // Per-rule VALUES tuples. owner_logins is bound as a text[] (the Python `:ol_i::text[]`
    // cast); pg's parameter binding sends a JS Array<string> as a Postgres text[] literal,
    // and the explicit `::text[]` cast preserves the element type exactly as the source SQL.
    const rows = rules.map(
      (rule) => sql`(
        ${rule.code_owner_id},
        ${installationId},
        ${repositoryId},
        ${rule.path_pattern},
        ${sql`${[...rule.owner_logins]}`}::text[],
        ${rule.source_file_sha},
        now()
      )`,
    );

    const result = await sql`
      INSERT INTO core.code_owners
        (code_owner_id, installation_id, repository_id,
         path_pattern, owner_logins, source_file_sha, synced_at)
      VALUES ${sql.join(rows, sql`, `)}
      ON CONFLICT (repository_id, path_pattern, source_file_sha) DO NOTHING
    `.execute(this.#db);

    // numAffectedRows is the count the INSERT actually wrote; ON CONFLICT no-ops don't count
    // (matches the Python `result.rowcount`).
    return Number(result.numAffectedRows ?? 0n);
  }

  /**
   * Return every CURRENT CODEOWNERS rule for one repository (1:1 with
   * `code_owners_repo.py::list_rules_for_repository`).
   *
   * Tenancy-isolated by `installation_id`. Source-file-SHA dedup: the table can hold
   * multiple rows for the same `(repository_id, path_pattern)` across SHAs (the UNIQUE
   * constraint includes `source_file_sha`); the consumer wants the CURRENT rules, so this
   * filters to the most-recently-synced SHA via a CTE (`ORDER BY synced_at DESC LIMIT 1`).
   *
   * Ordered by `path_pattern ASC` for deterministic ranker input. Each returned
   * `CodeOwnerRule` has `line_number = 0` (the DB persistence is by-rule, not by-line).
   */
  async listRulesForRepository(args: {
    installationId: string;
    repositoryId: string;
  }): Promise<ReadonlyArray<CodeOwnerRule>> {
    const { installationId, repositoryId } = args;
    const result = await sql<{
      path_pattern: string;
      owner_logins: Array<string> | null;
    }>`
      WITH latest AS (
        SELECT source_file_sha
        FROM core.code_owners
        WHERE installation_id = ${installationId} AND repository_id = ${repositoryId}
        ORDER BY synced_at DESC
        LIMIT 1
      )
      SELECT path_pattern, owner_logins
      FROM core.code_owners
      WHERE installation_id = ${installationId}
        AND repository_id = ${repositoryId}
        AND source_file_sha = (SELECT source_file_sha FROM latest)
      ORDER BY path_pattern ASC
    `.execute(this.#db);

    return result.rows.map((r) => ({
      path_pattern: String(r.path_pattern),
      owner_logins: Object.freeze([...(r.owner_logins ?? [])]),
      // The DB row doesn't carry the source line_number; the field exists for diagnostics in
      // the parser path only. Set to 0 (the schema's source-of-truth is the original
      // CODEOWNERS file's line; the DB persistence is by-rule, not by-line).
      line_number: 0,
    }));
  }
}
