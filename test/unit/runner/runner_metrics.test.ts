/**
 * Unit tests for the runner OTel metric helpers (Task 1.12).
 *
 * The OTel meter seam (`#platform/observability/metrics.js::getMeter`) returns a NO-OP Meter when no
 * MeterProvider is registered, so emission is structurally safe before the exporter is wired. These
 * tests therefore assert the SHAPE the module exposes (metric names are Grafana-stable + the emit
 * functions don't throw), not exported metric values — matching how the sibling reconcile /
 * confluence-token / auth metric modules are covered.
 */

import { describe, expect, it } from "vitest";

import {
  CLAIM_LATENCY_MS_NAME,
  LOOP_CRASHED_NAME,
  CRASH_LOOP_REAPED_NAME,
  HANDLER_DURATION_MS_NAME,
  HANDLER_ORPHAN_SETTLED_NAME,
  HEARTBEAT_FAILURES_NAME,
  JOBS_TOTAL_NAME,
  LEASE_STEALS_NAME,
  RETRY_ATTEMPTS_NAME,
  SCHEDULER_SCHEDULE_ERRORS_NAME,
  STALE_TOKEN_WRITES_NAME,
  recordClaimLatencyMs,
  recordCrashLoopReaped,
  recordHandlerDurationMs,
  recordHandlerOrphanSettled,
  recordHeartbeatFailure,
  recordJobOutcome,
  recordLeaseSteal,
  recordRetryAttempt,
  recordRunnerLoopCrashed,
  recordSchedulerScheduleError,
  recordStaleTokenWrite,
} from "#backend/runner/runner_metrics.js";

describe("runner_metrics — metric names (Grafana-stable)", () => {
  it("exposes the documented runner metric name constants", () => {
    expect(CLAIM_LATENCY_MS_NAME).toBe("codemaster_runner_claim_latency_ms");
    expect(LEASE_STEALS_NAME).toBe("codemaster_runner_lease_steals_total");
    expect(HEARTBEAT_FAILURES_NAME).toBe("codemaster_runner_heartbeat_failures_total");
    expect(STALE_TOKEN_WRITES_NAME).toBe("codemaster_runner_stale_token_writes_total");
    expect(JOBS_TOTAL_NAME).toBe("codemaster_runner_jobs_total");
    expect(HANDLER_DURATION_MS_NAME).toBe("codemaster_runner_handler_duration_ms");
    expect(RETRY_ATTEMPTS_NAME).toBe("codemaster_runner_retry_attempts_total");
    expect(CRASH_LOOP_REAPED_NAME).toBe("codemaster_runner_crash_loop_reaped_total");
    expect(HANDLER_ORPHAN_SETTLED_NAME).toBe("codemaster_runner_handler_orphan_settled_total");
    expect(SCHEDULER_SCHEDULE_ERRORS_NAME).toBe("codemaster_runner_scheduler_schedule_errors_total");
    expect(LOOP_CRASHED_NAME).toBe("codemaster_runner_loop_crashed_total");
  });
});

describe("runner_metrics — emit functions are no-throw before exporter wiring", () => {
  it("records claim latency + handler duration histograms without throwing", () => {
    expect(() => recordClaimLatencyMs(12.5)).not.toThrow();
    expect(() => recordHandlerDurationMs(34.2)).not.toThrow();
  });

  it("records counters with bounded-enum labels without throwing", () => {
    expect(() => recordLeaseSteal()).not.toThrow();
    expect(() => recordHeartbeatFailure()).not.toThrow();
    expect(() => recordStaleTokenWrite({ op: "markDone" })).not.toThrow();
    expect(() => recordStaleTokenWrite({ op: "markFailed" })).not.toThrow();
    expect(() => recordJobOutcome({ outcome: "done" })).not.toThrow();
    expect(() => recordJobOutcome({ outcome: "failed" })).not.toThrow();
    expect(() => recordJobOutcome({ outcome: "lease_lost" })).not.toThrow();
    expect(() => recordJobOutcome({ outcome: "idle" })).not.toThrow();
    expect(() => recordRetryAttempt()).not.toThrow();
    expect(() => recordCrashLoopReaped(0)).not.toThrow();
    expect(() => recordCrashLoopReaped(3)).not.toThrow();
    expect(() => recordHandlerOrphanSettled({ phase: "after_hard_timeout" })).not.toThrow();
    expect(() => recordSchedulerScheduleError()).not.toThrow();
    expect(() => recordRunnerLoopCrashed({ loop: "runner" })).not.toThrow();
    expect(() => recordRunnerLoopCrashed({ loop: "scheduler" })).not.toThrow();
    expect(() => recordRunnerLoopCrashed({ loop: "outbox" })).not.toThrow();
  });
});
