// GitHub webhook PERSISTENCE — the producer that turns an authenticated webhook into durable state +
// (for review-triggering pull_request actions) one temporal_workflow_start outbox row the
// OutboxDispatcherWorkflow drains. 1:1 in intent with codemaster/ingest/github_webhook_persistence.py;
// Stage 1 = the core review-dispatch spine. PR-metadata persistence (Stage 3), the pr.closed forensic
// audit (Stage 3), the repair-drift dispatcher (Stage 2), and the reconcile/sync emitters (Stage 4) are
// documented stubs below.
//
// Transaction model: the whole webhook runs in ONE Kysely transaction (db.transaction().execute) so the
// audit row + idempotency row + run allocation + outbox row commit (or roll back) atomically. The audit +
// idempotency writes are Kysely `sql` on the tx; the allocator primitives + emitWorkflowEvent +
// appendReviewDispatch all run on the same tx.

import { type Kysely, sql } from "kysely";

import {
  OUTBOX_PAYLOAD_SCHEMA_VERSION,
  RECONCILE_PAYLOAD_SCHEMA_VERSION,
  PostgresOutboxRepo,
} from "#backend/domain/repos/outbox_repo.js";
import { derivePrId } from "#backend/ingest/_pr_id.js";
import { safePersistPr } from "#backend/ingest/_pr_persistence.js";
import {
  buildInstallationPayloadFromWebhook,
  buildRepositoriesPayloadFromWebhook,
} from "#backend/ingest/_reconcile_payload_builder.js";
import { maybeEnqueueRepair } from "#backend/ingest/_repair_dispatcher.js";
import { allocateRun, type AllocationOutcome } from "#backend/ingest/_review_run_allocator.js";
import { upsertReview } from "#backend/ingest/_reviews_repository.js";
import {
  extractAction,
  extractInstallationId,
  extractPrMetadata,
  extractPrNodeId,
  extractSenderLogin,
  type PrMetadata,
} from "#backend/ingest/_webhook_extractors.js";
import {
  resolveInternalInstallationId,
  resolveInternalRepositoryId,
} from "#backend/ingest/_webhook_resolvers.js";
import { recordReconcilePayloadMissingRequiredFields } from "#backend/observability/reconcile_metrics.js";

import { type Clock } from "#platform/clock.js";
import { uuid4 } from "#platform/randomness.js";

// ─── constants (1:1 with the Python module, except the R1 workflow-type rename) ──────────────────────

/**
 * The review workflow TYPE the dispatched outbox row carries. DELIBERATE RENAME vs the Python
 * `_REVIEW_WORKFLOW_TYPE = "ReviewPullRequestWorkflow"`: Temporal starts a workflow by its REGISTERED type
 * name, which in the TS worker is the exported function name `reviewPullRequest`. A payload carrying the
 * Python string would dead-letter ("workflow type not registered"). See the staged-plan R1 resolution.
 */
const REVIEW_WORKFLOW_TYPE = "reviewPullRequest";
const REVIEW_TASK_QUEUE = "review-default";

/**
 * Reconcile workflow TYPE strings + task queue (the auto-registration emitters). DELIBERATE RENAME +
 * RE-TARGET vs the frozen Python (`ReconcileInstallationWorkflow` / `ReconcileRepositoriesWorkflow` on the
 * "ingest" queue): the combined-pod review worker registers these workflows under their camelCase exported
 * function names (`reconcileInstallation` / `reconcileRepositories`) and polls REVIEW_TASK_QUEUE, so the
 * dispatched outbox row MUST carry those type strings + that queue (Temporal starts a workflow by its
 * REGISTERED type name on the queue a worker polls). Project-owner directive: reuse the review worker, no
 * separate "ingest" worker.
 */
const RECONCILE_INSTALLATION_WORKFLOW_TYPE = "reconcileInstallation";
const RECONCILE_REPOSITORIES_WORKFLOW_TYPE = "reconcileRepositories";

/** Installation-event actions that trigger reconcile (1:1 with `_RECONCILE_INSTALLATION_ACTIONS`). */
const RECONCILE_INSTALLATION_ACTIONS: ReadonlySet<string> = new Set([
  "created",
  "deleted",
  "suspend",
  "unsuspend",
]);
/** installation_repositories actions that trigger reconcile (1:1 with `_RECONCILE_INSTALLATION_REPOSITORIES_ACTIONS`). */
const RECONCILE_INSTALLATION_REPOSITORIES_ACTIONS: ReadonlySet<string> = new Set(["added", "removed"]);
/** Fix D1 — explicit 1800s execution+run timeout (overrides the 900s payload default) so hung reviews
 *  terminate before the reaper threshold. */
const REVIEW_TIMEOUT_SECONDS = 1800;

/** PR actions that trigger a review enqueue (1:1 with `_OUTBOX_TRIGGER_ACTIONS`). */
const OUTBOX_TRIGGER_ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

/** PR action → review-run trigger_type (1:1 with `_ACTION_TO_TRIGGER_TYPE`). */
const ACTION_TO_TRIGGER_TYPE: Readonly<Record<string, string>> = {
  opened: "pr_opened",
  reopened: "pr_opened",
  synchronize: "pr_synchronize",
  ready_for_review: "pr_synchronize",
};

/** In-process result of {@link persistWebhook} (1:1 with `WebhookPersistResultV1`). NOT a wire contract. */
export type WebhookPersistResultV1 = {
  schemaVersion: number;
  deduped: boolean;
  webhookEventId: string;
  installationId: string | null;
  deliveryId: string;
};

// ─── the v2 review payload + the outer temporal-start payload ─────────────────────────────────────────

/** Build the inner ReviewPullRequestPayloadV1 (v2) the review workflow consumes. */
function buildReviewPayload(args: {
  prMeta: PrMetadata;
  internalIid: string;
  internalRepoId: string;
  prId: string;
  outcome: AllocationOutcome;
  reviewId: string;
  githubIid: number | null;
  deliveryId: string;
}): Record<string, unknown> {
  const { prMeta } = args;
  return {
    schema_version: 2,
    installation_id: args.internalIid,
    repository_id: args.internalRepoId,
    pr_id: args.prId,
    pr_number: prMeta.prNumber,
    head_sha: prMeta.headSha,
    gh_owner: prMeta.ghOwner,
    gh_repo_name: prMeta.ghRepoName,
    pr_title: prMeta.prTitle,
    pr_description: prMeta.prDescription,
    delivery_id: args.deliveryId,
    policy_revision: 0, // ADR-0060 A: model selection moved to purpose→model; field retained at 0.
    run_id: args.outcome.newRunId,
    review_id: args.reviewId,
    github_installation_id: args.githubIid, // numeric GitHub-API id (NOT the internal UUID)
    author_login: prMeta.authorLogin,
    draft: prMeta.draft,
    base_ref: prMeta.baseRef ? prMeta.baseRef.slice(0, 255) : null,
    head_ref: prMeta.headRef ? prMeta.headRef.slice(0, 255) : null,
    opened_at: prMeta.openedAt, // already an ISO-8601 string | null
  };
}

/** Build the outer TemporalWorkflowStartPayloadV1 (the outbox row's payload). */
function buildOuterPayload(args: {
  internalIid: string;
  internalRepoId: string;
  prMeta: PrMetadata;
  reviewPayload: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    workflow_type: REVIEW_WORKFLOW_TYPE,
    workflow_id: `review/${args.internalIid}/${args.internalRepoId}/${args.prMeta.prNumber}`,
    task_queue: REVIEW_TASK_QUEUE,
    args: [args.reviewPayload],
    id_reuse_policy: "ALLOW_DUPLICATE",
    id_conflict_policy: "USE_EXISTING",
    execution_timeout_seconds: REVIEW_TIMEOUT_SECONDS,
    run_timeout_seconds: REVIEW_TIMEOUT_SECONDS,
  };
}

// ─── the SERIAL+SUPERSEDE allocator wrapper for the PR-webhook path ───────────────────────────────────

/** Compose upsertReview → allocateRun → backfill audit.webhook_events.run_id (1:1 with
 *  `_allocate_run_for_pr_webhook`). Returns the allocation outcome + the (stable) review_id. */
async function allocateRunForPrWebhook(
  tx: Kysely<unknown>,
  args: {
    body: Uint8Array;
    prMeta: PrMetadata;
    deliveryId: string;
    webhookEventId: string;
    internalIid: string;
    clock: Clock;
  },
): Promise<{ outcome: AllocationOutcome; reviewId: string }> {
  const nodeId = extractPrNodeId(args.body);
  // provider_pr_id is NOT NULL: prefer node_id; else synthesize a stable fallback.
  const providerPrId =
    nodeId ??
    (args.prMeta.githubPullRequestId !== null
      ? `gh-pr-${args.prMeta.githubPullRequestId}`
      : `gh-pr-${args.prMeta.githubRepoId}-${args.prMeta.prNumber}`);
  const triggeredBy = extractSenderLogin(args.body);
  const triggerType = ACTION_TO_TRIGGER_TYPE[args.prMeta.action]!;

  const reviewId = await upsertReview(tx, {
    provider: "github",
    repoId: args.prMeta.githubRepoId,
    prNumber: args.prMeta.prNumber,
    providerPrId,
    prNodeId: nodeId,
    branch: args.prMeta.headRef || null,
  });

  const outcome = await allocateRun(tx, {
    reviewId,
    installationId: args.internalIid,
    triggerType,
    triggeredBy,
    provider: "github",
    deliveryId: args.deliveryId,
    clock: args.clock,
    parentRunId: null,
  });

  // Backfill the audit row's run_id now that it's allocated.
  await sql`UPDATE audit.webhook_events SET run_id = ${outcome.newRunId} WHERE webhook_event_id = ${args.webhookEventId}`.execute(
    tx,
  );

  return { outcome, reviewId };
}

// ─── reconcile emitters (auto-registration) ──────────────────────────────────────────────────────────

/**
 * Emit an `installation_reconcile` outbox row targeting `reconcileRepositories` for an
 * installation_repositories event (1:1 with the Python `_emit_repositories_reconcile`). Body interpretation
 * delegates to the shared builder; a structured skip_reason emits the drift counter and skips enqueue.
 */
async function emitRepositoriesReconcile(
  tx: Kysely<unknown>,
  args: { body: Uint8Array; githubIid: number; triggeringAction: string; deliveryId: string },
): Promise<void> {
  const buildResult = buildRepositoriesPayloadFromWebhook({
    rawBody: args.body,
    triggeringAction: args.triggeringAction,
  });
  if (buildResult.skipReason !== undefined) {
    recordReconcilePayloadMissingRequiredFields({
      eventType: "installation_repositories",
      missingField: buildResult.skipReason,
    });
    return;
  }

  const envelope = {
    workflow_type: RECONCILE_REPOSITORIES_WORKFLOW_TYPE,
    workflow_id: `reconcile-repositories/${args.githubIid}`,
    task_queue: REVIEW_TASK_QUEUE,
    args: [buildResult.payload],
    id_reuse_policy: "ALLOW_DUPLICATE",
    id_conflict_policy: "USE_EXISTING",
  };
  await new PostgresOutboxRepo().appendReconcile({
    db: tx,
    payload: envelope,
    schemaVersion: RECONCILE_PAYLOAD_SCHEMA_VERSION,
    deliveryId: args.deliveryId,
  });
}

/**
 * Emit an `installation_reconcile` outbox row when an installation event / PR-backfill / repositories event
 * warrants reconciliation (1:1 with the Python `_maybe_emit_installation_reconcile`). Three cases:
 *   1. Back-fill — a pull_request event for a github_installation_id with no core.installations row yet →
 *      seed the installation row (reconcileInstallation). The current PR is lost (its review dispatch was
 *      skipped because internalIid was null); the next PR webhook goes through normally.
 *   2. Forward (installation event) — created seeds; deleted/suspend/unsuspend update (reconcileInstallation).
 *   3. Forward (installation_repositories event) — added/removed (reconcileRepositories).
 *
 * Gated on signature_valid by the caller. Re-deliveries (deduped) skip — the idempotency row proves the
 * reconcile outbox was already enqueued.
 */
async function maybeEmitInstallationReconcile(args: {
  tx: Kysely<unknown>;
  eventType: string;
  body: Uint8Array;
  githubIid: number | null;
  internalIid: string | null;
  deliveryId: string;
  deduped: boolean;
}): Promise<void> {
  if (args.deduped) {
    return;
  }

  const action = extractAction(args.body);

  // Branch A — installation_repositories events route to reconcileRepositories (separate workflow + table).
  if (
    args.eventType === "installation_repositories" &&
    action !== null &&
    RECONCILE_INSTALLATION_REPOSITORIES_ACTIONS.has(action) &&
    args.githubIid !== null
  ) {
    await emitRepositoriesReconcile(args.tx, {
      body: args.body,
      githubIid: args.githubIid,
      triggeringAction: action,
      deliveryId: args.deliveryId,
    });
    return;
  }

  // Branch B — installation events + PR back-fill route to reconcileInstallation.
  let triggersReconcile = false;
  if (args.eventType === "pull_request" && args.internalIid === null && args.githubIid !== null) {
    triggersReconcile = true;
  } else if (
    args.eventType === "installation" &&
    action !== null &&
    RECONCILE_INSTALLATION_ACTIONS.has(action)
  ) {
    triggersReconcile = true;
  }
  if (!triggersReconcile) {
    return;
  }
  // github_iid is required for the reconcile workflow; defend against malformed payloads.
  if (args.githubIid === null) {
    return;
  }

  const buildResult = buildInstallationPayloadFromWebhook({
    eventType: args.eventType,
    rawBody: args.body,
    triggeringAction: action ?? "",
  });
  if (buildResult.skipReason !== undefined) {
    recordReconcilePayloadMissingRequiredFields({
      eventType: args.eventType,
      missingField: buildResult.skipReason,
    });
    return;
  }

  const envelope = {
    workflow_type: RECONCILE_INSTALLATION_WORKFLOW_TYPE,
    workflow_id: `reconcile-installation/${args.githubIid}`,
    task_queue: REVIEW_TASK_QUEUE,
    args: [buildResult.payload],
    id_reuse_policy: "ALLOW_DUPLICATE",
    id_conflict_policy: "USE_EXISTING",
  };
  await new PostgresOutboxRepo().appendReconcile({
    db: args.tx,
    payload: envelope,
    schemaVersion: RECONCILE_PAYLOAD_SCHEMA_VERSION,
    deliveryId: args.deliveryId,
  });
}

// ─── the public entry ─────────────────────────────────────────────────────────────────────────────────

/**
 * Persist a (HMAC-verified-or-not) GitHub webhook. ALWAYS writes the audit row (forensics > performance,
 * even for spoofed deliveries). On a VALID signature: dedups via cache.cache_idempotency, and for a
 * review-triggering pull_request action allocates the run (SERIAL+SUPERSEDE) and appends the review
 * dispatch outbox row. Returns the result envelope (used for logging + the route's response mapping).
 */
export async function persistWebhook(args: {
  db: Kysely<unknown>;
  body: Uint8Array;
  headers: Record<string, string>;
  signatureValid: boolean;
  clock: Clock;
}): Promise<WebhookPersistResultV1> {
  const deliveryId = args.headers["x-github-delivery"] ?? "";
  const eventType = args.headers["x-github-event"] ?? "";
  if (!deliveryId || !eventType) {
    throw new Error(
      "persistWebhook: missing x-github-delivery / x-github-event (the receiver should have refused this earlier)",
    );
  }

  return args.db.transaction().execute(async (tx) => {
    const githubIid = extractInstallationId(args.body);
    const internalIid = await resolveInternalInstallationId(tx, githubIid);
    const webhookEventId = uuid4();

    // Audit row is ALWAYS written (forensics-first; even spoofed / deduped deliveries). raw_body is the
    // plaintext bytes — the Python persist path stores plaintext here (the EncryptedBytes TypeDecorator
    // does not fire on raw text() binds); see staged-plan R5.
    await sql`
      INSERT INTO audit.webhook_events
        (webhook_event_id, installation_id, delivery_id, event_type, received_at, signature_valid, raw_body)
      VALUES (${webhookEventId}, ${internalIid}, ${deliveryId}, ${eventType}, ${args.clock.now()},
              ${args.signatureValid}, ${Buffer.from(args.body)})
    `.execute(tx);

    let deduped = false;
    if (args.signatureValid) {
      // Atomic idempotency: a returning row means we're the first writer; zero rows = a concurrent /
      // prior delivery already claimed this key (no SELECT-before-INSERT — closes the race). value = the
      // UTF-8 bytes of the webhook_event_id UUID string; 24h TTL computed in SQL (no new Date()).
      // Mirror Python's `{github_iid or 'unknown'}` truthiness: installation.id 0 (falsy in Python)
      // also falls back to "unknown" — `??` alone would keep the literal "0" and diverge.
      const iidPart = githubIid ? String(githubIid) : "unknown";
      const cacheKey = `github-webhook:${iidPart}:${deliveryId}`;
      const ins = await sql<{ cache_key: string }>`
        INSERT INTO cache.cache_idempotency (cache_key, value, expires_at, created_at)
        VALUES (${cacheKey}, ${Buffer.from(webhookEventId, "utf-8")},
                ${args.clock.now()}::timestamptz + interval '24 hours', ${args.clock.now()})
        ON CONFLICT (cache_key) DO NOTHING
        RETURNING cache_key
      `.execute(tx);
      deduped = ins.rows.length === 0;

      if (!deduped && eventType === "pull_request") {
        const prMeta = extractPrMetadata(args.body);
        if (prMeta !== null) {
          const internalRepoId = await resolveInternalRepositoryId(tx, prMeta.githubRepoId, internalIid);
          if (internalRepoId !== null && internalIid !== null) {
            // S3 (PR-metadata persistence): write the gh_users → pull_requests → pr_state_transitions trio
            // for every DERIVABLE action, BEFORE the dispatch split below, so core.pull_requests exists by
            // the time the review workflow's enrich_pr_files activity runs (it FK-references it via
            // fk_pr_files_pr_id_pull_requests). Fail-open SAVEPOINT: a persistence fault rolls back ONLY these
            // writes — it never poisons the outer webhook transaction, fails the 204, or blocks the dispatch.
            await safePersistPr(tx, {
              prMeta,
              internalIid,
              internalRepoId,
              deliveryId,
              clock: args.clock,
            });
          }
          if (internalRepoId === null || internalIid === null) {
            // Drift: known installation, unknown repo. Enqueue the RepairInstallationRepositoriesWorkflow via
            // the shared dispatcher (it hydrates core.repositories from the canonical GitHub API — ADR-0054 /
            // invariant 16 forbid mutating core.repositories inline here). The cooldown/blocked gate inside
            // maybeEnqueueRepair throttles repair-spam during outages. FAIL-OPEN: a dispatcher fault must
            // never poison the webhook tx / fail the 204 (mirrors safePersistPr), so we wrap + swallow. When
            // the INSTALLATION itself is unknown (internalIid === null) the unconditional reconcile emit
            // below seeds it (reconcileInstallation back-fill); the repair hydrates repos once it exists.
            // The PR is "lost" for review on this delivery (fail-open); the next webhook goes through.
            console.warn(
              JSON.stringify({
                event: "webhook.pr_repo_unresolved_drift",
                delivery_id: deliveryId,
                github_repo_id: prMeta.githubRepoId,
              }),
            );
            if (githubIid !== null) {
              // SAVEPOINT-wrapped fail-open (mirrors safePersistPr): a dispatcher fault rolls back ONLY the
              // repair writes (the outbox append + repair-state markAttempted) without poisoning the outer
              // webhook transaction (which would otherwise enter an aborted state and fail the 204).
              await sql`SAVEPOINT sp_pr_repair`.execute(tx);
              try {
                await maybeEnqueueRepair(tx, {
                  githubInstallationId: githubIid,
                  triggerSource: "pr_webhook",
                  deliveryId,
                });
                await sql`RELEASE SAVEPOINT sp_pr_repair`.execute(tx);
              } catch (e) {
                await sql`ROLLBACK TO SAVEPOINT sp_pr_repair`.execute(tx);
                await sql`RELEASE SAVEPOINT sp_pr_repair`.execute(tx);
                console.warn(
                  JSON.stringify({
                    event: "webhook.pr_repair_enqueue_failed",
                    delivery_id: deliveryId,
                    error: e instanceof Error ? e.message : String(e),
                  }),
                );
              }
            }
          } else if (prMeta.action === "closed") {
            // STAGE-1 STUB: the pr.closed forensic audit (emitAuditEvent on the encrypted audit_events
            // table) wires in Stage 3 — it needs the pg-client AuditQueryClient seam, deferred under the
            // Kysely-native transaction model. No enqueue for closed PRs (correct).
          } else if (OUTBOX_TRIGGER_ACTIONS.has(prMeta.action)) {
            const { outcome, reviewId } = await allocateRunForPrWebhook(tx, {
              body: args.body,
              prMeta,
              deliveryId,
              webhookEventId,
              internalIid,
              clock: args.clock,
            });
            const prId = derivePrId({
              installationId: internalIid,
              repositoryId: internalRepoId,
              prNumber: prMeta.prNumber,
            });
            const reviewPayload = buildReviewPayload({
              prMeta,
              internalIid,
              internalRepoId,
              prId,
              outcome,
              reviewId,
              githubIid,
              deliveryId,
            });
            const payload = buildOuterPayload({ internalIid, internalRepoId, prMeta, reviewPayload });
            await new PostgresOutboxRepo().appendReviewDispatch({
              db: tx,
              runId: outcome.newRunId,
              payload,
              schemaVersion: OUTBOX_PAYLOAD_SCHEMA_VERSION,
              installationId: internalIid,
              deliveryId,
              traceContext: null, // OTel trace-capture deferred (consistent with the dispatcher's §E seam)
            });
          }
          // edited / converted_to_draft: not review-triggering + not closed → no enqueue (correct).
        }
      }
      // Auto-registration emit (1:1 with the Python unconditional `_maybe_emit_installation_reconcile` call
      // after the pull_request path): installation events → reconcileInstallation; installation_repositories
      // events → reconcileRepositories; a pull_request for an unknown installation → reconcileInstallation
      // back-fill. Skips on deduped / missing github_iid internally. The sync_code_owners /
      // refresh_semantic_docs emitters remain deferred (their workflows are not ported).
      await maybeEmitInstallationReconcile({
        tx,
        eventType,
        body: args.body,
        githubIid,
        internalIid,
        deliveryId,
        deduped,
      });
    }

    return { schemaVersion: 1, deduped, webhookEventId, installationId: internalIid, deliveryId };
  });
}
