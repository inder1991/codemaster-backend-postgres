// Phase 3d.3 (de-Temporal full-removal program): the CUTOVER HINGE — a TemporalClientPort adapter
// that ENQUEUES core.background_jobs rows instead of starting Temporal workflows. The outbox sinks
// (`temporal_workflow_start` / `installation_reconcile`, both bound to makeTemporalWorkflowStartHandler)
// are PORT-SHAPED: they parse the row's TemporalWorkflowStartPayloadV1 envelope and call
// `port.startWorkflow(call)`. Swapping the port — NOT the sink handler bodies — is therefore the
// entire cutover: with this adapter registered, every event-driven outbox row (webhook reconciles,
// repo repairs, knowledge producers) lands on the Postgres background-jobs platform the runner loop
// executes, and Temporal is out of the path.
//
// ## The args → payload translation (verified against the REAL producer envelopes)
// Every producer stamps the workflow's SINGLE positional input as a 1-element `args` array —
// `args: [payload]` in github_webhook_persistence.ts (reconcileInstallation / reconcileRepositories),
// _repair_dispatcher.ts buildRepairEnvelope (repairInstallationRepositories), and _push_emitters.ts
// (syncCodeOwners / refreshSemanticDocs) — the CLAUDE.md invariant-11 single-typed-input shape. The
// translation is therefore `payload = call.args[0]`, enforced fail-loud: a 0-/multi-element args or
// a non-object element throws PermanentSinkError BEFORE any enqueue (the platform payload column is
// a plain JSON object — BackgroundJobsRepo.enqueue's PayloadObject contract — and a drifted producer
// must surface in the outbox row's last_error, not as a Zod throw three layers deeper).
//
// ## Identity + policy translation
//   * `dedupKey = call.workflowId` — the producers' deterministic workflow ids (e.g.
//     `reconcile-installation/<gid>`) become the platform dedup key. While a job holding the key is
//     ACTIVE ('ready'|'leased'), enqueue returns the EXISTING job_id (overlap=SKIP) — the platform
//     analogue of the reconcile envelopes' id_conflict_policy=USE_EXISTING / the per-key coalescing
//     the deterministic workflow-id idiom always intended. A settled (done|failed|dead) job frees
//     the key, exactly as a closed workflow frees its workflow_id under ALLOW_DUPLICATE reuse.
//   * The returned string (the port contract's "run_id") is the enqueued job_id — the platform's
//     execution identity for the dispatched work.
//   * task_queue / execution+run timeouts / search_attributes / id_reuse_policy are NOT translated:
//     the runner's lease + hard-runtime ceilings replace the Temporal timeouts, queueing is the
//     single core.background_jobs table, and no producer sets search attributes (the
//     RealTemporalClient already fail-louds on that).
//
// ## Unmapped workflow_type = fail-loud, never a silent drop
// WORKFLOW_TYPE_TO_JOB_TYPE carries ONLY the migrated workflow types. A row stamped with an
// unmigrated type (e.g. `reviewPullRequest`, which rides the review-jobs platform, not this map)
// throws PermanentSinkError: the drain loop records the attempt with the error persisted in
// last_error and the row dead-letters at the threshold — visible in the outbox dead-letter signal,
// instead of vanishing. Flipping the cutover flag before every event-driven workflow_type is mapped
// is an operator error this adapter SURFACES rather than papers over.
//
// ## cancel / signal are structurally unreachable from the outbox sinks
// makeTemporalWorkflowStartHandler only ever calls startWorkflow. The review supersede path is the
// DB-side flipCurrentRun (ingest/_review_run_allocator.ts), not a Temporal cancel; admin-console
// signals ride api/admin/_admin_temporal_port.ts — a different port wiring entirely. Both methods
// therefore throw unconditionally: a future caller routing cancel/signal through THIS port is a
// wiring bug to surface at the first call, not a capability to emulate.

import { type StartWorkflowCall, type TemporalClientPort } from "#backend/adapters/temporal_port.js";
import { PermanentSinkError } from "#backend/outbox/sink_registry.js";

import type { BackgroundJobsRepo } from "./background_jobs_repo.js";
import { WORKFLOW_TYPE_TO_JOB_TYPE } from "./workflow_job_map.js";

/** The cutover flag (read by {@link resolveOutboxPort}). Unset/false (DEFAULT): the outbox sinks
 *  keep starting Temporal workflows via the RealTemporalClient. true: they enqueue Postgres
 *  background jobs. Flipping it is the Phase-4 cutover and REQUIRES the background runner process
 *  to be BOOTED — the runner loop is the only consumer of the enqueued jobs. */
export const OUTBOX_USE_BACKGROUND_JOBS_ENV = "CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS";

/** A {@link TemporalClientPort} whose startWorkflow enqueues a core.background_jobs row (module doc:
 *  the cutover hinge). Construct ONE per composition root over the shared-pool BackgroundJobsRepo. */
export class BackgroundJobsTemporalPort implements TemporalClientPort {
  readonly #repo: BackgroundJobsRepo;
  /** A Map (never the raw record): a payload-controlled workflow_type like "constructor" must miss,
   *  not resolve through Object.prototype (`record["constructor"]` is a function, not undefined). */
  readonly #jobTypeByWorkflowType: ReadonlyMap<string, string>;

  public constructor(o: {
    repo: BackgroundJobsRepo;
    /** The translation registry — production passes {@link WORKFLOW_TYPE_TO_JOB_TYPE}. */
    workflowTypeToJobType: Readonly<Record<string, string>>;
  }) {
    this.#repo = o.repo;
    this.#jobTypeByWorkflowType = new Map(Object.entries(o.workflowTypeToJobType));
  }

  public async startWorkflow(call: StartWorkflowCall): Promise<string> {
    const jobType = this.#jobTypeByWorkflowType.get(call.workflowType);
    if (jobType === undefined) {
      throw new PermanentSinkError(
        `no background job_type is mapped for workflow_type '${call.workflowType}' ` +
          `(workflow_id '${call.workflowId}') — an unmigrated workflow_type must fail loud, not ` +
          `silently drop; map it in workflow_job_map.ts (WORKFLOW_TYPE_TO_JOB_TYPE) with a ` +
          `registered handler before cutting its producer over`,
      );
    }

    // args → payload (module doc): the producers stamp exactly ONE positional input, a plain JSON
    // object. Enforce both halves here so a drifted producer surfaces as THIS clear error in the
    // outbox row's last_error rather than a Zod throw from deep inside enqueue.
    if (call.args.length !== 1) {
      throw new PermanentSinkError(
        `workflow_type '${call.workflowType}' (workflow_id '${call.workflowId}') dispatched with ` +
          `${call.args.length} positional args; the background-jobs translation requires exactly 1 ` +
          `(the producers' single typed workflow input — args: [payload])`,
      );
    }
    const payload = call.args[0];
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new PermanentSinkError(
        `workflow_type '${call.workflowType}' (workflow_id '${call.workflowId}') args[0] is not a ` +
          `plain JSON object; the background-jobs payload column requires one`,
      );
    }

    return this.#repo.enqueue({ jobType, payload, dedupKey: call.workflowId });
  }

  // Both rejection methods omit their parameters entirely (a TS implementation may take fewer
  // params than its interface) — they throw unconditionally, so binding the args would only trip
  // no-unused-vars.
  public async cancelWorkflow(): Promise<void> {
    throw new Error(
      "cancelWorkflow is not supported via BackgroundJobsTemporalPort — the outbox sinks only " +
        "start; the review supersede path is DB flipCurrentRun, not a Temporal cancel",
    );
  }

  public async signalWorkflow(): Promise<void> {
    throw new Error(
      "signalWorkflow is not supported via BackgroundJobsTemporalPort — the outbox sinks only " +
        "start; admin-console signals ride _admin_temporal_port.ts, not this port",
    );
  }
}

/** Strict boolean parse of the cutover flag — garbage REFUSES to boot (a typo'd cutover flag
 *  silently defaulting either way is worse than a crash-loop; the resolveBackgroundRunnerConfig
 *  fail-loud posture). Accepted: "true"/"1" → on; unset/""/"false"/"0" → off (the DEFAULT). */
function readUseBackgroundJobsFlag(env: NodeJS.ProcessEnv): boolean {
  // The key is the module's own const — not an attacker-controlled object-key sink; the
  // prototype-pollution threat model does not apply (the envPositiveSeconds idiom).
  // eslint-disable-next-line security/detect-object-injection
  const raw = env[OUTBOX_USE_BACKGROUND_JOBS_ENV];
  if (raw === undefined || raw === "" || raw === "false" || raw === "0") {
    return false;
  }
  if (raw === "true" || raw === "1") {
    return true;
  }
  throw new Error(
    `${OUTBOX_USE_BACKGROUND_JOBS_ENV} must be one of true|1|false|0 (or unset); got '${raw}'`,
  );
}

/** What {@link resolveOutboxPort} selects over. `makeTemporalPort` is a THUNK so the flag-ON path
 *  never constructs (or connects) a Temporal client at all. */
export type ResolveOutboxPortDeps = {
  env: NodeJS.ProcessEnv;
  /** The shared-pool repo the flag-ON port enqueues through (ADR-0062: ONE Kysely per process). */
  backgroundJobs: BackgroundJobsRepo;
  /** Builds the flag-OFF Temporal port (production: the RealTemporalClient over a connected
   *  Client; tests: a RecordingTemporalClient). Invoked ONLY when the flag is off. */
  makeTemporalPort: () => TemporalClientPort | Promise<TemporalClientPort>;
};

/**
 * The flag-gated port selection (the Phase-3d.3 cutover seam, wired at the sink registration point
 * in background_runner_main.ts): {@link OUTBOX_USE_BACKGROUND_JOBS_ENV} unset/false (DEFAULT) →
 * the caller's Temporal port, byte-identical pre-cutover behavior; true → a
 * {@link BackgroundJobsTemporalPort} over {@link WORKFLOW_TYPE_TO_JOB_TYPE}. Flipping the flag is
 * the Phase-4 cutover and REQUIRES the background runner to be booted (else enqueued jobs pile up
 * with no consumer).
 */
export async function resolveOutboxPort(deps: ResolveOutboxPortDeps): Promise<TemporalClientPort> {
  if (readUseBackgroundJobsFlag(deps.env)) {
    return new BackgroundJobsTemporalPort({
      repo: deps.backgroundJobs,
      workflowTypeToJobType: WORKFLOW_TYPE_TO_JOB_TYPE,
    });
  }
  return await deps.makeTemporalPort();
}
