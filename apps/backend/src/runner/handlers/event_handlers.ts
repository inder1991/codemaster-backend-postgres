import {
  type GitHubListReposPort,
  doHydrateInstallationRepositories,
  hydrateDbPortFromKysely,
  repairStatePortFromModule,
} from "#backend/activities/hydrate_installation_repositories.activity.js";
import { reconcileInstallation } from "#backend/activities/reconcile_installation.activity.js";
import { reconcileRepositories } from "#backend/activities/reconcile_repositories.activity.js";

import { WallClock } from "#platform/clock.js";
import { tenantKysely } from "#platform/db/database.js";

import {
  GitHubInstallationPayloadV1,
  GitHubInstallationRepositoriesPayloadV1,
} from "#contracts/github_installation_payload.v1.js";
import { RepairInstallationRepositoriesPayloadV1 } from "#contracts/repair_installation_repositories.v1.js";

import type { HandlerRegistry } from "../handler_registry.js";

// Phase 3d W3d.1: job_type → handler ADAPTERS for the 3 reconcile/repair EVENT-DRIVEN workflows
// migrated off Temporal — the auto-registration journey's thin proxy workflows
// (reconcile.workflow.ts: reconcileInstallation / reconcileRepositories /
// repairInstallationRepositories, each a pure pass-through over ONE activity). Each adapter parses
// the verified job payload with the ACTIVITY'S OWN input contract and dispatches the EXISTING,
// tested activity body — the activity logic is NOT rewritten; the Temporal workflows stay in place
// until Phase 4 deletes them. The producers (webhook emitters + the repair dispatcher) keep stamping
// outbox rows with the Temporal workflow_type strings; the NEXT wave's outbox
// temporal_workflow_start cutover translates those through ../workflow_job_map.ts into these
// job_types.
//
// ## Input contracts (handler-owned parsing — the W2b opaque-payload posture)
// The Temporal workflows pass the bare webhook payload dict through WITHOUT validating (the activity
// re-validates at its boundary, 1:1 with the Python `model_validate`). The adapters parse the SAME
// contract at the platform boundary so a malformed payload fails the attempt with the ZodError
// surfaced in last_error — the activities still re-parse internally (defense-in-depth, byte-cheap).
//
// ## Retry semantics (the platform analogue of the Temporal RetryPolicy)
// The Temporal proxies mark ZodError non-retryable and let everything else redrive (notably the
// reconcile-repositories out-of-order plain Error — `installation_repositories` arriving BEFORE
// `installation.created` — and the hydrate 5xx GitHubApiUnavailableError). The platform has ONE
// retry curve: markFailed re-enqueues 'ready' with exponential backoff and dead-letters at
// max_attempts. A permanently-bad payload therefore burns its bounded attempts and deads with the
// ZodError persisted (bounded waste vs the Temporal short-circuit — accepted; the payload hash gate
// already dead-letters tampered rows outright). Transient faults redrive exactly as before.
//
// ## Result handling
// The handlers return void — the platform persists job OUTCOME, not the activity result contracts
// (ReconcileInstallationResultV1 / ReconcileRepositoriesResultV1 / RepairResultV1, equally consumed
// by nobody but observability on the Temporal side). Each dispatch's tally is logged.
//
// ## Cancellation (`signal`) posture
// All three activities are single-batch idempotent upserts (INSERT … ON CONFLICT DO UPDATE) with no
// internal await seam worth aborting between — the adapters deliberately do not thread `signal`,
// matching the cron adapters' posture. A lease-lost duplicate dispatch re-upserting is harmless.

/**
 * Composition-root collaborators the event adapters close over (the buildActivities idiom).
 */
export type EventHandlersDeps = {
  /** OPTIONAL DSN override for the repair handler's hydrate DB port (integration tests inject the
   *  disposable :5434 DSN explicitly). Omitted in prod — resolves `CODEMASTER_PG_CORE_DSN`, exactly
   *  as the registered Temporal activity does. (The two reconcile activities have NO dsn seam — they
   *  self-resolve the env DSN internally, 1:1 with their Temporal dispatch.) */
  readonly dsn?: string;
  /** OPTIONAL GitHub list-repos port for the repair handler (integration tests inject a fake).
   *  Omitted in prod — the handler builds the deferred-Vault lazy client on first use, the same
   *  client wiring the registered `hydrate_installation_repositories_activity` constructs. */
  readonly hydrateGithub?: GitHubListReposPort;
};

/**
 * A {@link GitHubListReposPort} that builds the REAL Vault-token-backed GitHubApiClient on first
 * `listInstallationRepositories` call and memoizes it — the deferred-Vault pattern (dynamic imports
 * keep the Vault/GitHub wiring off this module's static import graph, the hydrate-activity idiom).
 * The internal WallClock is composition wiring for token-expiry math; the hydrate body's duration
 * measurement threads the handler's injected clock, not this one.
 */
function makeLazyHydrateGithubPort(): GitHubListReposPort {
  let memo: Promise<GitHubListReposPort> | undefined;
  const lazy = (): Promise<GitHubListReposPort> => {
    if (memo === undefined) {
      memo = (async (): Promise<GitHubListReposPort> => {
        const { FetchGitHubHttpClient, GitHubApiClient } = await import(
          "#backend/integrations/github/api_client.js"
        );
        const { GitHubAppTokenProvider } = await import(
          "#backend/integrations/github/token_provider.js"
        );
        const { VaultHttpPort } = await import("#backend/adapters/vault_http.js");
        const clock = new WallClock();
        const githubHttp = new FetchGitHubHttpClient({});
        const vault = VaultHttpPort.fromEnv();
        const tokenProvider = await GitHubAppTokenProvider.fromEnv({ vault, http: githubHttp, clock });
        return new GitHubApiClient({
          tokenProvider: tokenProvider.getToken.bind(tokenProvider),
          http: githubHttp,
          clock,
        });
      })();
    }
    return memo;
  };
  return {
    listInstallationRepositories: async (args) => (await lazy()).listInstallationRepositories(args),
  };
}

/**
 * Register the W3d.1 event-driven handlers on the runner's registry. Called ONCE at the composition
 * root ({@link import("../background_runner_main.js").buildBackgroundRunner});
 * HandlerRegistry.register throws on duplicates, so double-wiring fails loud at boot.
 *
 * Each adapter: parse the verified payload with the activity's OWN contract → run the existing
 * activity body → log the dispatch tally. A parse/activity throw propagates to the runner, which
 * settles the attempt failed (markFailed: backoff re-enqueue, then dead at exhaustion) — the
 * platform's analogue of the Temporal retry curves the proxy workflows carried (module doc).
 */
export function registerEventHandlers(registry: HandlerRegistry, deps: EventHandlersDeps = {}): void {
  registry.register("reconcile_installation", async (payload, _signal, handlerDeps) => {
    const parsed = GitHubInstallationPayloadV1.parse(payload);
    // The activity self-resolves DSN + clock internally (no seams) — 1:1 with its Temporal dispatch.
    const result = await reconcileInstallation(parsed);
    console.info(
      `reconcile_installation applied: action=${result.action} ` +
        `installation_id=${result.installation_id} job_id=${handlerDeps.job.job_id}`,
    );
  });

  registry.register("reconcile_repositories", async (payload, _signal, handlerDeps) => {
    const parsed = GitHubInstallationRepositoriesPayloadV1.parse(payload);
    // Out-of-order webhooks (parent installation not yet recorded) THROW a plain Error here, failing
    // the attempt → backoff re-enqueue — the platform redrive replacing the Temporal 10-attempt curve.
    const result = await reconcileRepositories(parsed);
    console.info(
      `reconcile_repositories applied: added=${result.added} removed=${result.removed} ` +
        `job_id=${handlerDeps.job.job_id}`,
    );
  });

  // repair_installation_repositories — the hydrate journey. The pure body is dispatched with the
  // SAME production adapters the registered Temporal activity wires (per-call-transaction Kysely
  // port over the ADR-0062 shared pool + the real repair-state module port), the runner's Clock
  // seam, and the composition-root GitHub port (injected fake under test; deferred-Vault otherwise).
  const hydrateGithub = deps.hydrateGithub ?? makeLazyHydrateGithubPort();
  registry.register("repair_installation_repositories", async (payload, _signal, handlerDeps) => {
    const parsed = RepairInstallationRepositoriesPayloadV1.parse(payload);
    const dsn = deps.dsn ?? process.env.CODEMASTER_PG_CORE_DSN;
    if (dsn === undefined || dsn === "") {
      throw new Error(
        "CODEMASTER_PG_CORE_DSN is not set; cannot run the repair_installation_repositories handler",
      );
    }
    const result = await doHydrateInstallationRepositories(parsed, {
      github: hydrateGithub,
      db: hydrateDbPortFromKysely(tenantKysely<unknown>(dsn)),
      repairState: repairStatePortFromModule(),
      clock: handlerDeps.clock,
    });
    console.info(
      `repair_installation_repositories applied: blocked=${result.blocked} ` +
        `blocked_reason=${result.blocked_reason ?? "none"} newly_created=${result.newly_created} ` +
        `refreshed=${result.refreshed} job_id=${handlerDeps.job.job_id}`,
    );
  });
}
