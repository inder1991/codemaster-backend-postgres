// PUSH-event outbox emitters — `_maybe_emit_sync_code_owners` + `_maybe_emit_refresh_semantic_docs`.
//
// Both emit on a `push` to the repository's DEFAULT BRANCH (ref === refs/heads/<default_branch>),
// UNCONDITIONALLY on the webhook side — the FF gate lives INSIDE the workflow/activity, not the emit,
// so operators flip the flag without re-deploying ingest. Gated by the caller on `signature_valid` +
// skipped on `deduped`. Each appends a `temporal_workflow_start` outbox row.

import { type Kysely } from "kysely";

import {
  OUTBOX_PAYLOAD_SCHEMA_VERSION,
  PostgresOutboxRepo,
} from "#backend/domain/repos/outbox_repo.js";
import { resolveInternalRepositoryId } from "#backend/ingest/_webhook_resolvers.js";
import { resolveReviewTaskQueue } from "#backend/worker/temporal_config.js";

// ─── constants ───────────────────────────────────────────────────────────────────────────────────────

/** Temporal type the SyncCodeOwners dispatch carries. The TS worker registers workflows under their
 *  camelCase exported function name (`syncCodeOwners`); a PascalCase payload would dead-letter
 *  ("workflow type not registered"). See the R1 review-workflow-type rename in
 *  github_webhook_persistence.ts. */
const SYNC_CODE_OWNERS_WORKFLOW_TYPE = "syncCodeOwners";
const SYNC_CODE_OWNERS_TASK_QUEUE = resolveReviewTaskQueue();
const SYNC_CODE_OWNERS_PAYLOAD_SCHEMA_VERSION = 1;

/** Temporal type the RefreshSemanticDocs dispatch carries. RENAME vs Python `RefreshSemanticDocsWorkflow`
 *  for the same registered-name reason. NOTE the QUEUE re-target: the Python emits onto `refresh-default`
 *  (served by a dedicated helm/codemaster-worker-refresh deployment); the TS port reuses the combined
 *  review worker on `review-default` (project-owner directive: no separate worker pools), matching the
 *  reconcile/sync emitters in github_webhook_persistence.ts. */
const REFRESH_SEMANTIC_DOCS_WORKFLOW_TYPE = "refreshSemanticDocs";
const REFRESH_SEMANTIC_DOCS_TASK_QUEUE = resolveReviewTaskQueue();
const REFRESH_SEMANTIC_DOCS_PAYLOAD_SCHEMA_VERSION = 1;

// ─── push-payload extractor ──────────────────────────────────────────────────────────────────────────

/** `(repoId, owner, repo, defaultBranch, headSha)` — non-null ONLY when the push targeted the repo's
 *  default branch. */
type PushDefaultBranchMetadata = {
  repoId: number;
  owner: string;
  repo: string;
  defaultBranch: string;
  headSha: string;
};

/**
 * Parse a GitHub `push` webhook body. Returns the metadata ONLY when the push targeted the repository's
 * DEFAULT branch. Returns null for: malformed JSON, pushes to non-default branches (feature branches),
 * pushes to tags (refs/tags/...), and payloads missing required fields. The default-branch check is the
 * gate that keeps the activities from re-syncing on every feature-branch push.
 */
export function extractPushDefaultBranchMetadata(body: Uint8Array): PushDefaultBranchMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const p = parsed as Record<string, unknown>;

  const ref = p["ref"];
  const afterSha = p["after"];
  const repo = p["repository"];
  if (typeof ref !== "string" || typeof afterSha !== "string") {
    return null;
  }
  if (typeof repo !== "object" || repo === null || Array.isArray(repo)) {
    return null;
  }
  const r = repo as Record<string, unknown>;

  const repoId = r["id"];
  const ownerObj = r["owner"];
  const repoName = r["name"];
  const defaultBranch = r["default_branch"];
  if (
    typeof repoId !== "number" ||
    !Number.isInteger(repoId) ||
    typeof ownerObj !== "object" ||
    ownerObj === null ||
    typeof repoName !== "string" ||
    typeof defaultBranch !== "string"
  ) {
    return null;
  }
  const ownerLogin = (ownerObj as Record<string, unknown>)["login"];
  if (typeof ownerLogin !== "string") {
    return null;
  }

  // Only emit on pushes to the default branch. `ref` arrives as `refs/heads/<branch>`; compare the bare
  // branch suffix (a non-matching prefix — e.g. refs/tags/... — leaves the full ref, which won't equal the
  // bare default_branch, so it correctly returns null).
  const bareRef = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  if (bareRef !== defaultBranch) {
    return null;
  }

  return { repoId, owner: ownerLogin, repo: repoName, defaultBranch, headSha: afterSha };
}

// ─── sync_code_owners emit (1:1 with `_maybe_emit_sync_code_owners`) ─────────────────────────────────

/**
 * Enqueue a `temporal_workflow_start` outbox row for the SyncCodeOwners workflow when: event is `push`,
 * the push targeted the default branch, it was NOT a redelivery (deduped=false), AND both installation_id
 * (UUID + int) and repository_id resolve. Resolution failures (push for a not-yet-recorded repo) skip
 * silently — the reconcile workflow catches up; the next default-branch push triggers the sync. Workflow
 * id is deterministic (one in-flight sync per (installation, repo, head_sha)) so concurrent re-deliveries
 * coalesce.
 */
export async function maybeEmitSyncCodeOwners(args: {
  tx: Kysely<unknown>;
  eventType: string;
  body: Uint8Array;
  githubIid: number | null;
  internalIid: string | null;
  deliveryId: string;
  deduped: boolean;
}): Promise<void> {
  if (args.eventType !== "push" || args.deduped) {
    return;
  }

  const meta = extractPushDefaultBranchMetadata(args.body);
  if (meta === null) {
    return;
  }
  if (args.internalIid === null) {
    // Installation not yet recorded; skip silently — the next default-branch push after reconcile catches up.
    return;
  }
  const internalRepoId = await resolveInternalRepositoryId(args.tx, meta.repoId, args.internalIid);
  if (internalRepoId === null) {
    // Repo not enabled in our config; CODEOWNERS sync would have no consumer. Skip.
    return;
  }
  // github_iid is required for the activity (mints the installation token). Defensive — always present on
  // push events since GitHub embeds installation.id.
  if (args.githubIid === null) {
    return;
  }

  const payload = {
    workflow_type: SYNC_CODE_OWNERS_WORKFLOW_TYPE,
    // Deterministic: one in-flight sync per (installation, repo, head_sha). Concurrent re-deliveries with
    // the same SHA coalesce via id_conflict_policy=USE_EXISTING; successive pushes with new SHAs spawn new
    // workflows.
    workflow_id: `sync-code-owners/${args.internalIid}/${internalRepoId}/${meta.headSha}`,
    task_queue: SYNC_CODE_OWNERS_TASK_QUEUE,
    args: [
      {
        schema_version: SYNC_CODE_OWNERS_PAYLOAD_SCHEMA_VERSION,
        installation_id_uuid: args.internalIid,
        installation_id_int: args.githubIid,
        repository_id: internalRepoId,
        owner: meta.owner,
        repo: meta.repo,
        default_branch: meta.defaultBranch,
      },
    ],
    id_reuse_policy: "ALLOW_DUPLICATE",
    id_conflict_policy: "USE_EXISTING",
  };

  await new PostgresOutboxRepo().appendNonReviewDispatch({
    db: args.tx,
    workflowType: SYNC_CODE_OWNERS_WORKFLOW_TYPE,
    payload,
    schemaVersion: OUTBOX_PAYLOAD_SCHEMA_VERSION,
    installationId: args.internalIid,
    deliveryId: args.deliveryId,
  });
}

// ─── refresh_semantic_docs emit (1:1 with `_maybe_emit_refresh_semantic_docs`) ───────────────────────

/**
 * Enqueue a `temporal_workflow_start` outbox row for the RefreshSemanticDocs workflow on every
 * default-branch push. Sibling to {@link maybeEmitSyncCodeOwners} — same trigger conditions, independent
 * payload + workflow type, and does NOT need github_iid. Emits unconditionally; the
 * `refresh_semantic_docs_workflow_enabled` FF gate short-circuits INSIDE the workflow body when disabled.
 * Workflow id is deterministic per (installation, repo) — R-27: dropping the head_sha suffix avoids
 * concurrent refresh workflows deadlocking on core.knowledge_chunks; head_sha flows through args instead.
 */
export async function maybeEmitRefreshSemanticDocs(args: {
  tx: Kysely<unknown>;
  eventType: string;
  body: Uint8Array;
  internalIid: string | null;
  deliveryId: string;
  deduped: boolean;
}): Promise<void> {
  if (args.eventType !== "push" || args.deduped) {
    return;
  }

  const meta = extractPushDefaultBranchMetadata(args.body);
  if (meta === null) {
    return;
  }
  if (args.internalIid === null) {
    return;
  }
  const internalRepoId = await resolveInternalRepositoryId(args.tx, meta.repoId, args.internalIid);
  if (internalRepoId === null) {
    return;
  }

  const payload = {
    workflow_type: REFRESH_SEMANTIC_DOCS_WORKFLOW_TYPE,
    workflow_id: `refresh-semantic-docs/${args.internalIid}/${internalRepoId}`,
    task_queue: REFRESH_SEMANTIC_DOCS_TASK_QUEUE,
    args: [
      {
        schema_version: REFRESH_SEMANTIC_DOCS_PAYLOAD_SCHEMA_VERSION,
        installation_id: args.internalIid,
        repository_id: internalRepoId,
        triggered_by: "default_branch_push",
        head_sha: meta.headSha,
      },
    ],
    id_reuse_policy: "ALLOW_DUPLICATE",
    id_conflict_policy: "USE_EXISTING",
  };

  await new PostgresOutboxRepo().appendNonReviewDispatch({
    db: args.tx,
    workflowType: REFRESH_SEMANTIC_DOCS_WORKFLOW_TYPE,
    payload,
    schemaVersion: OUTBOX_PAYLOAD_SCHEMA_VERSION,
    installationId: args.internalIid,
    deliveryId: args.deliveryId,
  });
}
