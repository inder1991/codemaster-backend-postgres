/**
 * `ListActiveConfluenceSpacesActivity` — FAITHFUL 1:1 TypeScript port of the frozen Python
 * `vendor/codemaster-py/codemaster/activities/list_active_confluence_spaces.py` (Sub-spec A T12).
 *
 * Tiny entry-point activity: reads `core.integrations` to enumerate the ENABLED `confluence_space`
 * rows. The ConfluenceIngestWorkflow calls this once per 6-hour cycle to learn which spaces to sync
 * (BEFORE the per-space sync loop). It lives in its own file (not in confluence_sync.activity.ts),
 * mirroring the class-per-file convention the Python uses — keeping the test seam clean.
 *
 * ## Runtime context / DSN
 *
 * Runs in the NORMAL Node runtime (DB access sanctioned). Resolves the shared ADR-0062 pool from the
 * injected `dsn` (default `CODEMASTER_PG_CORE_DSN`) via {@link getPool}. The class-holder shape mirrors
 * the other class-based activities (EmbedQueryActivity, FetchLinkedIssuesActivity) so Stage 8 registers
 * the bound `listActiveSpaces` method under the Temporal name `list_active_confluence_spaces_activity`.
 *
 * ## Tenancy (cross-tenant by design)
 *
 * `core.integrations` IS in TENANT_SCOPED_TABLES, but the confluence corpus is PLATFORM-WIDE — there is
 * no per-installation Confluence space. The SELECT therefore carries the `// tenant:exempt` marker
 * (1:1 with the frozen Python source) per the raw-SQL tenancy gate.
 *
 * ## JSONB gotcha (1:1 with the Python)
 *
 * `config_json->>'space_key'` extracts the scalar IN SQL — sidestepping the asyncpg/node-pg JSONB
 * deserialization gotcha (a `config_json` column read back as an object). The space_key comes out as a
 * plain text column.
 */

import { getPool } from "#platform/db/database.js";

import {
  type ConfluenceSpaceRef,
  ConfluenceSpaceRef as ConfluenceSpaceRefSchema,
  type ListActiveSpacesInputV1,
  ListActiveSpacesInputV1 as ListActiveSpacesInputV1Schema,
  type ListActiveSpacesOutputV1,
} from "#contracts/confluence_sync.v1.js";

/** Injected collaborators (DSN for the shared pool; default `CODEMASTER_PG_CORE_DSN`). */
export type ListActiveConfluenceSpacesActivityOptions = {
  dsn?: string;
};

/** Bound-method holder for `list_active_confluence_spaces_activity`. */
export class ListActiveConfluenceSpacesActivity {
  private readonly explicitDsn: string | undefined;

  public constructor(opts: ListActiveConfluenceSpacesActivityOptions = {}) {
    this.explicitDsn = opts.dsn;
  }

  /** Resolve the DSN: the injected one, else `CODEMASTER_PG_CORE_DSN`. */
  private resolveDsn(): string {
    if (this.explicitDsn !== undefined && this.explicitDsn !== "") {
      return this.explicitDsn;
    }
    const dsn = process.env.CODEMASTER_PG_CORE_DSN;
    if (dsn === undefined || dsn === "") {
      throw new Error(
        "CODEMASTER_PG_CORE_DSN is not set; cannot run list_active_confluence_spaces_activity",
      );
    }
    return dsn;
  }

  /**
   * Return every enabled `confluence_space` integration row, ordered by `space_key` for deterministic
   * per-cycle processing order across retries and worker restarts.
   */
  public async listActiveSpaces(input: ListActiveSpacesInputV1): Promise<ListActiveSpacesOutputV1> {
    ListActiveSpacesInputV1Schema.parse(input);
    const pool = getPool(this.resolveDsn());

    // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
    const result = await pool.query<{ integration_id: string; space_key: string }>(
      `SELECT integration_id,
              config_json->>'space_key' AS space_key
       FROM   core.integrations
       WHERE  kind    = 'confluence_space'
         AND  enabled = TRUE
       ORDER  BY config_json->>'space_key'`,
    );

    // Validate EACH row through ConfluenceSpaceRef (space_key: min_length 1, max_length 64) — 1:1 with the
    // Python, which constructs `ConfluenceSpaceRef(...)` per row, so a malformed integration whose config_json
    // has no 'space_key' (the SQL `->>'space_key'` yields NULL) FAILS LOUDLY here rather than silently
    // emitting a NULL-space_key entry into the sync loop.
    const spaces: Array<ConfluenceSpaceRef> = result.rows.map((r) =>
      ConfluenceSpaceRefSchema.parse({
        schema_version: 1,
        integration_id: String(r.integration_id),
        space_key: r.space_key,
      }),
    );

    return { schema_version: 1, spaces };
  }
}
