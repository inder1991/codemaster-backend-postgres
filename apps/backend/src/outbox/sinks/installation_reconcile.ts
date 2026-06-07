// `installation_reconcile` outbox sink — 1:1 with the dedicated Python sink
// vendor/codemaster-py/codemaster/activities/outbox_sinks/installation_reconcile.py (worker boot:
// codemaster/worker/main.py:990 `installation_reconcile.register(sdk_client)`).
//
// The reconcile/repair outbox rows are written with `sink="installation_reconcile"` (the schema exemption
// that permits NULL installation_id; see PostgresOutboxRepo.appendReconcile). The dispatcher resolves the
// handler via `getSink(row.sink)`, so a row carrying that sink needs a registered `installation_reconcile`
// handler — without one, `getSink("installation_reconcile")` throws UnknownSinkError → PermanentSinkError →
// the row dead-letters on first attempt (the load-bearing gap this module closes).
//
// The Python ships a SEPARATE sink module whose body is IDENTICAL to temporal_workflow_start (the only
// difference is per-sink telemetry): it parses TemporalWorkflowStartPayloadV1 and forwards
// workflow_type/workflow_id/task_queue/args/policies verbatim to start_workflow. We REUSE the exact same
// `makeTemporalWorkflowStartHandler` handler instance under the second sink name, so the two sinks share one
// dispatch path (1:1 dispatch behaviour; per-sink telemetry is not yet split out on the TS side).

import { OUTBOX_SINK_INSTALLATION_RECONCILE } from "#backend/domain/repos/outbox_repo.js";
import { registerSink } from "#backend/outbox/sink_registry.js";

import { type TemporalClientPort } from "#backend/adapters/temporal_port.js";

import { makeTemporalWorkflowStartHandler } from "./temporal_workflow_start.js";

/** The canonical sink name — the same string {@link OUTBOX_SINK_INSTALLATION_RECONCILE} the repo writes. */
export const SINK_NAME = OUTBOX_SINK_INSTALLATION_RECONCILE;

/**
 * Register the `installation_reconcile` sink handler into the sink registry (called at dispatcher boot,
 * next to {@link registerTemporalWorkflowStartSink}). Binds the SAME generic temporal-workflow-start handler
 * (parse TemporalWorkflowStartPayloadV1 → start_workflow by the in-payload workflow_type/task_queue) under
 * the `installation_reconcile` sink name, so reconcile/repair rows actually start their workflows.
 */
export function registerInstallationReconcileSink(port: TemporalClientPort): void {
  registerSink(SINK_NAME, makeTemporalWorkflowStartHandler(port));
}
