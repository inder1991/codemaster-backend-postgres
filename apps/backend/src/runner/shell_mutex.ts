/**
 * Shell mutex acquire-or-reuse (D3 + F6) — the non-Temporal review-job shell's per-PR mutex seam.
 *
 * ## Why this exists (D3, finding #7)
 *
 * In the Temporal world the PR mutex was acquired ONCE in the `startReviewForWebhook` gate and held for the
 * whole workflow. In the runner world a job can crash and be RE-CLAIMED (same `run_id`, fresh attempt token).
 * A naive re-run that called `acquirePrReviewMutex` again would find its OWN still-live lease and get
 * `acquired=false` (`skipped_busy`) — a self-deadlock against its own corpse. {@link acquireOrReuseMutex}
 * fixes that: it persists the acquired `mutex_id` on the job row (migration 0037) on first acquire, and on a
 * re-run REUSES that same mutex instead of competing for it — but only after OWNERSHIP VALIDATION (F6).
 *
 * ## Ownership validation (F6 — "reuse needs ownership, not just live")
 *
 * The FK `review_jobs.mutex_id → pr_review_mutex(mutex_id)` (migration 0037) guarantees the referenced row
 * EXISTS; this code guarantees it is the RIGHT row before reusing it. A `mutex_id` is reused ONLY when the
 * referenced mutex row, read by {@link ReviewJobsRepo.readMutexRow}, satisfies ALL of:
 *   - `installation_id` MATCHES the job payload's installation,
 *   - `repository_id`   MATCHES the job payload's repository,
 *   - `pr_number`       MATCHES the job payload's PR,
 *   - `released_at IS NULL` (still live — a janitor sweep / prior release invalidates reuse),
 *   - reclaimable-by-us — confirmed by a successful {@link renewPrReviewMutexLease} (the per-PR partial-unique
 *     index means at most ONE live row per PR, so a live row that matches our PR IS ours to renew; the renew
 *     both proves reclaimability AND extends the lease).
 * Any mismatch / released / un-renewable row falls through to a FRESH {@link acquirePrReviewMutex} (which may
 * itself find a FOREIGN live lease → `busy`), and the fresh id is persisted over the stale one.
 *
 * ## Transaction shape (replicates the gate)
 *
 * The acquire branch runs the SAME critical section as `startReviewForWebhook`: a tenancy re-check
 * (`SELECT enabled FROM core.repositories` — default-deny) + `acquirePrReviewMutex` (advisory xact lock +
 * FOR UPDATE + INSERT) on ONE checked-out client in ONE transaction via {@link withMutexTransaction} over the
 * SHARED ADR-0062 pool. A disabled / missing repository raises (a reconcile race — the runner's terminal
 * paths surface it). The reuse branch needs only the PK read + the renew (each its own short txn).
 *
 * The `mutex_id` persist is a SEPARATE fenced UPDATE (after the acquire txn commits) so a stolen lease cannot
 * stamp a mutex id over the rightful owner (see {@link ReviewJobsRepo.persistMutexId}).
 */

import { type Pool } from "pg";

import {
  acquirePrReviewMutex,
  renewPrReviewMutexLease,
  withMutexTransaction,
} from "#backend/concurrency/pr_mutex.js";
import { type Clock } from "#platform/clock.js";

import { type ReviewPullRequestPayloadV1 } from "#contracts/review_pull_request.v1.js";
import { type ReviewJobV1 } from "#contracts/review_jobs.v1.js";

import { type ReviewJobsRepo } from "./review_jobs_repo.js";

/**
 * The outcome of {@link acquireOrReuseMutex}:
 *   - `acquired` — a fresh live mutex was minted for this PR (first run, or a re-acquire after a stale/foreign
 *     reuse target). `mutexId` is the new id (also persisted on the job row).
 *   - `reused`   — the job's persisted `mutex_id` passed ownership validation and was renewed; `mutexId` is it.
 *   - `busy`     — a FOREIGN live lease already holds this PR; the caller (W5.2) maps this to a terminal
 *     cancel (never spin). `mutexId` is `null`.
 */
export type AcquireOrReuseResult =
  | { status: "acquired"; mutexId: string }
  | { status: "reused"; mutexId: string }
  | { status: "busy"; mutexId: null };

/** Raised when the tenancy re-check fails the same way the gate raises (repository row missing). */
export class MutexTenancyRaceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MutexTenancyRaceError";
  }
}

/**
 * Acquire the PR mutex for this job, OR reuse the one persisted on a prior attempt after ownership validation
 * (D3/F6). See the module docstring for the full ownership contract and transaction shape.
 *
 * @param payload the verified job payload (W0.2 `verifyPayload`) — the SOURCE OF TRUTH for the PR identity
 *   (installation/repository/pr_number) the mutex must belong to. Passed (not re-derived from the row) so the
 *   ownership check compares against the same authority the rest of the shell uses.
 * @param job the claimed (`leased`) job row — carries `mutex_id` (the reuse target, null on first run) and the
 *   `lease_owner`+`attempt_token` FENCE the persist requires.
 * @param repo the runner repo (`persistMutexId` fenced write + `readMutexRow` ownership read).
 * @param pool the SHARED ADR-0062 pool for the core DSN (the acquire txn runs on a client from it).
 * @param clock the lease clock the mutex helpers carry for call-site stability (DB `now()` is authoritative).
 */
export async function acquireOrReuseMutex(args: {
  payload: ReviewPullRequestPayloadV1;
  job: ReviewJobV1;
  repo: ReviewJobsRepo;
  pool: Pool;
  clock: Clock;
}): Promise<AcquireOrReuseResult> {
  const { payload, job, repo, pool, clock } = args;

  // ── Reuse branch (D3 headline fix): a prior attempt persisted a mutex_id. Validate ownership (F6) and,
  //    if it holds, REUSE without a fresh competing acquire (which would self-skipped_busy against our corpse).
  const persisted = job.mutex_id ?? null;
  if (persisted !== null) {
    const row = await repo.readMutexRow(persisted);
    const ownershipMatches =
      row !== null &&
      row.released_at === null &&
      row.installation_id === payload.installation_id &&
      row.repository_id === payload.repository_id &&
      row.pr_number === payload.pr_number;

    if (ownershipMatches) {
      // Reclaimable-by-us: at most ONE live row per PR (partial-unique index), so a live row matching our PR
      // IS ours. The renew proves reclaimability AND extends the lease in one step. A false return means it
      // was released/reclaimed between the read and the renew (TOCTOU) → fall through to a fresh acquire.
      const renewed = await withMutexTransaction(pool, (client) =>
        renewPrReviewMutexLease({ client, installationId: payload.installation_id, mutexId: persisted }),
      );
      if (renewed) {
        return { status: "reused", mutexId: persisted };
      }
    }
    // else: mismatched / released / un-renewable → fall through to a FRESH acquire (and persist the new id).
  }

  // ── Acquire branch: replicate the gate's critical section (tenancy re-check + mutex acquire) in ONE txn.
  const acquired = await withMutexTransaction(pool, async (client) => {
    // Race-window re-check (CLAUDE.md default-deny), 1:1 with startReviewForWebhook. Tenant-filtered:
    // installation_id is in the WHERE clause.
    const enabledRes = await client.query<{ enabled: boolean }>(
      "SELECT enabled FROM core.repositories WHERE repository_id = $1 AND installation_id = $2",
      [payload.repository_id, payload.installation_id],
    );
    const enabledRow = enabledRes.rows[0];
    if (enabledRow === undefined) {
      throw new MutexTenancyRaceError(
        `repository_id=${payload.repository_id} not found for installation_id=${payload.installation_id}; reconcile race`,
      );
    }
    if (!enabledRow.enabled) {
      throw new MutexTenancyRaceError(
        `repository_id=${payload.repository_id} is disabled for installation_id=${payload.installation_id}`,
      );
    }

    // Holder format 1:1 with the gate: ReviewPR-{owner}/{repo}-{pr_number}-{head_sha[:8]}.
    const holder = `ReviewPR-${payload.gh_owner}/${payload.gh_repo_name}-${payload.pr_number}-${payload.head_sha.slice(0, 8)}`;
    return acquirePrReviewMutex({
      client,
      installationId: payload.installation_id,
      repositoryId: payload.repository_id,
      prNumber: payload.pr_number,
      holderWorkflowId: holder,
      clock,
    });
  });

  if (!acquired.acquired || acquired.mutexId === null) {
    // A FOREIGN live lease owns the PR — never spin (the caller maps busy → terminal-cancel).
    return { status: "busy", mutexId: null };
  }

  // Persist the fresh id on the job row (fenced) so a re-run reuses it. A stolen lease ⇒ applied:false; we
  // still return `acquired` (the mutex IS held) — the fence merely guards the row-write against a stale owner.
  await repo.persistMutexId({
    jobId: job.job_id,
    owner: job.lease_owner as string,
    token: job.attempt_token as string,
    mutexId: acquired.mutexId,
  });

  return { status: "acquired", mutexId: acquired.mutexId };
}
