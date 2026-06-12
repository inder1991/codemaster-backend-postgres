/**
 * Reconcile-dispatch + repair-workflow lifecycle counters — 1:1 port of the frozen Python
 * `vendor/codemaster-py/codemaster/observability/reconcile_metrics.py`.
 *
 * Four counters:
 *   * codemaster_reconcile_payload_missing_required_fields_total{event_type, missing_field}
 *       — the producer could not build a valid reconcile payload from a webhook body (F-5).
 *   * codemaster_repository_bootstrap_repairs_total{trigger_source}
 *       — a drift-detection event that ACTUALLY enqueued a repair workflow dispatch (F-6).
 *   * codemaster_repository_bootstrap_repair_cooldown_skips_total{trigger_source}
 *       — a drift-detection event SUPPRESSED by the cooldown window (F-6).
 *   * codemaster_repository_bootstrap_repair_blocked_skips_total{blocked_reason}
 *       — a drift-detection event SUPPRESSED because the installation is marked blocked (F-6 / v5 5.3).
 *
 * ## Emit context
 * These fire from the ACTIVITY / webhook (Node) runtime — `maybe_enqueue_repair` runs inside the webhook
 * transaction and the reconcile activity body, NEVER the workflow sandbox — so the TS port routes through
 * the standard `#platform/observability/metrics.js::getMeter` seam (the activity-runtime meter the sibling
 * counter modules use). The seam returns a no-op Meter when no MeterProvider is registered, so emission is
 * safe before the exporter is wired (the structural analogue of the Python `get_meter(...) is None` no-op).
 *
 * ## Cardinality discipline (the same the Python module enforces)
 * NO installation_id / repository_id / github_iid labels. Every label is a bounded enum:
 *   trigger_source ∈ {pr_webhook, admin_manual, installation_created, drift_sweep}
 *   blocked_reason ∈ {installation_not_found, installation_suspended, app_unauthorized, app_uninstalled}
 *   event_type     ∈ {installation, pull_request, installation_repositories}
 *   missing_field  ∈ the builder's SkipReason literals
 * github_installation_id is ALWAYS a log field, never a metric label.
 */

import { type Counter, getMeter } from "#platform/observability/metrics.js";

// Counter NAMES — copied VERBATIM from the Python constants (Grafana-query-stable; renaming requires ADR).
export const RECONCILE_PAYLOAD_MISSING_REQUIRED_FIELDS_NAME =
  "codemaster_reconcile_payload_missing_required_fields_total";
export const REPOSITORY_BOOTSTRAP_REPAIRS_NAME = "codemaster_repository_bootstrap_repairs_total";
export const REPOSITORY_BOOTSTRAP_REPAIR_COOLDOWN_SKIPS_NAME =
  "codemaster_repository_bootstrap_repair_cooldown_skips_total";
export const REPOSITORY_BOOTSTRAP_REPAIR_BLOCKED_SKIPS_NAME =
  "codemaster_repository_bootstrap_repair_blocked_skips_total";

// Meter + instruments cached at MODULE scope (created once at import), mirroring the Python lazy-cache that
// avoids per-emit create_* lock contention. Meter name = the dotted module path the Python uses.
const METER = getMeter("codemaster.reconcile");
const MISSING_FIELDS_COUNTER: Counter = METER.createCounter(
  RECONCILE_PAYLOAD_MISSING_REQUIRED_FIELDS_NAME,
  {
    description:
      "Count of webhook-triggered reconcile dispatch attempts where the producer's helper could not " +
      "extract a valid GitHub installation payload from the webhook body. Non-zero rate signals GitHub " +
      "schema drift OR malformed deliveries.",
  },
);
const REPAIRS_COUNTER: Counter = METER.createCounter(REPOSITORY_BOOTSTRAP_REPAIRS_NAME, {
  description:
    "Count of drift-detection events that actually enqueued a repair workflow dispatch. Bounded label " +
    "trigger_source distinguishes install-bootstrap vs PR-webhook-drift vs admin-manual.",
});
const COOLDOWN_SKIP_COUNTER: Counter = METER.createCounter(
  REPOSITORY_BOOTSTRAP_REPAIR_COOLDOWN_SKIPS_NAME,
  {
    description:
      "Count of drift-detection events suppressed by the repair cooldown window. Pairs with " +
      "*_repairs_total for suppression-ratio dashboards during incidents.",
  },
);
const BLOCKED_SKIP_COUNTER: Counter = METER.createCounter(
  REPOSITORY_BOOTSTRAP_REPAIR_BLOCKED_SKIPS_NAME,
  {
    description:
      "Count of drift-detection events suppressed because the installation is marked blocked by the " +
      "repair activity's terminal-failure classification. Each emit signals an installation requiring " +
      "admin intervention to clear blocked_reason/blocked_at via the documented runbook SQL.",
  },
);

/**
 * Emit one count for a builder-skip outcome (1:1 with the Python
 * `record_reconcile_payload_missing_required_fields`). `eventType` is bounded to the producer's accepted
 * set; `missingField` is the helper's SkipReason literal.
 */
export function recordReconcilePayloadMissingRequiredFields(args: {
  eventType: string;
  missingField: string;
}): void {
  MISSING_FIELDS_COUNTER.add(1, { event_type: args.eventType, missing_field: args.missingField });
}

/**
 * F-6 — emit one count per drift-detection event that ACTUALLY enqueued a repair workflow dispatch (1:1
 * with the Python `record_repository_bootstrap_repair`). `triggerSource` ∈ {pr_webhook, admin_manual,
 * installation_created} — bounded enum matching the RepairInstallationRepositoriesPayloadV1 contract.
 */
export function recordRepositoryBootstrapRepair(args: { triggerSource: string }): void {
  REPAIRS_COUNTER.add(1, { trigger_source: args.triggerSource });
}

/**
 * F-6 — emit per drift-detection event SUPPRESSED by the cooldown window (1:1 with the Python
 * `record_repository_bootstrap_repair_cooldown_skip`). Pair with {@link recordRepositoryBootstrapRepair}
 * to compute the suppression ratio during incidents.
 */
export function recordRepositoryBootstrapRepairCooldownSkip(args: { triggerSource: string }): void {
  COOLDOWN_SKIP_COUNTER.add(1, { trigger_source: args.triggerSource });
}

/**
 * F-6 (v5 5.3 poison-installation) — emit per drift-detection event SUPPRESSED because the installation is
 * marked blocked (terminal-failure classification). 1:1 with the Python
 * `record_repository_bootstrap_repair_blocked_skip`. `blockedReason` ∈ {installation_not_found,
 * installation_suspended, app_unauthorized, app_uninstalled} — bounded enum matching the SQL CHECK on
 * cache.repository_repair_state. EVERY emit is a manual-intervention candidate.
 */
export function recordRepositoryBootstrapRepairBlockedSkip(args: { blockedReason: string }): void {
  BLOCKED_SKIP_COUNTER.add(1, { blocked_reason: args.blockedReason });
}
