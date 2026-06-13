/**
 * Policy-engine OTel metric helpers (Sprint 25 / T-3). `recordInvalidCitation` is the
 * citation-validator's activity-body counter.
 *
 * ## Cardinality discipline
 * NO `installation_id` / `repository_id` / per-PR labels on any counter. The platform serves 60+ orgs x
 * ~3,000 repos; per-installation labels would be a Prometheus cardinality explosion. Per-installation
 * drill-down lives in Tempo traces (span attributes), NOT in metric labels. The only label here is the
 * bounded-enum `enforcement_mode ∈ {observe, enforce}`.
 *
 * ## Emit context
 * `recordInvalidCitation` fires from inside `citation_validate_activity` (never the workflow sandbox),
 * so it routes through `#platform/observability/metrics.js::getMeter` — the same activity-runtime meter
 * sibling modules use. The seam returns a no-op Meter when no MeterProvider is registered, so emission
 * is safe before the exporter is wired (no null-checks, no TODOs). `@opentelemetry/api` always resolves
 * and `getMeter` always returns a Meter (no-op when no provider), so no import guard is needed.
 */
import { type Counter, getMeter } from "#platform/observability/metrics.js";

import type { PolicyCitationEnforcement } from "#contracts/policy_citation.v1.js";

// Counter NAME — Grafana-query-stable; renaming requires ADR. Keeps existing dashboards/alerts intact.
const INVALID_CITATION_NAME = "codemaster_policy_invalid_citation_total";

// Meter + instrument cached at module scope (created once at import) — avoids per-emit create_* lock contention.
const METER = getMeter("codemaster.policy");
const INVALID_CITATION_COUNTER: Counter = METER.createCounter(INVALID_CITATION_NAME, {
  description:
    "Count of policy_rule citations failing the validator membership check, labeled by enforcement mode.",
});

/**
 * Activity-body counter (citation_validate_activity context).
 *
 * Emitted once per policy_rule citation whose locator is NOT in this review's resolved policy bundle.
 * The `enforcement_mode` label:
 *   - `observe` — observe-mode mismatch logged via WARN, finding KEPT (rollout phase 1).
 *   - `enforce` — enforce-mode mismatch DROPS the finding (phase 2).
 */
export function recordInvalidCitation(enforcementMode: PolicyCitationEnforcement): void {
  INVALID_CITATION_COUNTER.add(1, { enforcement_mode: enforcementMode });
}
