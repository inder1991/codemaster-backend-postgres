/**
 * `hydrateInstallationRepositories` activity — registered Temporal activity name
 * `hydrate_installation_repositories_activity` (F-4 / bootstrap-state-coverage plan v5).
 *
 * Fetches canonical `core.repositories` state from the GitHub API (`GET /installation/repositories`)
 * and upserts each row via the shared {@link upsertRepository} helper with `enabledOnInsert = true`
 * (auto-enable).
 *
 * ## Terminal-failure classification (v5 5.3 poison-installation fix)
 *
 *  - `GitHubNotFoundError` (404 → installation deleted on GitHub) → mark blocked `installation_not_found`;
 *    return `{ blocked: true, blocked_reason: "installation_not_found" }` — does NOT re-throw.
 *  - `GitHubForbiddenError` (403) | `GitHubAppUnauthorized` (401 twice) → mark blocked `app_unauthorized`;
 *    return `{ blocked: true, blocked_reason: "app_unauthorized" }` — does NOT re-throw.
 *  - `GitHubApiUnavailableError` (5xx after retries) + ANYTHING ELSE → NOT caught → re-thrown, so
 *    Temporal's workflow-level RetryPolicy retries with exp-backoff.
 *
 * ## Two-transaction terminal-failure persistence (load-bearing — PR2 I-1 fix)
 *
 * `_persistTerminalFailure` splits `markBlocked` and the (deferred) audit emit into TWO independent
 * transactions: (1) `markBlocked` MUST commit on its own; (2) the audit emit is best-effort and its
 * failure is logged WARN and SWALLOWED (never re-thrown). Collapsing them would let an audit-emit
 * failure roll back `markBlocked`, re-throw, Temporal retries, same 404 → infinite poison loop. The
 * split is preserved here. (The audit emit itself is DEFERRED in this port — see // FOLLOW-UP — so the
 * second transaction currently does nothing; the split structure is kept for when the audit lands.)
 *
 * ## Runtime context + injection seam
 *
 * Activities run in the NORMAL Node runtime. The registered wrapper
 * {@link hydrateInstallationRepositories} resolves `CODEMASTER_PG_CORE_DSN` + constructs the production
 * {@link GitHubApiClient} (Vault deferred-token provider over the shared GitHub HTTP transport — the
 * SAME wiring as enrich_pr_files / post_review_results) and the repair-state adapter, then delegates to
 * the pure {@link doHydrateInstallationRepositories} with the GitHub / DB / repair-state / clock seams
 * INJECTED so the integration tests drive it against the disposable Postgres + a fake GitHub client.
 *
 * ## Deferred / integrator work
 *
 *  - audit.audit_events emit (`repository.added` per new row; `repository.repair_blocked` on terminal
 *    failure) is DEFERRED — the TS audit-emit port uses an AuditQueryClient pg-client seam, not this
 *    Kysely tx. See the // FOLLOW-UP markers.
 *  - The repair-state helpers (`markBlocked` / `clearOnSuccess`) live in `ingest/_repair_state.ts`
 *    (sibling-owned, already landed). This file consumes them through the {@link RepairStatePort} seam;
 *    the production adapter {@link repairStatePortFromModule} bridges their (executor, args) signature.
 */

import { type Kysely } from "kysely";

import { resolveInternalInstallationId } from "#backend/ingest/_webhook_resolvers.js";
import { upsertRepository } from "#backend/ingest/_reconcile_persistence.js";
import {
  type RepairBlockedReason,
  clearOnSuccess as repairClearOnSuccess,
  markBlocked as repairMarkBlocked,
} from "#backend/ingest/_repair_state.js";
import {
  type InstallationRepositoryV1,
  GitHubApiClient,
  GitHubForbiddenError,
  GitHubNotFoundError,
} from "#backend/integrations/github/api_client.js";
import { GitHubAppUnauthorized } from "#backend/integrations/github/installation_token.js";

import { type Clock, WallClock } from "#platform/clock.js";
import { tenantKysely } from "#platform/db/database.js";

import { RepairInstallationRepositoriesPayloadV1, RepairResultV1 } from "#contracts/repair_installation_repositories.v1.js";

// ─── Injection seams (so the pure body is testable against the disposable PG + a fake GitHub client) ──

/** The slice of {@link GitHubApiClient} the hydrate body consumes. */
export type GitHubListReposPort = {
  listInstallationRepositories(args: {
    installationId: number;
  }): Promise<Array<InstallationRepositoryV1>>;
};

/**
 * The repair-state mutation seam (the slice of `ingest/_repair_state.ts` this activity consumes). The
 * real implementation lives in `ingest/_repair_state.ts` (owned by the sibling agent); the production
 * wrapper adapts its `markBlocked` / `clearOnSuccess` exports, and the integration tests inject a fake.
 */
export type RepairStatePort = {
  markBlocked(args: {
    tx: Kysely<unknown>;
    githubInstallationId: number;
    blockedReason: RepairBlockedReason;
  }): Promise<void>;
  clearOnSuccess(args: { tx: Kysely<unknown>; githubInstallationId: number }): Promise<void>;
};

/** The DB seam — opens a fresh transaction per call (the two-tx terminal-failure split needs this). */
export type HydrateDbPort = {
  transaction<R>(fn: (tx: Kysely<unknown>) => Promise<R>): Promise<R>;
};

export type HydrateDeps = {
  github: GitHubListReposPort;
  db: HydrateDbPort;
  repairState: RepairStatePort;
  clock: Clock;
};

const LOG_PREFIX = "codemaster.activities.hydrate_installation_repositories";

/**
 * Pure hydrate body (seams injected).
 */
export async function doHydrateInstallationRepositories(
  payload: RepairInstallationRepositoriesPayloadV1,
  deps: HydrateDeps,
): Promise<RepairResultV1> {
  const githubIid = payload.github_installation_id;
  const triggerSource = payload.trigger_source;
  const { github, db, repairState, clock } = deps;

  const start = clock.monotonic();
  let newlyCreated = 0;
  let refreshed = 0;

  let repos: Array<InstallationRepositoryV1>;
  try {
    repos = await github.listInstallationRepositories({ installationId: githubIid });
  } catch (err) {
    if (err instanceof GitHubNotFoundError) {
      // v5 5.3 terminal: installation deleted on GitHub side.
      await persistTerminalFailure({
        db,
        repairState,
        clock,
        githubInstallationId: githubIid,
        blockedReason: "installation_not_found",
      });
      return RepairResultV1.parse({ blocked: true, blocked_reason: "installation_not_found" });
    }
    if (err instanceof GitHubForbiddenError || err instanceof GitHubAppUnauthorized) {
      // v5 5.3 terminal: App uninstalled / suspended / token permanently invalid → "app_unauthorized".
      await persistTerminalFailure({
        db,
        repairState,
        clock,
        githubInstallationId: githubIid,
        blockedReason: "app_unauthorized",
      });
      return RepairResultV1.parse({ blocked: true, blocked_reason: "app_unauthorized" });
    }
    // GitHubApiUnavailableError + any other unhandled error → re-throw so Temporal's workflow-level
    // RetryPolicy retries with exp-backoff.
    throw err;
  }

  // Success path — single transaction.
  await db.transaction(async (tx) => {
    const iid = await resolveInternalInstallationId(tx, githubIid);
    if (iid !== null) {
      // FOLLOW-UP (DEFERRED): bind_audit_context(tx, installationId=iid) before the per-repo emits.
      for (const ghRepo of repos) {
        const { before } = await upsertRepository(tx, {
          installationId: iid,
          githubRepoId: ghRepo.id,
          fullName: ghRepo.full_name,
          defaultBranch: ghRepo.default_branch,
          archived: ghRepo.archived,
          enabledOnInsert: true,
          clock,
        });
        if (Object.keys(before).length === 0) {
          newlyCreated += 1;
          // FOLLOW-UP (DEFERRED): emitAuditEvent({ actorKind: "system", actorId: null, action:
          // "repository.added", targetKind: "repository", targetId: String(ghRepo.id), before: null,
          // after: { github_repo_id: ghRepo.id, full_name: ghRepo.full_name, default_branch:
          // ghRepo.default_branch, archived: ghRepo.archived, enabled: true }, clock }).
        } else {
          refreshed += 1;
        }
      }
    }
    // Runs even when iid is null (clears the cooldown row so the next drift re-enqueues cleanly).
    await repairState.clearOnSuccess({ tx, githubInstallationId: githubIid });
  });

  const durationMs = Math.trunc((clock.monotonic() - start) * 1000);
  // Structured INFO log — github_installation_id is HIGH-cardinality (log field, NEVER a metric label).
  console.info(
    JSON.stringify({
      event: "repair_completed",
      logger: LOG_PREFIX,
      github_installation_id: githubIid,
      newly_created_count: newlyCreated,
      refreshed_count: refreshed,
      total_seen: newlyCreated + refreshed,
      duration_ms: durationMs,
      trigger_source: triggerSource,
    }),
  );

  return RepairResultV1.parse({ newly_created: newlyCreated, refreshed: refreshed });
}

/**
 * PR2 I-1 fix — two-transaction terminal-failure persistence.
 *
 *  1. `markBlocked` commits in its OWN transaction (load-bearing for the poison-installation guarantee).
 *  2. The (deferred) audit emit runs in a SECOND transaction whose failure is logged WARN and SWALLOWED.
 *
 * The two transactions are kept SEPARATE even though the audit-emit half is currently deferred to a
 * no-op — so when the audit emit lands it drops into the second tx without re-introducing the
 * rollback-undoes-markBlocked poison loop.
 */
async function persistTerminalFailure(args: {
  db: HydrateDbPort;
  repairState: RepairStatePort;
  clock: Clock;
  githubInstallationId: number;
  blockedReason: RepairBlockedReason;
}): Promise<void> {
  const { db, repairState, githubInstallationId, blockedReason } = args;

  // Step 1 — persist the block in its own transaction.
  await db.transaction(async (tx) => {
    await repairState.markBlocked({ tx, githubInstallationId, blockedReason });
  });

  // Step 2 — best-effort audit emit in a SECOND transaction; failure is logged WARN, never re-thrown.
  try {
    await db.transaction(async (tx) => {
      // FOLLOW-UP (DEFERRED): _emit_repair_blocked_audit — re-resolve iid via
      // resolveInternalInstallationId(tx, githubInstallationId); if null, skip; else
      // bind_audit_context(tx, installationId=iid) + emitAuditEvent({ actorKind: "system", actorId:
      // null, action: "repository.repair_blocked", targetKind: "installation", targetId: iid, before:
      // null, after: { blocked_reason: blockedReason }, clock }). Currently a no-op (audit deferred).
      void tx;
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      JSON.stringify({
        event: "repair_blocked_audit_emit_failed",
        github_installation_id: githubInstallationId,
        blocked_reason: blockedReason,
        error_class: e instanceof Error ? e.constructor.name : "unknown",
        error_msg: message.slice(0, 2048),
        note:
          "markBlocked DID persist — installation will be suppressed by the producer's pre-enqueue " +
          "gate. The missing audit event is operationally tolerable; blocked_skips_total{blocked_reason}" +
          " remains the primary alert signal.",
      }),
    );
  }
}

// ─── Adapters (DB + repair-state) ──────────────────────────────────────────────────────────────

/** Adapt a Kysely instance into the per-call-transaction {@link HydrateDbPort}. */
export function hydrateDbPortFromKysely(db: Kysely<unknown>): HydrateDbPort {
  return {
    transaction: async <R>(fn: (tx: Kysely<unknown>) => Promise<R>): Promise<R> =>
      db.transaction().execute(fn),
  };
}

/**
 * The production repair-state adapter — bridges the sibling-owned `ingest/_repair_state.ts` exports
 * (`markBlocked` / `clearOnSuccess`, which take a positional Kysely executor + an args object) into the
 * {@link RepairStatePort} seam this activity consumes. The transaction `tx` is the executor the raw SQL
 * joins, so both writes commit with the caller's transaction.
 */
export function repairStatePortFromModule(): RepairStatePort {
  return {
    markBlocked: async ({ tx, githubInstallationId, blockedReason }) =>
      repairMarkBlocked(tx, { githubInstallationId, blockedReason }),
    clearOnSuccess: async ({ tx, githubInstallationId }) =>
      repairClearOnSuccess(tx, { githubInstallationId }),
  };
}

/**
 * The registered `hydrate_installation_repositories_activity` Temporal activity. Resolves the DSN +
 * constructs the production GitHub client + repair-state adapter, then delegates to the pure body.
 * Re-validates input at the boundary.
 */
export async function hydrateInstallationRepositories(
  payloadDict: unknown,
): Promise<RepairResultV1> {
  const payload = RepairInstallationRepositoriesPayloadV1.parse(payloadDict);

  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set; cannot run hydrate_installation_repositories_activity",
    );
  }

  const clock = new WallClock();
  const db = tenantKysely<unknown>(dsn);

  // Production GitHub client wiring (same pattern as enrich_pr_files.activity.ts / post_review_results)
  // — constructed lazily inside the activity so the workflow-sandbox registration never drags it in.
  // Dynamic import keeps the static import graph light and matches the seam-injected body.
  const { FetchGitHubHttpClient } = await import("#backend/integrations/github/api_client.js");
  const { GitHubAppTokenProvider } = await import("#backend/integrations/github/token_provider.js");
  const { VaultHttpPort } = await import("#backend/adapters/vault_http.js");

  const githubHttp = new FetchGitHubHttpClient({});
  const vault = VaultHttpPort.fromEnv();
  const tokenProvider = await GitHubAppTokenProvider.fromEnv({ vault, http: githubHttp, clock });
  const api = new GitHubApiClient({
    tokenProvider: tokenProvider.getToken.bind(tokenProvider),
    http: githubHttp,
    clock,
  });

  return doHydrateInstallationRepositories(payload, {
    github: api,
    db: hydrateDbPortFromKysely(db),
    repairState: repairStatePortFromModule(),
    clock,
  });
}
