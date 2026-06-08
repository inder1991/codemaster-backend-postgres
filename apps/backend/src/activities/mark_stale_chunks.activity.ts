/**
 * `MarkStaleChunksActivity` — FAITHFUL 1:1 TypeScript port of the frozen Python
 * `vendor/codemaster-py/codemaster/activities/mark_stale_chunks.py` (Sub-spec A T13).
 *
 * Flips `page_status` active → stale when chunks age past a threshold (spec §3.6 staleness lifecycle):
 *   - active: fresh; retrieval includes.
 *   - stale:  aged out; downstream retrieval can deprioritize.
 *   - 180-day default for most chunks.
 *   - 90-day stricter threshold for `topic:security_policy` (security guidance ages faster).
 *
 * The two passes run in ORDER: the security_policy pass at 90d FIRST, then the default pass at 180d
 * EXCLUDING `topic:security_policy` (so a security chunk between 90d and 180d is counted once, by the
 * security pass, not double-counted by the default pass).
 *
 * Race with `upsert_chunks_activity` is structurally safe: the sync write sets `stale_at = NULL` on
 * every active write (audit P1-1), so a chunk marked stale here is reset to active on the next sync if
 * the page is still live.
 *
 * ## FAITHFUL DIVERGENCE (ADR-0075)
 *
 * The Python read the thresholds from `core.platform_config` (operator-tunable) with spec-pinned
 * fallbacks 180/90. `platform_config_cache` is NOT ported (the same deferral as `hard_limits.ts` +
 * `retrieve_knowledge`), so the TS port INLINES the spec-pinned fallbacks directly. Tracked under
 * FOLLOW-UP-platform-config-cache.
 *
 * ## Runtime context / DSN / clock authority
 *
 * Runs in the NORMAL Node runtime (DB access sanctioned). Resolves the shared ADR-0062 pool from the
 * injected `dsn` (default `CODEMASTER_PG_CORE_DSN`). The eligibility predicate
 * `last_modified_at < now() - make_interval(...)` AND the `stale_at = now()` stamp both use the DB
 * `now()` (server transaction time) — 1:1 with the frozen Python SQL (no injected clock; the Python
 * activity stamped via the DB `now()`, not the infra clock). Both passes run in ONE transaction so a
 * throw rolls both back.
 *
 * ## Tenancy (cross-tenant by design)
 *
 * `core.confluence_chunks` is PLATFORM-WIDE (no `installation_id` post-migration-0063) → NOT in
 * TENANT_SCOPED_TABLES; the gate does not fire. The `// tenant:exempt` marker mirrors the frozen Python
 * source for documentation parity.
 */

import { type PoolClient } from "pg";

import { getPool, withPgTransaction } from "#platform/db/database.js";

import {
  type MarkStaleChunksInputV1,
  MarkStaleChunksInputV1 as MarkStaleChunksInputV1Schema,
  type MarkStaleChunksOutputV1,
} from "#contracts/confluence_sync_stale.v1.js";

// Spec-pinned fallbacks (ADR-0075 FOLLOW-UP-platform-config-cache). 1:1 with the Python `_FALLBACK_*`.
const FALLBACK_DAYS_DEFAULT = 180;
const FALLBACK_DAYS_SECURITY_POLICY = 90;

/** Injected collaborators (DSN for the shared pool; default `CODEMASTER_PG_CORE_DSN`). */
export type MarkStaleChunksActivityOptions = {
  dsn?: string;
};

/** Bound-method holder for `mark_stale_chunks_activity`. */
export class MarkStaleChunksActivity {
  private readonly explicitDsn: string | undefined;

  public constructor(opts: MarkStaleChunksActivityOptions = {}) {
    this.explicitDsn = opts.dsn;
  }

  /** Resolve the DSN: the injected one, else `CODEMASTER_PG_CORE_DSN`. */
  private resolveDsn(): string {
    if (this.explicitDsn !== undefined && this.explicitDsn !== "") {
      return this.explicitDsn;
    }
    const dsn = process.env.CODEMASTER_PG_CORE_DSN;
    if (dsn === undefined || dsn === "") {
      throw new Error("CODEMASTER_PG_CORE_DSN is not set; cannot run mark_stale_chunks_activity");
    }
    return dsn;
  }

  /**
   * Run the 2-pass staleness sweep. `input` is intentionally unused — the thresholds are inlined
   * (ADR-0075), not supplied by the caller; the empty input keeps the single-typed-input contract
   * (ADR-0047) satisfied.
   */
  public async markStaleChunks(input: MarkStaleChunksInputV1): Promise<MarkStaleChunksOutputV1> {
    MarkStaleChunksInputV1Schema.parse(input);

    const daysDefault = FALLBACK_DAYS_DEFAULT;
    const daysSecurity = FALLBACK_DAYS_SECURITY_POLICY;

    const pool = getPool(this.resolveDsn());

    const { secMarked, defaultMarked } = await withPgTransaction(pool, async (client: PoolClient) => {
      // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
      // Pass 1: security_policy chunks at the stricter threshold FIRST (the default pass filters them out).
      const sec = await client.query(
        `UPDATE core.confluence_chunks
            SET page_status = 'stale', stale_at = now()
          WHERE page_status = 'active'
            AND deleted_at IS NULL
            AND 'topic:security_policy' = ANY(labels)
            AND last_modified_at < now() - make_interval(days => $1)`,
        [daysSecurity],
      );
      const secMarked = sec.rowCount ?? 0;

      // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
      // Pass 2: default threshold, EXCLUDING security_policy (already handled by pass 1).
      const def = await client.query(
        `UPDATE core.confluence_chunks
            SET page_status = 'stale', stale_at = now()
          WHERE page_status = 'active'
            AND deleted_at IS NULL
            AND NOT ('topic:security_policy' = ANY(labels))
            AND last_modified_at < now() - make_interval(days => $1)`,
        [daysDefault],
      );
      const defaultMarked = def.rowCount ?? 0;

      return { secMarked, defaultMarked };
    });

    return {
      schema_version: 1,
      chunks_marked_stale_default: defaultMarked,
      chunks_marked_stale_security_policy: secMarked,
      threshold_days_default: daysDefault,
      threshold_days_security_policy: daysSecurity,
    };
  }
}
