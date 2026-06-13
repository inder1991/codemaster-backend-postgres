/**
 * `reconcileRepositories` activity — registered Temporal activity name `reconcile_repositories_activity`.
 *
 * Idempotent upsert of `core.repositories` rows from a GitHub `installation_repositories` event.
 * Replay-safe (same payload twice → same end state).
 *
 * Default-deny / auto-enable rule (CLAUDE.md invariant 10):
 *  - `repositories_added`: upsert via the shared {@link upsertRepository} helper with
 *    `enabledOnInsert = true` — admin opted in wholesale at App install ([[single_company_not_saas]]),
 *    so admin-added repos auto-enable. The UPDATE path NEVER touches `enabled` (admin's later
 *    kill-switch is preserved — the helper omits `enabled` from its DO UPDATE SET clause).
 *  - `repositories_removed`: SOFT-disable (`archived = true`, `enabled = false`) — NOT a DELETE
 *    (preserves audit + FK), via {@link removeRepository}.
 *
 * ## Out-of-order webhooks (load-bearing)
 *
 * `installation_repositories` can arrive BEFORE `installation.created`. When the parent installations
 * row is not yet present, the activity THROWS (a plain Error, NOT a validation/ValueError) so the
 * workflow's RetryPolicy (which marks only ValueError non-retryable) redrives until the parent exists.
 * The plain Error (not ValueError) keeps it retryable under Temporal's RetryPolicy.
 *
 * ## DSN + transaction + deferred audit
 *
 * Reads `CODEMASTER_PG_CORE_DSN`; runs all mutations in ONE transaction over the ADR-0062 shared pool.
 * Counter semantics: `added` increments UNCONDITIONALLY per repo in `repositories_added` (even an
 * UPDATE-refresh of an existing row); `removed` increments ONLY for repos that were previously recorded
 * (a remove of an unrecorded repo is a no-op and does NOT count). The `repository.added` /
 * `repository.removed` audit.audit_events emits are DEFERRED (see // FOLLOW-UP).
 */

import { resolveInternalInstallationId } from "#backend/ingest/_webhook_resolvers.js";
import {
  removeRepository,
  upsertRepository,
} from "#backend/ingest/_reconcile_persistence.js";

import { tenantKysely } from "#platform/db/database.js";
import { WallClock } from "#platform/clock.js";

import { GitHubInstallationRepositoriesPayloadV1 } from "#contracts/github_installation_payload.v1.js";
import { ReconcileRepositoriesResultV1 } from "#contracts/reconcile_results.v1.js";

/**
 * The registered `reconcile_repositories_activity` Temporal activity.
 */
export async function reconcileRepositories(
  payloadDict: unknown,
): Promise<ReconcileRepositoriesResultV1> {
  const payload = GitHubInstallationRepositoriesPayloadV1.parse(payloadDict);

  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set; cannot run reconcile_repositories_activity",
    );
  }

  const clock = new WallClock();
  const db = tenantKysely<unknown>(dsn);

  let added = 0;
  let removed = 0;

  await db.transaction().execute(async (tx) => {
    const iid = await resolveInternalInstallationId(tx, payload.installation.id);
    if (iid === null) {
      // `installation_repositories` arrived before `installation.created`. The workflow retries; plain
      // Error keeps this retryable under Temporal's RetryPolicy.
      throw new Error(
        `installation_id=${payload.installation.id} not yet recorded; retry`,
      );
    }

    // FOLLOW-UP (DEFERRED): bind_audit_context(tx, installationId=iid) here before the per-repo emits.

    for (const repo of payload.repositories_added) {
      // `before`/`after` feed the deferred audit emit.
      await upsertRepository(tx, {
        installationId: iid,
        githubRepoId: repo.id,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
        archived: repo.archived,
        enabledOnInsert: true,
        clock,
      });
      added += 1;
      // FOLLOW-UP (DEFERRED): emitAuditEvent({ actorKind: sender.type !== "Bot" ? "user" : "bot",
      // actorId: null, action: "repository.added", targetKind: "repository", targetId: String(repo.id),
      // before: before || null, after, clock }). Emits UNCONDITIONALLY (even on refresh).
    }

    for (const repo of payload.repositories_removed) {
      const { id } = await removeRepository(tx, { githubRepoId: repo.id, clock });
      if (id === null) {
        continue; // repo never recorded — no audit, removed NOT incremented.
      }
      removed += 1;
      // FOLLOW-UP (DEFERRED): emitAuditEvent({ actorKind: sender.type !== "Bot" ? "user" : "bot",
      // actorId: null, action: "repository.removed", targetKind: "repository", targetId:
      // String(repo.id), before, after, clock }).
    }
  });

  return ReconcileRepositoriesResultV1.parse({ added, removed });
}
