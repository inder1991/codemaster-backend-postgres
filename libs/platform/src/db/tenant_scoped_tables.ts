/**
 * Canonical tenant-scoped table registry — single source of truth.
 *
 * This is the consolidation point for the two consumers that previously each owned a copy of the
 * list:
 *
 *   1. The runtime tenancy plugin ({@link ./tenancy_plugin.ts}) — refuses any SELECT/UPDATE/DELETE
 *      on one of these tables that lacks an `installation_id` equality filter (invariant #10,
 *      "default deny everywhere").
 *   2. The PR-time raw-SQL gate (`scripts/gates/check_tenant_scoped_raw_sql.ts`) — which now
 *      re-exports {@link TENANT_SCOPED_TABLES} from here instead of holding a duplicate `Set`.
 *
 * The list was ported verbatim from the frozen Python gate
 * `vendor/codemaster-py/scripts/check_tenant_scoped_raw_sql.py` (migration-source-freeze, 46
 * schema-qualified tables that carry `installation_id`, or whose tenancy is enforced transitively).
 * Python is frozen; this list does not drift.
 *
 * ── Nullable / scope-discriminated tenancy (LEGACY_NON_TENANT_SCOPED_EXEMPTIONS) ──
 *
 * A handful of tables appear in the broad registry above but DO NOT express tenancy through an
 * `installation_id` equality predicate. Their `installation_id` is either the primary key itself,
 * NULLABLE (NULL = a platform-shared / global row), or superseded by a `scope` discriminator column
 * ('platform' | 'installation'). The frozen Python `LEGACY_NON_TENANT_SCOPED_EXEMPTIONS` registry
 * (`scripts/check_tenant_scoped_mixin.py`, per ADR-0019 + ADR-0029 + migration 0060) carries the
 * authoritative rationale, keyed by ORM class name. Here we translate it to the schema-qualified
 * table names the runtime plugin walks, so the plugin does not hard-refuse a legitimately
 * platform-scoped query (which by design has no per-tenant predicate, only the PK lookup or the
 * `scope` filter).
 *
 * These tables are deliberately NOT removed from {@link TENANT_SCOPED_TABLES}: the raw-SQL gate
 * still wants them flagged so a human reviews any raw query touching them. The runtime plugin
 * consults {@link LEGACY_NON_TENANT_SCOPED_EXEMPTIONS} to skip the hard `installation_id`-filter
 * requirement specifically.
 */

/**
 * The schema-qualified tables that carry `installation_id` (or are tenancy-enforced
 * transitively) and therefore MUST be filtered on it in every SELECT/UPDATE/DELETE.
 *
 * Re-exported by `scripts/gates/_registry.ts` — do not duplicate this Set elsewhere.
 */
export const TENANT_SCOPED_TABLES: ReadonlySet<string> = new Set<string>([
  "audit.audit_events",
  "audit.webhook_events",
  "audit.workflow_events",
  "cache.cache_app_jwt",
  "cache.cache_idempotency",
  "cache.cache_rate_limits",
  "cache.cache_tokens",
  "core.ad_users",
  "core.api_tokens",
  "core.arbitration_rejections",
  "core.code_owners",
  "core.config_revisions",
  "core.diff_snapshots",
  "core.feedback_events",
  "core.fix_prompts",
  "core.gh_users",
  "core.global_config",
  "core.installations",
  "core.integrations",
  "core.knowledge_chunks",
  "core.learning_proposals",
  "core.learnings",
  "core.learnings_revisions",
  // TS hardening divergence (ADR-0068) — NEW table absent from the frozen Python. The LLM-invocation
  // idempotency ledger carries installation_id NOT NULL; every query (insert + lookup) filters on it.
  "core.llm_invocation_ledger",
  "core.local_users",
  "core.org_configs",
  "core.outbox",
  "core.pr_files",
  "core.pr_issue_links",
  "core.pr_review_mutex",
  "core.pr_state_transitions",
  "core.pull_request_reviews",
  "core.pull_requests",
  "core.repo_configs",
  "core.repo_symbols",
  "core.repositories",
  "core.review_findings",
  "core.review_runs",
  "core.review_tool_runs",
  "core.role_grant_pending",
  "core.role_grants",
  "core.team_memberships",
  "core.teams",
  "core.users",
  "core.v_review_findings_with_phase",
  "telemetry.llm_calls",
  "telemetry.llm_calls_daily",
]);

/** Metadata for a table whose tenancy is NOT expressed via an `installation_id` equality filter. */
export type TenantExemptionEntry = {
  /** Why this table's tenancy is not an `installation_id` equality predicate. */
  readonly reason: string;
  /**
   * Tracking tag. `PERMANENT-EXEMPTION-*` for by-design platform-scope rows; a sprint-aligned
   * story id otherwise. Mirrors the Python `follow_up_story` field.
   */
  readonly follow_up_story: string;
};

/**
 * Schema-qualified tables the runtime tenancy plugin skips when checking for an `installation_id`
 * filter. Translated from the frozen Python `LEGACY_NON_TENANT_SCOPED_EXEMPTIONS` (class-name keyed)
 * to table-name keys. Tenancy for these rows is the PK itself, a NULLABLE column (NULL = global), or
 * a `scope` discriminator — none of which the `installation_id`-equality heuristic can model.
 */
export const LEGACY_NON_TENANT_SCOPED_EXEMPTIONS: ReadonlyMap<string, TenantExemptionEntry> = new Map<
  string,
  TenantExemptionEntry
>([
  [
    // `Installation` — installation_id IS the primary key, not a tenancy FK. The row IS the scope.
    "core.installations",
    {
      reason: "Tenancy identity table; installation_id IS its primary key, not a tenancy FK",
      follow_up_story: "PERMANENT-EXEMPTION-tenant-identity",
    },
  ],
  [
    // NULL rows = global rate limits; per-installation rows carry a value (ADR-0019).
    "cache.cache_rate_limits",
    {
      reason: "Platform-shared rate-limit cache (NULL row = global limit); per ADR-0019",
      follow_up_story: "PERMANENT-EXEMPTION-platform-shared-rate-limit",
    },
  ],
  [
    // Daily aggregate roll-up; cross-tenant reads gated by the privileged path (ADR-0019).
    "telemetry.llm_calls_daily",
    {
      reason: "Daily aggregate roll-up; cross-tenant reads gated by privilegedPath; per ADR-0019",
      follow_up_story: "PERMANENT-EXEMPTION-aggregate-rollup",
    },
  ],
  [
    // Tier-scoped — installation_id NULLABLE post-0060 (NULL for platform rows); scope discriminator.
    "core.role_grants",
    {
      reason: "Tier-scoped — platform_* roles are by-design platform-shared; see migration 0060",
      follow_up_story: "PERMANENT-EXEMPTION-tier-scoped-role-grants",
    },
  ],
  [
    "core.role_grant_pending",
    {
      reason: "Tier-scoped sibling of role_grants; installation_id NULLABLE; see migration 0060",
      follow_up_story: "PERMANENT-EXEMPTION-tier-scoped-role-grants",
    },
  ],
]);
