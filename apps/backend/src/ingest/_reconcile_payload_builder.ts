// Reconcile payload builder — FAITHFUL 1:1 port of
// vendor/codemaster-py/codemaster/ingest/_reconcile_payload_builder.py.
//
// Single canonical interpreter of GitHub installation / installation_repositories webhook bodies for
// reconcile dispatch. The orchestrator (github_webhook_persistence.ts::maybeEmitInstallationReconcile)
// consumes the tagged-union result:
//   - { payload }      → a typed GitHub*PayloadV1 ready to wrap in a TemporalWorkflowStartPayloadV1 envelope.
//   - { skipReason }   → orchestrator emits the reconcile-payload-missing-required-fields drift counter and
//                        skips the outbox enqueue.
//
// Two event types are supported for the installation flow:
//   - "installation"   — full payload (action + installation + sender). Action NORMALIZATION: GitHub fires
//     "suspend" / "unsuspend"; GitHubInstallationPayloadV1.action is the past-participle vocabulary
//     "suspended" / "unsuspended". Normalize producer-side so the activity reads consistent values.
//   - "pull_request"   — back-fill from a PR webhook for an unknown installation. The PR body does NOT carry
//     installation.account, so synthesize the account from repository.owner (plan Option B) and set
//     action="created" (seed the installation row; subsequent installation.created events idempotently update).
//
// And the installation_repositories flow (added / removed) for the repository-reconcile workflow.

import {
  GitHubInstallationPayloadV1,
  GitHubInstallationRepositoriesPayloadV1,
} from "#contracts/github_installation_payload.v1.js";
import {
  GitHubAccountV1,
  GitHubInstallationV1,
} from "#contracts/github_pull_request_payload.v1.js";

/**
 * Granular skip-reason vocabulary (1:1 with the Python `SkipReason` Literal). The granularity lets operators
 * monitoring the drift counter distinguish GitHub schema-drift classes (missing_sender vs malformed_json).
 */
export type SkipReason =
  | "missing_installation"
  | "missing_sender"
  | "missing_account"
  | "invalid_subobject"
  | "malformed_json";

/** Tagged-union outcome for the installation-event / PR-backfill interpreter. Exactly one field is set. */
export type ReconcileBuildResult =
  | { payload: GitHubInstallationPayloadV1; skipReason?: undefined }
  | { payload?: undefined; skipReason: SkipReason };

/** Tagged-union outcome for the installation_repositories interpreter. Exactly one field is set. */
export type ReconcileRepositoriesBuildResult =
  | { payload: GitHubInstallationRepositoriesPayloadV1; skipReason?: undefined }
  | { payload?: undefined; skipReason: SkipReason };

/** GitHub installation-event action normalization (suspend/unsuspend → past participles). */
const INSTALLATION_ACTION_NORMALIZATION: Readonly<Record<string, string>> = {
  suspend: "suspended",
  unsuspend: "unsuspended",
};

/** Parse the raw body to a plain object, or null on malformed JSON / non-object (1:1 with `_parse_body`). */
function parseBody(rawBody: Uint8Array): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** True when `v` is a plain JSON object (the Python `isinstance(x, dict)` analogue). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 1:1 with `_build_from_installation_event`. */
function buildFromInstallationEvent(
  body: Record<string, unknown>,
  triggeringAction: string,
): ReconcileBuildResult {
  const installation = body["installation"];
  const sender = body["sender"];
  if (installation === undefined || installation === null) {
    return { skipReason: "missing_installation" };
  }
  if (sender === undefined || sender === null) {
    return { skipReason: "missing_sender" };
  }
  if (!isObject(installation) || !isObject(sender)) {
    return { skipReason: "invalid_subobject" };
  }

  // Read-only lookup into a frozen 2-entry record (no prototype-chain write); the `?? triggeringAction`
  // fallback covers any non-mapped key.
  // eslint-disable-next-line security/detect-object-injection
  const normalizedAction = INSTALLATION_ACTION_NORMALIZATION[triggeringAction] ?? triggeringAction;
  const parsed = GitHubInstallationPayloadV1.safeParse({
    action: normalizedAction,
    installation,
    sender,
  });
  if (!parsed.success) {
    return { skipReason: "invalid_subobject" };
  }
  return { payload: parsed.data };
}

/**
 * 1:1 with `_build_from_pull_request_event` — Option B back-fill: synthesize the installation payload from
 * the PR body. PR webhooks carry installation.id (only) and repository.owner (full account); use the repo
 * owner as the installation-account proxy. Action synthesized to "created".
 */
function buildFromPullRequestEvent(body: Record<string, unknown>): ReconcileBuildResult {
  const installation = body["installation"];
  const repository = body["repository"];
  const sender = body["sender"];
  if (!isObject(installation)) {
    return { skipReason: "missing_installation" };
  }
  if (!isObject(sender)) {
    return { skipReason: "missing_sender" };
  }
  if (!isObject(repository)) {
    return { skipReason: "missing_account" };
  }
  const owner = repository["owner"];
  if (!isObject(owner)) {
    return { skipReason: "missing_account" };
  }

  // Synthesize the installation account from repository.owner; validate sender + owner via the account
  // contract; build the installation contract with the PR's installation.id. Any validation failure (the
  // Python `except (KeyError, ValueError)`) collapses to invalid_subobject.
  const accountProxy = GitHubAccountV1.safeParse(owner);
  const senderAccount = GitHubAccountV1.safeParse(sender);
  const installationId = installation["id"];
  if (!accountProxy.success || !senderAccount.success || installationId === undefined) {
    return { skipReason: "invalid_subobject" };
  }
  const synthesizedInstallation = GitHubInstallationV1.safeParse({
    id: installationId,
    account: accountProxy.data,
  });
  if (!synthesizedInstallation.success) {
    return { skipReason: "invalid_subobject" };
  }
  const payload = GitHubInstallationPayloadV1.safeParse({
    action: "created",
    installation: synthesizedInstallation.data,
    sender: senderAccount.data,
  });
  if (!payload.success) {
    return { skipReason: "invalid_subobject" };
  }
  return { payload: payload.data };
}

/**
 * Single canonical interpreter (1:1 with `build_installation_payload_from_webhook`) — returns either a typed
 * payload or a structured skip-reason for the orchestrator to log + counter-emit.
 */
export function buildInstallationPayloadFromWebhook(args: {
  eventType: string;
  rawBody: Uint8Array;
  triggeringAction: string;
}): ReconcileBuildResult {
  const body = parseBody(args.rawBody);
  if (body === null) {
    return { skipReason: "malformed_json" };
  }
  if (args.eventType === "installation") {
    return buildFromInstallationEvent(body, args.triggeringAction);
  }
  if (args.eventType === "pull_request") {
    return buildFromPullRequestEvent(body);
  }
  return { skipReason: "invalid_subobject" };
}

/**
 * Single canonical interpreter for installation_repositories webhook bodies (1:1 with
 * `build_repositories_payload_from_webhook`). Returns a typed GitHubInstallationRepositoriesPayloadV1 or a
 * granular skip-reason.
 */
export function buildRepositoriesPayloadFromWebhook(args: {
  rawBody: Uint8Array;
  triggeringAction: string;
}): ReconcileRepositoriesBuildResult {
  const body = parseBody(args.rawBody);
  if (body === null) {
    return { skipReason: "malformed_json" };
  }
  const installation = body["installation"];
  const sender = body["sender"];
  if (installation === undefined || installation === null) {
    return { skipReason: "missing_installation" };
  }
  if (sender === undefined || sender === null) {
    return { skipReason: "missing_sender" };
  }
  if (!isObject(installation) || !isObject(sender)) {
    return { skipReason: "invalid_subobject" };
  }

  const parsed = GitHubInstallationRepositoriesPayloadV1.safeParse({
    action: args.triggeringAction,
    installation,
    sender,
    repositories_added: body["repositories_added"] ?? [],
    repositories_removed: body["repositories_removed"] ?? [],
  });
  if (!parsed.success) {
    return { skipReason: "invalid_subobject" };
  }
  return { payload: parsed.data };
}
