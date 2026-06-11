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
//   * `installationId` (the port's 2nd param — the sink threads SinkContext.installationId, i.e.
//     the outbox ROW's installation_id) lands as core.background_jobs.installation_id, so tenant
//     identity survives the cutover (W4b.1 review blocker #1). NULL = platform-scoped, exactly as
//     the NULL-installation_id bootstrap-sink outbox rows are.
//   * task_queue / execution+run timeouts / search_attributes / id_reuse_policy are NOT translated:
//     the runner's lease + hard-runtime ceilings replace the Temporal timeouts, queueing is the
//     single core.background_jobs table, and no producer sets search attributes (the
//     RealTemporalClient already fail-louds on that).
//
// ## The review trigger rides the REVIEW-JOBS platform, not this map (Phase 4d W4d.1 F6)
// `reviewPullRequest` (REVIEW_WORKFLOW_TYPE — imported from the producer,
// ingest/github_webhook_persistence.ts, so the stamp and the route share ONE definition) is
// SPECIAL-CASED ahead of the WORKFLOW_TYPE_TO_JOB_TYPE lookup: its args[0] is the fully-allocated
// ReviewPullRequestPayloadV1 (allocateRun runs BEFORE the outbox row, so run_id/review_id/
// installation_id are already minted), parsed here and enqueued via ReviewJobsRepo.enqueue —
// core.review_jobs is the durable workflow-argument store the REVIEW runner shell claims from
// (lease + verifyPayload + the PR-mutex protocol), a different platform than the coarse
// background_jobs handlers. The returned string is the review job_id. A payload that does not
// parse throws PermanentSinkError (the drifted-producer posture below); the tenant identity
// persisted on the job is the PAYLOAD's installation_id (identity-asserted inside enqueue against
// the run/review ids), not the port's 2nd param.
//
// ## Unmapped workflow_type = fail-loud, never a silent drop
// WORKFLOW_TYPE_TO_JOB_TYPE carries ONLY the migrated workflow types. A row stamped with an
// unmigrated, non-review type throws PermanentSinkError: the drain loop records the attempt with
// the error persisted in last_error and the row dead-letters at the threshold — visible in the
// outbox dead-letter signal, instead of vanishing. Cutting over (CODEMASTER_RUNTIME_MODE=
// postgres|shadow) before every event-driven workflow_type is mapped is an operator error this
// adapter SURFACES rather than papers over.
//
// ## cancel / signal are structurally unreachable from the outbox sinks
// makeTemporalWorkflowStartHandler only ever calls startWorkflow. The review supersede path is the
// DB-side flipCurrentRun (ingest/_review_run_allocator.ts), not a Temporal cancel; admin-console
// signals ride api/admin/_admin_temporal_port.ts — a different port wiring entirely. Both methods
// therefore throw unconditionally: a future caller routing cancel/signal through THIS port is a
// wiring bug to surface at the first call, not a capability to emulate.

import { ZodError } from "zod";

import { type StartWorkflowCall, type TemporalClientPort } from "#backend/adapters/temporal_port.js";
import { REVIEW_WORKFLOW_TYPE } from "#backend/ingest/github_webhook_persistence.js";
import { PermanentSinkError } from "#backend/outbox/sink_registry.js";
import { ReviewPullRequestPayloadV1 } from "#contracts/review_pull_request.v1.js";

import type { BackgroundJobsRepo } from "./background_jobs_repo.js";
import { PayloadIntegrityError, type ReviewJobsRepo } from "./review_jobs_repo.js";
import { JOB_TYPE_MAX_ATTEMPTS, WORKFLOW_TYPE_TO_JOB_TYPE } from "./workflow_job_map.js";

/** A {@link TemporalClientPort} whose startWorkflow enqueues a core.background_jobs row — or, for
 *  {@link REVIEW_WORKFLOW_TYPE}, a core.review_jobs row (module doc: the cutover hinge + the W4d.1
 *  review route). Construct ONE per composition root over the shared-pool repos. */
export class BackgroundJobsTemporalPort implements TemporalClientPort {
  readonly #repo: BackgroundJobsRepo;
  /** The REVIEW-JOBS platform repo the {@link REVIEW_WORKFLOW_TYPE} route enqueues through (W4d.1
   *  F6) — the review runner shell, NOT the coarse background_jobs handlers, executes these. */
  readonly #reviewJobs: ReviewJobsRepo;
  /** A Map (never the raw record): a payload-controlled workflow_type like "constructor" must miss,
   *  not resolve through Object.prototype (`record["constructor"]` is a function, not undefined). */
  readonly #jobTypeByWorkflowType: ReadonlyMap<string, string>;
  /** W1.9d (RC5): job_type → Temporal-parity max_attempts, threaded into every enqueue. A Map for
   *  the same prototype-safety reason as the translation registry. */
  readonly #maxAttemptsByJobType: ReadonlyMap<string, number>;
  /** CS1.2 SHADOW posture — see the {@link startWorkflow} top guard. */
  readonly #shadow: boolean;

  public constructor(o: {
    repo: BackgroundJobsRepo;
    /** The review-jobs repo the REVIEW route enqueues through (W4d.1 F6). */
    reviewJobs: ReviewJobsRepo;
    /** The translation registry — production passes {@link WORKFLOW_TYPE_TO_JOB_TYPE}. */
    workflowTypeToJobType: Readonly<Record<string, string>>;
    /** W1.9d (RC5): per-job_type attempt budgets. DEFAULTS to the production
     *  {@link JOB_TYPE_MAX_ATTEMPTS} table — the Temporal-parity budgets must hold wherever this
     *  port is constructed (forgetting to thread them was exactly the RC5 collapse); tests may
     *  override. A job_type absent from the table falls back to the repo's enqueue default. */
    maxAttemptsByJobType?: Readonly<Record<string, number>>;
    /** CS1.2 SHADOW posture: true → startWorkflow performs NO real enqueue (no core.background_jobs
     *  row, no core.review_jobs row) — a would-enqueue log + sentinel id instead. The seam-level
     *  enforcement of the cutover-safety plan's "no real review/background enqueue" clause, behind
     *  the OutboxDispatcherLoop's own shadow guard (defense-in-depth: this port must be inert even
     *  if something dispatches an outbox row in shadow). Default false. */
    shadow?: boolean;
  }) {
    this.#repo = o.repo;
    this.#reviewJobs = o.reviewJobs;
    this.#jobTypeByWorkflowType = new Map(Object.entries(o.workflowTypeToJobType));
    this.#maxAttemptsByJobType = new Map(Object.entries(o.maxAttemptsByJobType ?? JOB_TYPE_MAX_ATTEMPTS));
    this.#shadow = o.shadow ?? false;
  }

  public async startWorkflow(
    call: StartWorkflowCall,
    installationId?: string | null,
    deliveryId?: string | null,
  ): Promise<string> {
    if (this.#shadow) {
      // CS1.2 SHADOW guard — BEFORE the payload extraction and BOTH routes (review + event), so no
      // job row of either kind can land in shadow. The sentinel return satisfies the port contract
      // (a string "run_id") and is unambiguous in any log that records it; nothing downstream
      // consumes it in shadow (the drain loop's markDispatched is itself suppressed).
      console.info(
        `outbox port shadow-mode: would-enqueue workflow_type=${call.workflowType} ` +
          `workflow_id=${call.workflowId} — suppressed: no background/review job row ` +
          `(CS1.2 no-side-effects contract)`,
      );
      return `shadow-would-enqueue:${call.workflowId}`;
    }
    // args → payload (module doc): the producers stamp exactly ONE positional input, a plain JSON
    // object — for BOTH routes. Enforce both halves here so a drifted producer surfaces as THIS
    // clear error in the outbox row's last_error rather than a Zod throw from deep inside enqueue.
    const payload = this.#singlePositionalPayload(call);

    // The review trigger (W4d.1 F6): reviewPullRequest rides the REVIEW-JOBS platform, never the
    // workflow_type→job_type map (module doc). Checked BEFORE the map lookup so a review row can
    // never be mis-translated by a future (erroneous) map entry.
    if (call.workflowType === REVIEW_WORKFLOW_TYPE) {
      return this.#enqueueReviewJob(call, payload, deliveryId ?? null);
    }

    const jobType = this.#jobTypeByWorkflowType.get(call.workflowType);
    if (jobType === undefined) {
      throw new PermanentSinkError(
        `no background job_type is mapped for workflow_type '${call.workflowType}' ` +
          `(workflow_id '${call.workflowId}') — an unmigrated workflow_type must fail loud, not ` +
          `silently drop; map it in workflow_job_map.ts (WORKFLOW_TYPE_TO_JOB_TYPE) with a ` +
          `registered handler before cutting its producer over`,
      );
    }

    // Tenant identity survives the cutover (W4b.1 review blocker #1): the sink handler threads
    // SinkContext.installationId — i.e. the dispatching outbox ROW's installation_id — through the
    // port's 2nd param, and it lands as core.background_jobs.installation_id. null/omitted stays
    // NULL = platform-scoped by design (e.g. appendReconcile rows, whose outbox installation_id is
    // NULL under the ck_outbox_installation_id_required bootstrap-sink exemption).
    //
    // W1.9d (RC5): the job_type's Temporal-parity attempt budget rides the enqueue — max_attempts
    // on the row, NOT a claim()-side mutation. Absent from the table → the repo default (3).
    const maxAttempts = this.#maxAttemptsByJobType.get(jobType);
    try {
      return await this.#repo.enqueue({
        jobType,
        payload,
        dedupKey: call.workflowId,
        installationId: installationId ?? null,
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
      });
    } catch (e) {
      // W1.9e: enqueue's strict JSON-tree validation (W4c.1 #9) rejecting a DEEP non-JSON value
      // (nested NaN/undefined/Date — #singlePositionalPayload only guards the top-level shape) is
      // a DETERMINISTIC poison: the same bytes fail identically on every redelivery, so it must
      // dead-letter on attempt 1 (PermanentSinkError → the RC7 drain-loop taxonomy), never burn
      // the outbox retry curve. Every other enqueue error (DB faults) stays retryable.
      if (e instanceof ZodError) {
        throw new PermanentSinkError(
          `workflow_type '${call.workflowType}' (workflow_id '${call.workflowId}') args[0] is not ` +
            `a strict-JSON payload (nested non-JSON value) — deterministic poison, dead-letter: ${e.message}`,
        );
      }
      throw e;
    }
  }

  /** Extract + validate the single positional workflow input (`args: [payload]` — every producer's
   *  shape, both review and event-driven). Fail-loud BEFORE any enqueue. */
  #singlePositionalPayload(call: StartWorkflowCall): object {
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
    return payload;
  }

  /** The W4d.1 F6 review route: parse the fully-allocated ReviewPullRequestPayloadV1 the webhook
   *  producer stamped (allocateRun ran BEFORE the outbox row, so run_id/review_id/installation_id
   *  are minted) and enqueue it on core.review_jobs — the durable workflow-argument store the
   *  review runner shell claims from. ReviewJobsRepo.enqueue re-validates, identity-asserts the
   *  envelope against the payload, canonicalizes + hashes; the returned string is the review
   *  job_id. A non-parsing payload is a drifted producer → PermanentSinkError (the row's
   *  last_error names it; dead-letters at the threshold — never a silent drop).
   *
   *  `rowDeliveryId` (W1.9e): the dispatching OUTBOX ROW's delivery_id — the INDEPENDENT identity
   *  source for the enqueue envelope. The producer stamps ONE webhook delivery id on BOTH the row
   *  and the payload (github_webhook_persistence.ts), so enqueue's delivery_id cross-check
   *  (assertPayloadIdentityMatchesEnvelope) now compares two independently-carried copies instead
   *  of the payload against itself (the CS4.1 slice's tautology). A null row delivery_id falls
   *  back to the payload's (the row opted out; CS4.1 behavior — the column is still persisted). A
   *  DIVERGENT pair (drifted/poisoned producer) raises PayloadIntegrityError BEFORE any INSERT →
   *  mapped to PermanentSinkError: a deterministic identity fault dead-letters on attempt 1
   *  (the RC7 drain-loop taxonomy), never burns the outbox retry curve. */
  async #enqueueReviewJob(call: StartWorkflowCall, payload: object, rowDeliveryId: string | null): Promise<string> {
    let parsed: ReviewPullRequestPayloadV1;
    try {
      parsed = ReviewPullRequestPayloadV1.parse(payload);
    } catch (e) {
      throw new PermanentSinkError(
        `workflow_type '${call.workflowType}' (workflow_id '${call.workflowId}') args[0] does not ` +
          `parse as ReviewPullRequestPayloadV1 — the review route enqueues core.review_jobs and a ` +
          `drifted producer payload must surface here, not three layers deeper: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      return await this.#reviewJobs.enqueue({
        runId: parsed.run_id,
        reviewId: parsed.review_id,
        installationId: parsed.installation_id,
        // CS4.1 RT3 + W1.9e: persist the webhook delivery_id onto the job row (the admin/debug
        // timeline join column) AND engage enqueue's identity cross-check against the ROW's copy
        // when the dispatch threaded one (doc above).
        deliveryId: rowDeliveryId ?? parsed.delivery_id,
        payload: parsed,
      });
    } catch (e) {
      if (e instanceof PayloadIntegrityError) {
        throw new PermanentSinkError(
          `workflow_type '${call.workflowType}' (workflow_id '${call.workflowId}') payload identity ` +
            `diverges from the dispatch envelope (row delivery_id '${String(rowDeliveryId)}') — a ` +
            `deterministic identity fault, dead-letter on attempt 1: ${e.message}`,
        );
      }
      throw e;
    }
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

/**
 * Build THE production outbox port: a {@link BackgroundJobsTemporalPort} over the
 * {@link WORKFLOW_TYPE_TO_JOB_TYPE} registry (the single production translation table).
 *
 * CS1.1 REMOVED the flag-gated selection that used to live here (resolveOutboxPort over
 * CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS, with a RealTemporalClient fallback): the background
 * runtime only boots under CODEMASTER_RUNTIME_MODE=postgres|shadow — where Temporal is ABSENT by
 * construction (boot_tasks.ts mutual exclusivity) — so when the runner boots, the outbox sinks
 * ALWAYS dispatch onto the Postgres jobs platforms; there is no Temporal port to select anymore.
 * Temporal-mode outbox draining is the separate dispatcher worker (worker/outbox_dispatcher_main.ts),
 * which wires the RealTemporalClient itself and never coexists with this runtime in one boot.
 */
export function makeOutboxBackgroundJobsPort(deps: {
  /** The shared-pool repo the port enqueues through (ADR-0062: ONE Kysely per process). */
  backgroundJobs: BackgroundJobsRepo;
  /** The shared-pool review-jobs repo the port routes {@link REVIEW_WORKFLOW_TYPE} rows through
   *  (W4d.1 F6 — the review trigger rides the review runner platform). */
  reviewJobs: ReviewJobsRepo;
  /** CS1.2 SHADOW posture (see the class ctor doc). Default false. */
  shadow?: boolean;
}): BackgroundJobsTemporalPort {
  return new BackgroundJobsTemporalPort({
    repo: deps.backgroundJobs,
    reviewJobs: deps.reviewJobs,
    workflowTypeToJobType: WORKFLOW_TYPE_TO_JOB_TYPE,
    // W1.9d (RC5): explicit even though the ctor defaults to the same table — the production
    // composition NAMES its budget source.
    maxAttemptsByJobType: JOB_TYPE_MAX_ATTEMPTS,
    shadow: deps.shadow ?? false,
  });
}
