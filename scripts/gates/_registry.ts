// CANONICAL SOURCE CONSOLIDATION (2026-06-04): the tenant-scoped table list now lives once, at
// `libs/platform/src/db/tenant_scoped_tables.ts`, and is consumed by BOTH the PR-time raw-SQL gate
// (`check_tenant_scoped_raw_sql.ts`, via this re-export) AND the runtime Kysely tenancy plugin
// (`libs/platform/src/db/tenancy_plugin.ts`). Previously this file owned a duplicate `Set` literal;
// the duplicate was the second source of truth and could silently drift from the plugin's view of
// "what is tenant-scoped." It is now a thin re-export so the two consumers cannot disagree.
//
// The list itself was ported verbatim from the frozen Python gate
// `vendor/codemaster-py/scripts/check_tenant_scoped_raw_sql.py` (migration-source-freeze, 46 tables).
export { TENANT_SCOPED_TABLES } from "#platform/db/tenant_scoped_tables.js";

export type ExemptedEntry = {
  reason: string;
  /** Sprint-aligned story id (S\d+\.[A-Z]+\.\d+), hotfix (S\d+\.X-<slug>), or PERMANENT-EXEMPTION-*. */
  follow_up_story: string;
}

// Empty at landing — mirrors the Python gate (no long-lived exempted sites). New entries require a
// follow_up_story per S23.AR.17 P-2 rotation. Prefer the inline `// tenant:exempt` marker for one-offs.
export const EXEMPTED: Record<string, ExemptedEntry> = {};
