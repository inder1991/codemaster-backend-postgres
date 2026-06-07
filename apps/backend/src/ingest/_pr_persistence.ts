// PR-metadata persistence (S3) — the webhook-side writer trio the review pipeline depends on. A faithful
// port of the frozen Python `codemaster/ingest/_pr_persistence.py` + the `_maybe_persist_pr_v1` /
// `_safe_persist_pr_v1` orchestration in `codemaster/ingest/github_webhook_persistence.py`.
//
// WHY THIS EXISTS: `core.pr_files` (written by the workflow's enrich_pr_files activity) FK-references
// `core.pull_requests(pr_id)`, which itself FK-references `core.gh_users(gh_user_id)` (the PR author,
// NOT NULL). The Python persists this trio in the `pull_request` webhook handler — committed BEFORE the
// review workflow runs — so the parent rows always exist by the time enrich runs. The TS port had the
// tables + extractors + resolvers but no writer; without it, enrich_pr_files violates
// `fk_pr_files_pr_id_pull_requests`. This closes that gap.
//
// ORDERING (load-bearing, 1:1 with Python): gh_users (author) → pull_requests → pr_state_transitions.
// FAIL-OPEN: a persistence fault is best-effort — it must never fail the webhook 204 or block the review
// dispatch — so the orchestration runs inside a SAVEPOINT ({@link safePersistPr}) that rolls back ONLY the
// PR writes, leaving the outer webhook transaction (audit + idempotency + run allocation + outbox) intact.

import { type Kysely, sql } from "kysely";

import { derivePrId } from "#backend/ingest/_pr_id.js";
import { type PrMetadata } from "#backend/ingest/_webhook_extractors.js";
import { type Clock } from "#platform/clock.js";

/** PR lifecycle state — the `core.pull_requests.state` / `core.pr_state_transitions.*_state` vocabulary. */
export type PrState = "open" | "closed" | "merged";

/** PR webhook actions the state machine can derive a transition for (1:1 with the Python
 *  `derivable_actions` set). Any other action (labeled, assigned, …) is audit-only — no PR-row write. */
const DERIVABLE_ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
  "edited",
  "closed",
  "reopened",
]);

/**
 * Port of `derive_state_from_action` (_pr_persistence.py:89-121). Maps (action, merged, prior_state) →
 * (from_state, to_state). THROWS on an impossible transition (a `reopened` from a non-terminal state) and
 * on a non-derivable action — the caller treats a throw as "skip the write path" (the audit row is already
 * written), mirroring the Python `except ValueError: return`.
 */
export function deriveStateFromAction(args: {
  eventAction: string;
  merged: boolean;
  priorState: PrState | null;
}): { fromState: PrState | null; toState: PrState } {
  const { eventAction, merged, priorState } = args;
  switch (eventAction) {
    case "opened":
      return { fromState: null, toState: "open" };
    case "synchronize":
    case "ready_for_review":
    case "converted_to_draft":
    case "edited":
      return { fromState: priorState ?? "open", toState: "open" };
    case "closed":
      return { fromState: priorState ?? "open", toState: merged ? "merged" : "closed" };
    case "reopened":
      if (priorState === "closed" || priorState === "merged") {
        return { fromState: priorState, toState: "open" };
      }
      throw new Error(`invalid reopened transition from prior_state=${String(priorState)}`);
    default:
      throw new Error(`underivable PR action: ${eventAction}`);
  }
}

/**
 * Port of `lookup_pr_state` (_pr_persistence.py:277-315). `SELECT … FOR UPDATE` row-locks the PR (when it
 * exists) so concurrent webhook deliveries for the same PR serialize; the lock releases at the outer
 * transaction's commit. Returns null when the PR row does not yet exist (first-seen PR).
 */
export async function lookupPrState(
  tx: Kysely<unknown>,
  args: { installationId: string; repositoryId: string; prNumber: number },
): Promise<PrState | null> {
  const r = await sql<{ state: PrState }>`
    SELECT state
      FROM core.pull_requests
     WHERE installation_id = ${args.installationId}
       AND repository_id = ${args.repositoryId}
       AND pr_number = ${args.prNumber}
       FOR UPDATE
  `.execute(tx);
  return r.rows[0]?.state ?? null;
}

/**
 * Port of `upsert_gh_user` (_pr_persistence.py:124-166). Keyed on `github_user_id`; refreshes the mutable
 * profile fields, preserves `first_seen_at`. Returns the row's `gh_user_id` — the FK `pull_requests`
 * requires (`author_gh_user_id`, NOT NULL).
 */
export async function upsertGhUser(
  tx: Kysely<unknown>,
  args: {
    githubUserId: number;
    login: string;
    userType: string;
    name: string | null;
    avatarUrl: string | null;
    now: Date;
  },
): Promise<string> {
  const r = await sql<{ gh_user_id: string }>`
    INSERT INTO core.gh_users
      (gh_user_id, github_user_id, login, user_type, name, avatar_url, first_seen_at, last_seen_at)
    VALUES (gen_random_uuid(), ${args.githubUserId}, ${args.login}, ${args.userType},
            ${args.name}, ${args.avatarUrl}, ${args.now}, ${args.now})
    ON CONFLICT (github_user_id) DO UPDATE SET
      login = EXCLUDED.login,
      name = EXCLUDED.name,
      avatar_url = EXCLUDED.avatar_url,
      last_seen_at = EXCLUDED.last_seen_at
    RETURNING gh_user_id
  `.execute(tx);
  const row = r.rows[0];
  if (row === undefined) {
    throw new Error("upsertGhUser: INSERT … ON CONFLICT … RETURNING returned no row (Postgres invariant)");
  }
  return row.gh_user_id;
}

/**
 * Port of `upsert_pull_request` (_pr_persistence.py:169-274). Keyed on
 * `(installation_id, repository_id, pr_number)`. `pr_id` is the deterministic `derivePrId` value (uuid5 of
 * installation/repo/pr_number), so the supplied id always equals the stored one — no RETURNING needed.
 * `author_gh_user_id` + `created_at` + `pr_id` are immutable on conflict.
 */
export async function upsertPullRequest(
  tx: Kysely<unknown>,
  args: {
    installationId: string;
    repositoryId: string;
    prId: string;
    githubPullRequestId: number;
    prNumber: number;
    authorGhUserId: string;
    newState: PrState;
    title: string;
    body: string | null;
    baseRef: string;
    baseSha: string;
    headRef: string;
    headSha: string;
    draft: boolean;
    crossFork: boolean;
    openedAt: Date | string;
    closedAt: Date | null;
    mergedAt: Date | null;
    mergeCommitSha: string | null;
    correlationId: string | null;
    now: Date;
  },
): Promise<void> {
  await sql`
    INSERT INTO core.pull_requests
      (pr_id, installation_id, repository_id, github_pull_request_id, pr_number, author_gh_user_id,
       state, title, body, base_ref, base_sha, head_ref, head_sha, draft, cross_fork,
       opened_at, closed_at, merged_at, merge_commit_sha, correlation_id, created_at, updated_at)
    VALUES (${args.prId}, ${args.installationId}, ${args.repositoryId}, ${args.githubPullRequestId},
            ${args.prNumber}, ${args.authorGhUserId}, ${args.newState}, ${args.title}, ${args.body},
            ${args.baseRef}, ${args.baseSha}, ${args.headRef}, ${args.headSha}, ${args.draft},
            ${args.crossFork}, ${args.openedAt}, ${args.closedAt}, ${args.mergedAt},
            ${args.mergeCommitSha}, ${args.correlationId}, ${args.now}, ${args.now})
    ON CONFLICT (installation_id, repository_id, pr_number) DO UPDATE SET
      state = EXCLUDED.state,
      title = EXCLUDED.title,
      body = EXCLUDED.body,
      head_ref = EXCLUDED.head_ref,
      head_sha = EXCLUDED.head_sha,
      draft = EXCLUDED.draft,
      cross_fork = EXCLUDED.cross_fork,
      closed_at = EXCLUDED.closed_at,
      merged_at = EXCLUDED.merged_at,
      merge_commit_sha = EXCLUDED.merge_commit_sha,
      correlation_id = COALESCE(EXCLUDED.correlation_id, core.pull_requests.correlation_id),
      updated_at = EXCLUDED.updated_at
  `.execute(tx);
}

/**
 * Port of `emit_pr_state_transition` (_pr_persistence.py:318-360). `ON CONFLICT (delivery_id) … DO NOTHING`
 * (partial unique on non-NULL delivery_id) dedups webhook re-deliveries.
 */
export async function emitPrStateTransition(
  tx: Kysely<unknown>,
  args: {
    prId: string;
    installationId: string;
    fromState: PrState | null;
    toState: PrState;
    eventAction: string;
    headSha: string;
    deliveryId: string | null;
    now: Date;
  },
): Promise<void> {
  await sql`
    INSERT INTO core.pr_state_transitions
      (pr_state_transition_id, pr_id, installation_id, from_state, to_state, event_action,
       head_sha, delivery_id, created_at)
    VALUES (gen_random_uuid(), ${args.prId}, ${args.installationId}, ${args.fromState}, ${args.toState},
            ${args.eventAction}, ${args.headSha}, ${args.deliveryId}, ${args.now})
    ON CONFLICT (delivery_id) WHERE delivery_id IS NOT NULL DO NOTHING
  `.execute(tx);
}

/**
 * Port of `_maybe_persist_pr_v1` (github_webhook_persistence.py:1086-1244). Persists the PR-metadata trio
 * (gh_users → pull_requests → pr_state_transitions) for derivable PR actions. Early-exits (NO writes) when
 * author identity or `github_pull_request_id` is missing, the action is non-derivable, or the state
 * transition is impossible — exactly the Python guards. Uses ONE clock read so the three rows share an
 * instant.
 */
export async function maybePersistPr(
  tx: Kysely<unknown>,
  args: {
    prMeta: PrMetadata;
    internalIid: string;
    internalRepoId: string;
    deliveryId: string | null;
    clock: Clock;
  },
): Promise<void> {
  const { prMeta, internalIid, internalRepoId, deliveryId, clock } = args;

  // Guard 1 — author identity (a deleted GH account leaves these null; we cannot satisfy the gh_users FK).
  if (prMeta.authorGithubUserId === null || prMeta.authorLogin === null || prMeta.authorUserType === null) {
    return;
  }
  // Guard 2 — a real GitHub PR id (we cannot fabricate one without colliding on uq_pull_requests_github_id).
  if (prMeta.githubPullRequestId === null || prMeta.githubPullRequestId <= 0) {
    return;
  }
  // Guard 3 — derivable action only (labeled/assigned/… are audit-only).
  if (!DERIVABLE_ACTIONS.has(prMeta.action)) {
    return;
  }

  const priorState = await lookupPrState(tx, {
    installationId: internalIid,
    repositoryId: internalRepoId,
    prNumber: prMeta.prNumber,
  });

  let transition: { fromState: PrState | null; toState: PrState };
  try {
    transition = deriveStateFromAction({
      eventAction: prMeta.action,
      merged: prMeta.merged,
      priorState,
    });
  } catch {
    return; // impossible transition (e.g. reopened-from-open) — skip the write path.
  }
  const { fromState, toState } = transition;

  const now = clock.now();

  const authorGhUserId = await upsertGhUser(tx, {
    githubUserId: prMeta.authorGithubUserId,
    login: prMeta.authorLogin,
    userType: prMeta.authorUserType,
    name: prMeta.authorName,
    avatarUrl: prMeta.authorAvatarUrl,
    now,
  });

  const prId = derivePrId({
    installationId: internalIid,
    repositoryId: internalRepoId,
    prNumber: prMeta.prNumber,
  });

  await upsertPullRequest(tx, {
    installationId: internalIid,
    repositoryId: internalRepoId,
    prId,
    githubPullRequestId: prMeta.githubPullRequestId,
    prNumber: prMeta.prNumber,
    authorGhUserId,
    newState: toState,
    title: prMeta.prTitle,
    body: prMeta.prDescription.length > 0 ? prMeta.prDescription : null,
    baseRef: prMeta.baseRef.length > 0 ? prMeta.baseRef : "main",
    baseSha: prMeta.baseSha.length > 0 ? prMeta.baseSha : prMeta.headSha,
    headRef: prMeta.headRef.length > 0 ? prMeta.headRef : "main",
    headSha: prMeta.headSha,
    draft: prMeta.draft,
    crossFork: prMeta.isCrossFork,
    openedAt: prMeta.openedAt ?? now,
    closedAt: toState === "closed" || toState === "merged" ? now : null,
    mergedAt: toState === "merged" ? now : null,
    mergeCommitSha: null,
    correlationId: null,
    now,
  });

  await emitPrStateTransition(tx, {
    prId,
    installationId: internalIid,
    fromState,
    toState,
    eventAction: prMeta.action,
    headSha: prMeta.headSha,
    deliveryId,
    now,
  });
}

/**
 * Port of `_safe_persist_pr_v1` (github_webhook_persistence.py:1016-1062). Runs {@link maybePersistPr}
 * inside a SAVEPOINT so a PR-persistence fault (FK / unique / lock) rolls back ONLY the PR writes — the
 * outer webhook transaction (audit + idempotency + run allocation + outbox) still commits. Fail-open by
 * design: the PR metadata is best-effort and must never fail the 204 or block the review dispatch. Without
 * the SAVEPOINT, any Postgres error would poison the outer transaction (it would enter an aborted state and
 * every subsequent write — including the outbox append — would fail with a 500 back to GitHub).
 */
export async function safePersistPr(
  tx: Kysely<unknown>,
  args: {
    prMeta: PrMetadata;
    internalIid: string;
    internalRepoId: string;
    deliveryId: string | null;
    clock: Clock;
  },
): Promise<void> {
  await sql`SAVEPOINT sp_persist_pr`.execute(tx);
  try {
    await maybePersistPr(tx, args);
    await sql`RELEASE SAVEPOINT sp_persist_pr`.execute(tx);
  } catch (err) {
    await sql`ROLLBACK TO SAVEPOINT sp_persist_pr`.execute(tx);
    await sql`RELEASE SAVEPOINT sp_persist_pr`.execute(tx);
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      JSON.stringify({
        event: "webhook.pr_persistence_failed",
        delivery_id: args.deliveryId,
        error_class: err instanceof Error ? err.constructor.name : "unknown",
        error_msg: message.slice(0, 2048),
      }),
    );
  }
}
