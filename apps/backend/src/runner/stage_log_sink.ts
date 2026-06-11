// CS8 (C4/L12/XM14 — structured logging for degraded reviews): the Postgres runner's structured
// StageLogger.
//
// Pre-CS8 the review-job shell hardcoded a DISCARD StageLogger (`void msg`), and recordStage
// no-ops outside a Temporal workflow context — so in this runtime a degraded review emitted
// NOTHING anywhere: not a log line, not a metric. This module is the logs-only half of the fix
// (the metric-emission half is master-plan W0.5b, deferred with OTel): every degradation warning
// becomes ONE structured record carrying the correlation keys an operator pivots on —
// run_id / installation_id / head_sha / repo / stage / outcome / trace_id — emitted on an
// injectable {@link StageLogSink} whose production default is a pino logger (one JSON line on
// stdout; no OTel pipeline required).
//
// trace_id is carried but null today: OTel trace propagation is deferred across the codebase (the
// outbox writes trace_context: null; no tracer is wired) — the field exists so log tooling keyed
// on it needs no schema change when capture lands.
//
// pino is runner-only: this module is never imported by workflow code, so it can never enter the
// Temporal V8-isolate workflow bundle.

import { pino } from "pino";

import type { StageLogger, StageWarningFields } from "#backend/review/pipeline/degradation.js";

/** One structured degradation record — the unit every sink receives. */
export type StageLogRecord = {
  event: "review.stage_degraded";
  run_id: string;
  installation_id: string;
  head_sha: string;
  repo: string;
  /** Null until OTel trace capture is un-deferred (module doc). */
  trace_id: string | null;
  /** Null when the warning came from a message-only call site (the legacy shape). */
  stage: string | null;
  outcome: string | null;
  error_class: string | null;
  msg: string;
};

/** Where records go. Production: {@link makePinoStageLogSink}; tests: a recording array push. */
export type StageLogSink = (record: StageLogRecord) => void;

/** The per-job correlation context the shell binds once per execution. */
export type StageLogContext = {
  run_id: string;
  installation_id: string;
  head_sha: string;
  repo: string;
  trace_id?: string | null;
};

/**
 * A {@link StageLogger} that emits ONE {@link StageLogRecord} per warning on `sink`, merging the
 * bound job context with the call's structured fields (when the caller is field-aware —
 * degradation.ts stageOutcome since CS8) or nulls (legacy message-only call sites: the lifecycle
 * bookkeeping warnings, the orchestrator's cap lines). The sink never throws out of the logger —
 * telemetry must not perturb the review.
 */
export function makeStructuredStageLogger(bound: StageLogContext, sink: StageLogSink): StageLogger {
  return {
    warning: (msg: string, fields?: StageWarningFields): void => {
      try {
        sink({
          event: "review.stage_degraded",
          run_id: bound.run_id,
          installation_id: bound.installation_id,
          head_sha: bound.head_sha,
          repo: bound.repo,
          trace_id: bound.trace_id ?? null,
          stage: fields?.stage ?? null,
          outcome: fields?.outcome ?? null,
          error_class: fields?.error_class ?? null,
          msg,
        });
      } catch {
        /* a failing sink must never fail the review */
      }
    },
  };
}

// The production pino logger — ONE per process (the shell calls makePinoStageLogSink per job; all
// jobs share this instance, so a busy runner doesn't build a logger per review). Lazy so importing
// this module costs nothing until the first degradation actually logs.
let pinoLoggerMemo: ReturnType<typeof pino> | undefined;

/** The production {@link StageLogSink}: one pino WARN line per record (JSON on stdout). */
export function makePinoStageLogSink(): StageLogSink {
  return (record: StageLogRecord): void => {
    pinoLoggerMemo ??= pino({ name: "codemaster-runner" });
    const { msg, ...fields } = record;
    pinoLoggerMemo.warn(fields, msg);
  };
}
