// F-5b (bootstrap-state-coverage plan v5) — shared `maybeEnqueueRepair` helper.
//
// FAITHFUL 1:1 port of the frozen Python `vendor/codemaster-py/codemaster/ingest/_repair_dispatcher.py`.
// Used by BOTH:
//   * reconcile_installation (installation_created path)
//   * github_webhook_persistence (PR-webhook drift detection path; the integrator wires the call site —
//     this module does NOT edit the webhook handler).
//
// Encapsulates the full "should I enqueue, and if so, do it" decision as a single transactional unit:
//
//   cooldown/blocked check → envelope build → outbox write → markAttempted → repairs_total emit
//
// OR (suppression path):
//
//   isBlocked       → blocked_skips_total{blocked_reason} emit
//   cooldownActive  → cooldown_skips_total{trigger_source} emit
//
// Callers receive a bool: true = enqueued; false = suppressed.

import { type Kysely } from "kysely";

import {
  getStateForEnqueueDecision,
  markAttempted,
  type RepairStateDecision,
} from "#backend/ingest/_repair_state.js";
import {
  PostgresOutboxRepo,
  RECONCILE_PAYLOAD_SCHEMA_VERSION,
} from "#backend/domain/repos/outbox_repo.js";
import {
  recordRepositoryBootstrapRepair,
  recordRepositoryBootstrapRepairBlockedSkip,
  recordRepositoryBootstrapRepairCooldownSkip,
} from "#backend/observability/reconcile_metrics.js";

import { TemporalWorkflowStartPayloadV1 } from "#contracts/outbox_payloads.v1.js";
import {
  RepairInstallationRepositoriesPayloadV1,
  type TriggerSource,
} from "#contracts/repair_installation_repositories.v1.js";

/** A Kysely instance or an open Transaction — the executor the outbox INSERT + repair-state writes join. */
type Executor = Kysely<unknown>;

// Repair-workflow dispatch constants — RE-TARGETED onto the combined-pod review worker (project-owner
// directive: reuse the review worker, no separate "ingest" worker). DELIBERATE DIVERGENCE from the frozen
// Python `workflows/repair_installation_repositories.py` (which pins "ingest" + the PascalCase
// `RepairInstallationRepositoriesWorkflow` class name):
//
//   * workflow_type = "repairInstallationRepositories" — the camelCase EXPORTED function name the combined
//     worker registers (reconcile.workflow.ts), since RealTemporalClient.startWorkflow dispatches by the
//     registered TS function name.
//   * task_queue = "review-default" (REVIEW_TASK_QUEUE in github_webhook_persistence.ts) — the queue the
//     combined-pod review worker polls. The repair workflow + the hydrate activity register on THAT worker,
//     so the dispatched outbox row must carry that queue. Inlined as the literal here (rather than imported)
//     to avoid a cycle through github_webhook_persistence; the two MUST stay in lockstep.
export const REPAIR_INSTALLATION_REPOSITORIES_TASK_QUEUE = "review-default";
export const REPAIR_INSTALLATION_REPOSITORIES_WORKFLOW_TYPE = "repairInstallationRepositories";

/**
 * Producer-side gated repair-dispatch (1:1 with the Python `maybe_enqueue_repair`).
 *
 * Returns true if a repair workflow was enqueued; false if the enqueue was suppressed (cooldown OR
 * blocked). The caller's only responsibility on a false return: continue normal flow — the appropriate
 * skip-metric has already been emitted by this helper.
 *
 * Runs in the SAME transaction as the caller (the cooldown check + outbox write + markAttempted commit
 * atomically with the caller's other webhook/reconcile writes).
 */
export async function maybeEnqueueRepair(
  db: Executor,
  args: {
    githubInstallationId: number;
    triggerSource: TriggerSource;
    deliveryId: string | null;
  },
): Promise<boolean> {
  const decision: RepairStateDecision = await getStateForEnqueueDecision(db, {
    githubInstallationId: args.githubInstallationId,
  });

  if (decision.isBlocked) {
    // Blocked supersedes cooldown — manual-intervention candidate.
    recordRepositoryBootstrapRepairBlockedSkip({
      blockedReason: decision.blockedReason ?? "unknown",
    });
    return false;
  }

  if (decision.cooldownActive) {
    recordRepositoryBootstrapRepairCooldownSkip({ triggerSource: args.triggerSource });
    return false;
  }

  // allowEnqueue path: build envelope, write outbox, mark attempted.
  const envelope = buildRepairEnvelope({
    githubInstallationId: args.githubInstallationId,
    triggerSource: args.triggerSource,
  });
  const outboxRepo = new PostgresOutboxRepo();
  await outboxRepo.appendReconcile({
    db,
    payload: envelope,
    schemaVersion: RECONCILE_PAYLOAD_SCHEMA_VERSION,
    deliveryId: args.deliveryId,
  });
  await markAttempted(db, { githubInstallationId: args.githubInstallationId });
  recordRepositoryBootstrapRepair({ triggerSource: args.triggerSource });
  return true;
}

/**
 * Construct the typed Temporal dispatch envelope (1:1 with the Python `_build_repair_envelope`).
 *
 * `workflow_id` is deterministic per-installation (`repair-installation-repositories/{github_iid}`) so
 * concurrent drift detections coalesce to one in-flight repair via Temporal's
 * id_conflict_policy=USE_EXISTING.
 *
 * Returns the fully-defaulted envelope object (the zod `.parse()` applies every default — the analogue of
 * the Python `TemporalWorkflowStartPayloadV1(...).model_dump(mode="json")` that the outbox row carries as
 * its JSONB payload). The inner `args[0]` is the parsed RepairInstallationRepositoriesPayloadV1 (defaults
 * applied → schema_version stamped), mirroring `payload.model_dump(mode="json")`.
 */
function buildRepairEnvelope(args: {
  githubInstallationId: number;
  triggerSource: TriggerSource;
}): TemporalWorkflowStartPayloadV1 {
  const payload = RepairInstallationRepositoriesPayloadV1.parse({
    github_installation_id: args.githubInstallationId,
    trigger_source: args.triggerSource,
  });
  return TemporalWorkflowStartPayloadV1.parse({
    workflow_type: REPAIR_INSTALLATION_REPOSITORIES_WORKFLOW_TYPE,
    workflow_id: `repair-installation-repositories/${args.githubInstallationId}`,
    task_queue: REPAIR_INSTALLATION_REPOSITORIES_TASK_QUEUE,
    args: [payload],
    id_reuse_policy: "ALLOW_DUPLICATE",
    id_conflict_policy: "USE_EXISTING",
  });
}
