/**
 * Runner OTel metrics (Task 1.12) — observability for the coarse-grained `review_jobs` runner.
 *
 * Mirrors the established subsystem-metric idiom (`api/auth/metrics.ts` for the histogram +
 * `observability/reconcile_metrics.ts` for the counter pattern): a module-scoped {@link Meter} and
 * instruments created once at import (avoids per-emit `create_*` lock contention), routed through the
 * `#platform/observability/metrics.js::getMeter` seam. The seam returns a no-op Meter when no
 * MeterProvider is registered, so emission is safe BEFORE the exporter is wired — no null-checks, no
 * `TODO`s in the emit path.
 *
 * Instruments (Grafana-query-stable names; renaming requires ADR):
 *   * codemaster_runner_claim_latency_ms       — histogram: wall time of a `claim()` round-trip.
 *   * codemaster_runner_lease_steals_total      — counter: a claim that RECLAIMED an expired lease
 *                                                 (reclaim mints attempts > 1) — i.e. a prior owner crashed.
 *   * codemaster_runner_heartbeat_failures_total— counter: a heartbeat refused (stale token / past timeout_at).
 *   * codemaster_runner_stale_token_writes_total{op}
 *                                                — counter: a fenced terminal write affected 0 rows (the
 *                                                  lease was stolen) — op ∈ {markDone, markFailed}.
 *   * codemaster_runner_jobs_total{outcome}     — counter: one per settled runOneJob, outcome ∈
 *                                                  {idle, done, failed, lease_lost, cancelled}.
 *   * codemaster_runner_handler_duration_ms     — histogram: wall time the handler ran (claim → settle).
 *   * codemaster_runner_retry_attempts_total    — counter: a job re-enqueued for another attempt (markFailed
 *                                                  non-terminal).
 *   * codemaster_runner_crash_loop_reaped_total — counter: stuck runs reaped by `reapStuckRuns()`.
 *   * codemaster_runner_handler_orphan_settled_total{phase}
 *                                                — counter: a handler kept running / rejected AFTER the
 *                                                  hard-runtime ceiling already SETTLED the job (it ignored
 *                                                  `work.signal`). The orphan promise's late settlement is
 *                                                  OBSERVED + swallowed here so it never becomes an unhandled
 *                                                  rejection. `phase=after_hard_timeout`.
 *
 * Phase 3a W2b — the GENERIC background runner (background_runner.ts) REUSES the shared instruments
 * above for the phenomena both runners share (claim latency, lease steals, heartbeat failures, stale
 * token writes, retries, handler duration, orphan settles, crash-loop reaps — existing Grafana panels
 * stay intact), and adds two background-specific ones:
 *   * codemaster_runner_background_jobs_total{outcome}
 *                                                — counter: one per settled runOneBackgroundJob, outcome ∈
 *                                                  {idle, done, failed, lease_lost, no_handler}. ('cancelled'
 *                                                  is review-pipeline-specific and does not exist here.)
 *   * codemaster_runner_background_no_handler_total
 *                                                — counter: a claimed background job whose job_type has NO
 *                                                  registered handler — DEAD-LETTERED by the runner, never
 *                                                  retried. NO job_type label: an unknown type is by
 *                                                  definition outside the registry's bounded vocabulary
 *                                                  (unbounded-cardinality risk); the dead row's dead_reason
 *                                                  carries the type for diagnosis.
 *
 * Phase 4a W4a.2 — the SCHEDULER (scheduler.ts) adds one:
 *   * codemaster_runner_scheduler_schedule_errors_total
 *                                                — counter: ONE schedule failed inside a pollAndEnqueue pass
 *                                                  (poison cadence_spec → computeNextRun threw, or its
 *                                                  enqueue/UPDATE errored) and was ISOLATED — skipped, left
 *                                                  unadvanced, the pass continued. NO schedule_id label
 *                                                  (operator-minted ids are unbounded); the paired WARN log
 *                                                  carries the id. A sustained non-zero rate = a permanently
 *                                                  bad schedule an operator must fix or disable.
 *
 * ## Cardinality discipline
 * Bounded-enum labels ONLY: `op` ∈ {markDone, markFailed}; `outcome` ∈ {idle, done, failed, lease_lost, cancelled}
 * (review) / {idle, done, failed, lease_lost, no_handler} (background); `phase` ∈ {after_hard_timeout}.
 * NEVER per-tenant / per-installation / per-PR / per-job labels — same discipline the sibling modules enforce.
 *
 * Fail-safe: every emit swallows meter errors so telemetry never perturbs the runner loop.
 */

import { type Counter, type Histogram, getMeter } from "#platform/observability/metrics.js";

// Counter / histogram NAMES — Grafana-query-stable (renaming requires ADR).
export const CLAIM_LATENCY_MS_NAME = "codemaster_runner_claim_latency_ms";
export const LEASE_STEALS_NAME = "codemaster_runner_lease_steals_total";
export const HEARTBEAT_FAILURES_NAME = "codemaster_runner_heartbeat_failures_total";
export const STALE_TOKEN_WRITES_NAME = "codemaster_runner_stale_token_writes_total";
export const JOBS_TOTAL_NAME = "codemaster_runner_jobs_total";
export const HANDLER_DURATION_MS_NAME = "codemaster_runner_handler_duration_ms";
export const RETRY_ATTEMPTS_NAME = "codemaster_runner_retry_attempts_total";
export const CRASH_LOOP_REAPED_NAME = "codemaster_runner_crash_loop_reaped_total";
export const HANDLER_ORPHAN_SETTLED_NAME = "codemaster_runner_handler_orphan_settled_total";
export const BACKGROUND_JOBS_TOTAL_NAME = "codemaster_runner_background_jobs_total";
export const BACKGROUND_NO_HANDLER_NAME = "codemaster_runner_background_no_handler_total";
export const SCHEDULER_SCHEDULE_ERRORS_NAME = "codemaster_runner_scheduler_schedule_errors_total";

// Meter + instruments cached at MODULE scope (created once at import).
const METER = getMeter("codemaster.runner");

const CLAIM_LATENCY_HISTOGRAM: Histogram = METER.createHistogram(CLAIM_LATENCY_MS_NAME, {
  description:
    "Wall time in milliseconds of a review_jobs claim() round-trip (the SKIP-LOCKED dequeue UPDATE). " +
    "Rising tails signal lock contention or a saturated runner pool.",
});
const HANDLER_DURATION_HISTOGRAM: Histogram = METER.createHistogram(HANDLER_DURATION_MS_NAME, {
  description:
    "Wall time in milliseconds a runOneJob handler ran (claim → settle). Distribution drives the " +
    "lease-TTL + hard-runtime-ceiling tuning.",
});
const LEASE_STEALS_COUNTER: Counter = METER.createCounter(LEASE_STEALS_NAME, {
  description:
    "Count of claims that RECLAIMED an expired lease (attempts minted > 1) — i.e. a prior owner crashed " +
    "mid-job. A sustained non-zero rate signals pod churn or under-provisioned lease TTLs.",
});
const HEARTBEAT_FAILURES_COUNTER: Counter = METER.createCounter(HEARTBEAT_FAILURES_NAME, {
  description:
    "Count of heartbeats that were REFUSED (stale token after a lease steal, or past timeout_at). Each " +
    "refusal makes runOneJob abort its handler cooperatively.",
});
const STALE_TOKEN_WRITES_COUNTER: Counter = METER.createCounter(STALE_TOKEN_WRITES_NAME, {
  description:
    "Count of fenced terminal writes (markDone/markFailed) that affected 0 rows because the lease was " +
    "stolen — the worker that lost the race. Bounded label op ∈ {markDone, markFailed}.",
});
const JOBS_TOTAL_COUNTER: Counter = METER.createCounter(JOBS_TOTAL_NAME, {
  description:
    "Count of settled runOneJob invocations, labeled by outcome ∈ {idle, done, failed, lease_lost, cancelled}. " +
    "The canonical runner-throughput + error-rate surface.",
});
const RETRY_ATTEMPTS_COUNTER: Counter = METER.createCounter(RETRY_ATTEMPTS_NAME, {
  description:
    "Count of jobs re-enqueued for another attempt (markFailed non-terminal). Pairs with jobs_total to " +
    "compute the retry ratio during LLM/GitHub incidents.",
});
const CRASH_LOOP_REAPED_COUNTER: Counter = METER.createCounter(CRASH_LOOP_REAPED_NAME, {
  description:
    "Count of stuck runs reaped by reapStuckRuns() (expired leases whose attempts are exhausted). " +
    "Each reaped run had its job dead-lettered, its run CANCELLED, and its PR-mutex released in one txn.",
});
const HANDLER_ORPHAN_SETTLED_COUNTER: Counter = METER.createCounter(HANDLER_ORPHAN_SETTLED_NAME, {
  description:
    "Count of handler promises that CONTINUED or REJECTED after the hard-runtime ceiling already settled " +
    "the job (the handler ignored work.signal). The orphan's late settlement is OBSERVED + swallowed so it " +
    "never escapes as an unhandled rejection. A sustained non-zero rate signals handlers that do not honor " +
    "cooperative cancellation. Bounded label phase ∈ {after_hard_timeout}.",
});
const BACKGROUND_JOBS_TOTAL_COUNTER: Counter = METER.createCounter(BACKGROUND_JOBS_TOTAL_NAME, {
  description:
    "Count of settled runOneBackgroundJob invocations (the GENERIC core.background_jobs runner), labeled by " +
    "outcome ∈ {idle, done, failed, lease_lost, no_handler}. The canonical background-platform throughput + " +
    "error-rate surface; separate from codemaster_runner_jobs_total so review-runner panels stay intact.",
});
const SCHEDULER_SCHEDULE_ERRORS_COUNTER: Counter = METER.createCounter(SCHEDULER_SCHEDULE_ERRORS_NAME, {
  description:
    "Count of schedules that FAILED inside a pollAndEnqueue pass (poison cadence_spec / enqueue / UPDATE error) " +
    "and were isolated — skipped + left unadvanced while the pass continued over the healthy schedules. NO " +
    "schedule_id label (operator-minted ids are unbounded-cardinality); the paired WARN log carries the id. A " +
    "sustained non-zero rate signals a permanently-bad schedule an operator must fix or disable.",
});
const BACKGROUND_NO_HANDLER_COUNTER: Counter = METER.createCounter(BACKGROUND_NO_HANDLER_NAME, {
  description:
    "Count of claimed background jobs whose job_type had NO registered handler — dead-lettered (terminalSettle, " +
    "dead_reason 'no handler for <job_type>'), never retried. A non-zero rate signals an enqueue/registry wiring " +
    "drift (a producer enqueues a type the composition root never registered). NO job_type label by design: an " +
    "unknown type is outside the bounded registry vocabulary; read the dead row's dead_reason for the type.",
});

/** Record one claim() round-trip latency (ms). Fail-safe. */
export function recordClaimLatencyMs(ms: number): void {
  try { CLAIM_LATENCY_HISTOGRAM.record(ms); } catch { /* telemetry never perturbs the runner */ }
}

/** Record one handler duration (ms). Fail-safe. */
export function recordHandlerDurationMs(ms: number): void {
  try { HANDLER_DURATION_HISTOGRAM.record(ms); } catch { /* telemetry never perturbs the runner */ }
}

/** Record one lease-steal (a reclaim that minted attempts > 1). Fail-safe. */
export function recordLeaseSteal(): void {
  try { LEASE_STEALS_COUNTER.add(1); } catch { /* telemetry never perturbs the runner */ }
}

/** Record one refused heartbeat (stale token / past timeout_at). Fail-safe. */
export function recordHeartbeatFailure(): void {
  try { HEARTBEAT_FAILURES_COUNTER.add(1); } catch { /* telemetry never perturbs the runner */ }
}

/** Record one fenced terminal write that lost the race. `op` ∈ {markDone, markFailed}. Fail-safe. */
export function recordStaleTokenWrite(args: { op: "markDone" | "markFailed" }): void {
  try { STALE_TOKEN_WRITES_COUNTER.add(1, { op: args.op }); } catch { /* telemetry never perturbs the runner */ }
}

/** Record one settled runOneJob outcome ∈ {idle, done, failed, lease_lost, cancelled}. Fail-safe. */
export function recordJobOutcome(args: { outcome: "idle" | "done" | "failed" | "lease_lost" | "cancelled" }): void {
  try { JOBS_TOTAL_COUNTER.add(1, { outcome: args.outcome }); } catch { /* telemetry never perturbs the runner */ }
}

/** Record one re-enqueued retry (markFailed non-terminal). Fail-safe. */
export function recordRetryAttempt(): void {
  try { RETRY_ATTEMPTS_COUNTER.add(1); } catch { /* telemetry never perturbs the runner */ }
}

/** Record the count of stuck runs reaped by one reapStuckRuns() sweep (0 emits nothing). Fail-safe. */
export function recordCrashLoopReaped(count: number): void {
  if (count <= 0) return;
  try { CRASH_LOOP_REAPED_COUNTER.add(count); } catch { /* telemetry never perturbs the runner */ }
}

/**
 * Record one orphaned handler whose promise continued/threw AFTER the hard-timeout already settled the
 * job. `phase` ∈ {after_hard_timeout}. Fail-safe.
 */
export function recordHandlerOrphanSettled(args: { phase: "after_hard_timeout" }): void {
  try { HANDLER_ORPHAN_SETTLED_COUNTER.add(1, { phase: args.phase }); } catch { /* telemetry never perturbs the runner */ }
}

/** Record one settled runOneBackgroundJob outcome ∈ {idle, done, failed, lease_lost, no_handler}. Fail-safe. */
export function recordBackgroundJobOutcome(
  args: { outcome: "idle" | "done" | "failed" | "lease_lost" | "no_handler" },
): void {
  try { BACKGROUND_JOBS_TOTAL_COUNTER.add(1, { outcome: args.outcome }); } catch { /* telemetry never perturbs the runner */ }
}

/** Record one no-handler dead-letter (claimed job_type absent from the registry). Fail-safe. */
export function recordNoHandlerDeadLetter(): void {
  try { BACKGROUND_NO_HANDLER_COUNTER.add(1); } catch { /* telemetry never perturbs the runner */ }
}

/** Record one schedule isolated (skipped + unadvanced) inside a pollAndEnqueue pass. Fail-safe. */
export function recordSchedulerScheduleError(): void {
  try { SCHEDULER_SCHEDULE_ERRORS_COUNTER.add(1); } catch { /* telemetry never perturbs the scheduler */ }
}
