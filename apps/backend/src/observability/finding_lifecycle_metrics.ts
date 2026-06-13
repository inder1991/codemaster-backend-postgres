// Finding-delivery-lifecycle metrics (ADR-0056). Closes FOLLOW-UP-lifecycle-bookkeeping-otel-counters
// from Stage 3.
//
// SCOPE (this module): the two counters the lifecycle-bookkeeping block emits —
//   * codemaster_finding_lifecycle_setter_succeeded_total{setter}        (H-3)
//   * codemaster_finding_lifecycle_setter_failed_total{setter, retryable}
//
// EMIT SEAM (de-Temporal): the Python sourced these from `workflow.metric_meter()` (replay-safe inside a
// Temporal workflow). With Temporal removed, the runner runs the lifecycle bookkeeping in-process — there
// is no workflow context and no history replay — so the counters emit through the platform OTel meter
// ({@link getMeter}), the codebase's single sanctioned metrics seam. This is strictly better than the old
// `inWorkflowContext()`-guarded path, which no-op'd entirely outside a workflow (i.e. always, in the
// Postgres runtime): the counters now actually emit. Until a MeterProvider is installed the `.add()` calls
// are no-ops (safe — the deferred exporter wiring).
//
// ── LABELS (bounded enums; cardinality discipline) ──
//   setter ∈ {finalized, skipped, degraded, finalized_len_mismatch}  (finalized_len_mismatch is
//     failure-only by construction — the F9 rfid/comment_id length-mismatch path).
//   retryable ∈ {"true", "false"}  (string form, matching the Prometheus bool serialization convention).
// NO installation_id / repository_id / per-PR labels.

import { type Counter, getMeter } from "#platform/observability/metrics.js";

/** The setter label on the SUCCEEDED counter (finalized_len_mismatch is failure-only, so excluded here). */
export type LifecycleSuccessLabel = "finalized" | "skipped" | "degraded";
/** The setter label on the FAILED counter (includes the F9 finalized_len_mismatch failure-only value). */
export type LifecycleFailureLabel = "finalized" | "skipped" | "degraded" | "finalized_len_mismatch";

// Counter NAMES — dashboard/alert stable; renaming requires ADR.
export const LIFECYCLE_SETTER_SUCCEEDED_COUNTER_NAME =
  "codemaster_finding_lifecycle_setter_succeeded_total";
export const LIFECYCLE_SETTER_FAILED_COUNTER_NAME =
  "codemaster_finding_lifecycle_setter_failed_total";

// Instruments cached at MODULE scope (the getMeter convention — created once at import, no per-emit
// create-counter contention).
const METER = getMeter("codemaster.review.lifecycle");
const SUCCEEDED: Counter = METER.createCounter(LIFECYCLE_SETTER_SUCCEEDED_COUNTER_NAME, {
  description:
    "Count of lifecycle-setter dispatches that returned successfully. Label: setter in " +
    "{finalized, skipped, degraded}. Use alongside the setter_failed counter for failure rate.",
});
const FAILED: Counter = METER.createCounter(LIFECYCLE_SETTER_FAILED_COUNTER_NAME, {
  description:
    "Count of lifecycle-setter dispatches that raised. Labels: setter in " +
    "{finalized, skipped, degraded, finalized_len_mismatch}; retryable in {true, false}. " +
    "Bookkeeping-only; the review has already posted.",
});

/**
 * Increment the setter-succeeded counter — called immediately after a lifecycle dispatch returns cleanly.
 */
export function recordLifecycleSetterSucceeded(args: { setter: LifecycleSuccessLabel }): void {
  SUCCEEDED.add(1, { setter: args.setter });
}

/**
 * Increment the setter-failed counter — called when a lifecycle dispatch raises (or the F9
 * finalized_len_mismatch path fires). The `retryable` label is the string form `"true"` / `"false"`
 * (the Prometheus bool serialization convention).
 */
export function recordLifecycleSetterFailed(args: {
  setter: LifecycleFailureLabel;
  retryable?: boolean;
}): void {
  const retryable = args.retryable ?? true;
  FAILED.add(1, { setter: args.setter, retryable: retryable ? "true" : "false" });
}
