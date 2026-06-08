/**
 * `syncCodeOwners` WORKFLOW — a thin event-driven Temporal workflow body that drives one CODEOWNERS sync.
 *
 * FAITHFUL 1:1 PORT of the frozen Python `SyncCodeOwnersWorkflow.run`
 * (vendor/codemaster-py/codemaster/workflows/sync_code_owners.py).
 *
 * EVENT-DRIVEN, NOT scheduled: the workflow is STARTED by the outbox dispatcher from a `temporal_workflow_start`
 * row the webhook receiver enqueues when a `push` event lands on the repository's default branch (the
 * INTEGRATOR wires that webhook-emit + the workflow registration). The body is a PURE PASS-THROUGH: it proxies
 * its single activity by the REGISTERED Temporal activity name (`sync_code_owners_activity`), applies the EXACT
 * retry curve transcribed from the Python `RetryPolicy(...)`, and returns the activity result verbatim (the
 * count of rules written). Same input → same activity call → replay-deterministic by construction (the
 * activity's UUIDv5 derivation + `INSERT … ON CONFLICT DO NOTHING` upsert are idempotent).
 *
 * Idempotency (per the Python module docstring): `deriveCodeOwnerId` is a UUIDv5 of `(repository_id,
 * path_pattern, source_file_sha)`; `core.code_owners.uq_code_owners_repo_pattern_sha` UNIQUE blocks duplicate
 * writes for the same SHA; `INSERT … ON CONFLICT DO NOTHING` collapses replays to a no-op.
 *
 * Failure modes (per ADR-0026 § 2 fail-open):
 *  - GitHub-API unavailable → ApplicationError; the retry policy below surfaces; the workflow eventually
 *    retries or moves to dead-letter.
 *  - CODEOWNERS file missing → activity returns 0 cleanly (some repos genuinely don't have a CODEOWNERS file).
 *  - Flag `code_owners_v1` disabled → activity short-circuits to 0 without any side effects.
 *
 * ── COMBINED-POD WORKER + REGISTERED-NAME DECISION ──
 * Consistent with the reconcile/repair port (reconcile.workflow.ts): the TS port REUSES the combined review
 * worker. The EXPORTED FUNCTION NAME (`syncCodeOwners`, camelCase) is the registered Temporal workflow TYPE
 * string the integrator dispatches by (NOT the Python PascalCase `SyncCodeOwnersWorkflow` class name) — the
 * same reason the review path renamed `ReviewPullRequestWorkflow` → `reviewPullRequest`. The Python pins the
 * activity to the "review-default" task queue (`SYNC_CODE_OWNERS_TASK_QUEUE`); the integrator stamps the same
 * queue on the webhook-emitted `temporal_workflow_start` row so the dispatched workflow lands on this worker.
 *
 * ── RETRY CURVE (1:1 with sync_code_owners.py:74-83) ──
 * start_to_close 30s; initial_interval 2s; maximum_attempts 5; non_retryable
 * ["GitHubAppUnauthorized", "GitHubNotFoundError"]. The two non-retryable types are PERMANENT GitHub-auth /
 * not-found faults — re-fetching re-fails identically and wastes the retry budget. EVERYTHING ELSE
 * (transient 5xx, secondary rate limits, DB blips) stays retryable so the activity redrives. The TS error
 * classes carry `.name = "GitHubAppUnauthorized"` / `"GitHubNotFoundError"` so the Temporal failure-type
 * match is byte-faithful (api_client.ts:82-138).
 *
 * ── SANDBOX SAFETY (ADR-0065 / ADR-0066) ──
 * This module is bundled into the Temporal V8-isolate workflow sandbox. It imports ONLY `@temporalio/workflow`
 * (the sandbox-safe surface) + a TYPE-ONLY contract shape (erased at emit under verbatimModuleSyntax, so NO
 * runtime edge to the crypto-importing contracts is created). It does NO clock / random / uuid / network / DB
 * work — all non-deterministic work lives behind the typed activity port.
 */

import { proxyActivities } from "@temporalio/workflow";

import type { SyncCodeOwnersPayloadV1 } from "#contracts/sync_code_owners_payload.v1.js";

/**
 * Proxy for `sync_code_owners_activity`. The METHOD KEY is the REGISTERED Temporal activity name (the key
 * under which the worker's `activities` map exposes the holder's bound `syncCodeOwners` — wired by the
 * INTEGRATOR in build_activities). A key that does not match a registered name dispatches
 * `ActivityNotRegistered`. Returns the count of rules written (a primitive `number`).
 */
const { sync_code_owners_activity } = proxyActivities<{
  sync_code_owners_activity(payload: SyncCodeOwnersPayloadV1): Promise<number>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "2 seconds",
    maximumAttempts: 5,
    nonRetryableErrorTypes: ["GitHubAppUnauthorized", "GitHubNotFoundError"],
  },
});

/**
 * `syncCodeOwners` workflow body. Single-activity pass-through; returns the count of CODEOWNERS rules written.
 *
 * 1:1 with sync_code_owners.py:46-83. The Python body reconstructs UUIDs from the bare payload dict before
 * dispatching the 6 positional args; the TS port carries the typed {@link SyncCodeOwnersPayloadV1} envelope
 * straight through to the activity (which re-validates at its boundary), so the workflow stays a pure,
 * sandbox-safe pass-through with no parsing.
 */
export async function syncCodeOwners(payload: SyncCodeOwnersPayloadV1): Promise<number> {
  return sync_code_owners_activity(payload);
}
