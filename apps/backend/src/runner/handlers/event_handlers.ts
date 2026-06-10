import {
  type CacheGitCloner,
  cloneRepositoryActivity,
} from "#backend/activities/clone_repository.activity.js";
import type { ConfluenceChunkClient } from "#backend/activities/confluence_sync.activity.js";
import {
  type GitHubListReposPort,
  doHydrateInstallationRepositories,
  hydrateDbPortFromKysely,
  repairStatePortFromModule,
} from "#backend/activities/hydrate_installation_repositories.activity.js";
import { reconcileInstallation } from "#backend/activities/reconcile_installation.activity.js";
import { reconcileRepositories } from "#backend/activities/reconcile_repositories.activity.js";
import { RefreshSemanticDocsActivity } from "#backend/activities/refresh_semantic_docs.activity.js";
import {
  type CodeOwnersFilePort,
  type IsEnabled,
  SyncCodeOwnersActivity,
} from "#backend/activities/sync_code_owners.activity.js";
import type { EmbeddingsPort } from "#backend/adapters/embeddings_port.js";
import { PostgresCodeOwnersRepo } from "#backend/domain/repos/code_owners_repo.js";
import { PostgresKnowledgeChunkRepo } from "#backend/domain/repos/knowledge_chunks_repo.js";
import type { GitHubApiClient, TokenProvider } from "#backend/integrations/github/api_client.js";
import type { GitHubAppTokenProvider } from "#backend/integrations/github/token_provider.js";

import { WallClock } from "#platform/clock.js";
import { tenantKysely } from "#platform/db/database.js";

import {
  GitHubInstallationPayloadV1,
  GitHubInstallationRepositoriesPayloadV1,
} from "#contracts/github_installation_payload.v1.js";
import { RefreshSemanticDocsInputV1 } from "#contracts/refresh_semantic_docs.v1.js";
import { RepairInstallationRepositoriesPayloadV1 } from "#contracts/repair_installation_repositories.v1.js";
import { SyncCodeOwnersPayloadV1 } from "#contracts/sync_code_owners_payload.v1.js";
import { TriggerPageResyncInputV1 } from "#contracts/trigger_page_resync.v1.js";

import type { HandlerRegistry } from "../handler_registry.js";
import {
  buildConfluenceSyncActivities,
  makeLazyConfluenceChunkClient,
  makeLazyConfluenceEmbeddings,
  syncOneConfluencePage,
} from "./_confluence_page_sync.js";

// Phase 3d W3d.1 + W3d.2 + Phase 3e.3: job_type → handler ADAPTERS for the 6 EVENT-DRIVEN workflows
// migrated off Temporal — the 3 auto-registration thin proxies (reconcile.workflow.ts:
// reconcileInstallation / reconcileRepositories / repairInstallationRepositories, each a pure
// pass-through over ONE activity), the 2 knowledge producers (sync_code_owners.workflow.ts: a
// single-activity pass-through; refresh_semantic_docs.workflow.ts: the 2-step clone → refresh
// sequence reproduced in-process), plus the Phase 3e.3 trigger_page_resync single-page Confluence
// resync (trigger_page_resync.workflow.ts: the 4-step per-page chain via _confluence_page_sync.ts —
// the LAST non-review workflow). Each adapter parses the verified job payload with its OWN input contract
// and dispatches the EXISTING, tested activity body — the activity logic is NOT rewritten; the
// Temporal workflows stay in place until Phase 4 deletes them. The producers (webhook emitters +
// the repair dispatcher) keep stamping outbox rows with the Temporal workflow_type strings; the
// NEXT wave's outbox temporal_workflow_start cutover translates those through
// ../workflow_job_map.ts into these job_types.
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
// `installation.created` — and the hydrate 5xx GitHubApiUnavailableError). The platform matches
// that split since Phase 4a W4a.1: the runner classifies a propagating ZodError (or a
// handler-thrown PermanentJobError, see ../errors.js) as PERMANENT → terminalSettle dead-letters
// IMMEDIATELY with the error as dead_reason (no retry burn — the same stored bytes re-parse
// identically on every attempt). Everything else keeps the bounded retry curve: markFailed
// re-enqueues 'ready' with exponential backoff and dead-letters at max_attempts.
//
// ## Result handling
// The handlers return void — the platform persists job OUTCOME, not the activity result contracts
// (ReconcileInstallationResultV1 / ReconcileRepositoriesResultV1 / RepairResultV1, equally consumed
// by nobody but observability on the Temporal side). Each dispatch's tally is logged.
//
// ## Cancellation (`signal`) posture
// The 3 reconcile/repair activities are single-batch idempotent upserts (INSERT … ON CONFLICT DO
// UPDATE) with no internal await seam worth aborting between — the adapters deliberately do not
// thread `signal`, matching the cron adapters' posture. A lease-lost duplicate dispatch
// re-upserting is harmless. The 2 knowledge producers carry NO AbortSignal seam either
// (CacheGitCloner.clone enforces its OWN subprocess timeout — DEFAULT_TIMEOUT_SECONDS=300 — and
// the refresh body is bounded by the runner's hard runtime ceiling); both are idempotent by
// construction (the clone wipes a stale target before re-cloning; the refresh upsert is
// content-addressed UUIDv5 + natural-key ON CONFLICT), so a lease-lost duplicate re-run converges.
//
// ## W3d.2 retry semantics vs the Temporal per-step curves
// The Temporal sync_code_owners proxy retried 5× (non-retryable GitHubAppUnauthorized /
// GitHubNotFoundError); the refresh proxy retried clone 3× (same non-retryables) and refresh 3×
// (non-retryable WrongVectorDimensionError). The platform has ONE retry curve (module doc above):
// these PLAIN-Error faults burn their bounded attempts and dead-letter with the error persisted —
// a W4a.1 follow-up may wrap them in PermanentJobError to short-circuit like the ZodError path
// (the runner already classifies; only the throw sites need the wrap). Embed-service degradation is
// NOT a throw: the refresh activity returns `retrieval_degraded=true` and the job settles done
// with the degradation logged (1:1 with the Temporal workflow surfacing the result verbatim).
//
// ## W3d.2 workspace lifecycle (1:1 with the Temporal workflow body)
// Neither the Temporal refresh workflow nor this adapter tears the clone-cache dir down after the
// refresh: performClone WIPES a stale `<cacheRoot>/<iid>/<rid>` target at the NEXT clone for the
// same repo, and the Wave-2 workspace retention sweeps own leftover reaping.

/**
 * Composition-root collaborators the event adapters close over (the buildActivities idiom).
 */
export type EventHandlersDeps = {
  /** OPTIONAL DSN override for the handlers' DB ports (integration tests inject the disposable
   *  :5434 DSN explicitly). Omitted in prod — resolves `CODEMASTER_PG_CORE_DSN`, exactly as the
   *  registered Temporal activities do. (The two reconcile activities have NO dsn seam — they
   *  self-resolve the env DSN internally, 1:1 with their Temporal dispatch.) */
  readonly dsn?: string;
  /** OPTIONAL GitHub list-repos port for the repair handler (integration tests inject a fake).
   *  Omitted in prod — the handler builds the deferred-Vault lazy client on first use, the same
   *  client wiring the registered `hydrate_installation_repositories_activity` constructs. */
  readonly hydrateGithub?: GitHubListReposPort;
  /** OPTIONAL CODEOWNERS file port for the sync_code_owners handler (integration tests inject a
   *  stub). Omitted in prod — the handler builds the deferred-Vault lazy 3-path getContents port
   *  ({@link makeLazyCodeOwnersFilePort}), 1:1 with build_activities' `makeCodeOwnersFilePort`. */
  readonly codeOwnersGithub?: CodeOwnersFilePort;
  /** OPTIONAL `code_owners_v1` flag check for the sync_code_owners handler. Omitted in prod —
   *  DEFAULT-OFF (`async () => false`), byte-1:1 with the Temporal composition root's wiring
   *  (build_activities.ts; the `core.flags` reader is unported —
   *  FOLLOW-UP-code-owners-v1-flag-reader). The webhook emit is UNCONDITIONAL; this is the gate. */
  readonly codeOwnersIsEnabled?: IsEnabled;
  /** OPTIONAL embeddings port for the refresh_semantic_docs handler (integration tests inject the
   *  deterministic RecordingEmbeddingsClient). Omitted in prod — the handler resolves the SAME
   *  env-selected platform embedder the Temporal worker constructs (resolveEmbeddingsConsumer,
   *  ADR-0059), deferred to first dispatch + memoized so a runner without embedder env vars still
   *  BOOTS (fail-loud surfaces on the first refresh job, persisted in last_error). */
  readonly refreshEmbeddings?: EmbeddingsPort;
  /** OPTIONAL git-driver seam for the refresh handler's Step-1 clone (integration tests inject a
   *  recording stub). Omitted in prod — the activity's REAL default (defaultCacheCloner over
   *  GitSubprocessCloner), exactly as the registered `clone_repository_activity` wires. */
  readonly refreshCloner?: CacheGitCloner;
  /** OPTIONAL GitHub-App installation token provider for the Step-1 clone (integration tests
   *  inject a stub). Omitted in prod — the deferred-Vault lazy GitHubAppTokenProvider
   *  ({@link makeLazyCloneTokenProvider}), the SAME mint the Temporal composition root wires. */
  readonly refreshGetToken?: TokenProvider;
  /** OPTIONAL Confluence listPages/getPage slice for the trigger_page_resync single-page chain
   *  (integration tests inject a scripted fake). Omitted in prod — the deferred-Vault lazy
   *  ConfluenceClient (_confluence_page_sync.ts::makeLazyConfluenceChunkClient, the SAME builder
   *  the confluence_ingest cron closes over), so a runner without the Confluence Vault token still
   *  BOOTS (ADR-0075 dev posture) — the fail-loud error surfaces on the first resync job's fetch,
   *  persisted in last_error. */
  readonly confluenceClient?: ConfluenceChunkClient;
  /** OPTIONAL embeddings port for the trigger_page_resync chunk embeds (integration tests inject
   *  the deterministic RecordingEmbeddingsClient). Omitted in prod — the env-selected platform
   *  embedder resolved LAZILY on the FIRST embed call + memoized
   *  (_confluence_page_sync.ts::makeLazyConfluenceEmbeddings, ADR-0059). */
  readonly confluenceEmbeddings?: EmbeddingsPort;
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

/** The three conventional CODEOWNERS paths, tried in order (1:1 with build_activities'
 *  `CODEOWNERS_LOOKUP_PATHS` / the Python `_CODEOWNERS_LOOKUP_PATHS`). */
const CODEOWNERS_LOOKUP_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

/** The platform embed model name the refresh holder is constructed with — byte-1:1 with the
 *  Temporal composition root (build_activities.ts wires the SAME "qwen3-embed-0.6b" the confluence
 *  chunk_and_embed / embed_query path uses). */
const REFRESH_EMBED_MODEL_NAME = "qwen3-embed-0.6b";

/**
 * A {@link CodeOwnersFilePort} that builds the REAL Vault-token-backed GitHubApiClient on first
 * `fetchCodeowners` call and memoizes it (the deferred-Vault pattern — dynamic imports keep the
 * Vault/GitHub wiring off this module's static import graph), then runs the 3-path CODEOWNERS
 * lookup over `getContents` — 1:1 with build_activities' `makeCodeOwnersFilePort` (the Python
 * `_SpineCodeOwnersAdapter`). Returns the first path that exists (base64-ASCII bytes + blob SHA),
 * or null when none of the conventional paths host a CODEOWNERS file (the activity no-ops to 0).
 */
function makeLazyCodeOwnersFilePort(): CodeOwnersFilePort {
  let memo: Promise<GitHubApiClient> | undefined;
  const lazy = (): Promise<GitHubApiClient> => {
    if (memo === undefined) {
      memo = (async () => {
        const { FetchGitHubHttpClient, GitHubApiClient: RealGitHubApiClient } = await import(
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
        return new RealGitHubApiClient({
          tokenProvider: tokenProvider.getToken.bind(tokenProvider),
          http: githubHttp,
          clock,
        });
      })();
    }
    return memo;
  };
  return {
    fetchCodeowners: async (args): Promise<readonly [Uint8Array, string] | null> => {
      const contents = await lazy();
      for (const path of CODEOWNERS_LOOKUP_PATHS) {
        const result = await contents.getContents({
          installationId: args.installationId,
          // Telemetry-only param the GitHub `_request` does not consume; the port carries only the
          // numeric id, so the stringified numeric id stands in for the unused UUID telemetry slot
          // (1:1 with build_activities' makeCodeOwnersFilePort).
          installationUuid: String(args.installationId),
          owner: args.owner,
          repo: args.repo,
          path,
          ref: args.ref,
        });
        if (result !== null) {
          return result;
        }
      }
      // None of the conventional paths host a CODEOWNERS file — no-op (the activity returns 0).
      return null;
    },
  };
}

/**
 * A {@link TokenProvider} that builds the real GitHubAppTokenProvider on first call (the
 * deferred-Vault pattern) and memoizes it, then mints the installation token for the per-call
 * NUMERIC installation id — the SAME token seam the Temporal composition root wires the registered
 * `clone_repository_activity` with (build_activities' `makeLazyTokenProvider`). The internal
 * WallClock is composition wiring for token-expiry math, same as the hydrate port above.
 */
function makeLazyCloneTokenProvider(): TokenProvider {
  let memo: Promise<GitHubAppTokenProvider> | undefined;
  const lazy = (): Promise<GitHubAppTokenProvider> => {
    if (memo === undefined) {
      memo = (async () => {
        const { FetchGitHubHttpClient } = await import("#backend/integrations/github/api_client.js");
        const { GitHubAppTokenProvider } = await import(
          "#backend/integrations/github/token_provider.js"
        );
        const { VaultHttpPort } = await import("#backend/adapters/vault_http.js");
        const clock = new WallClock();
        const githubHttp = new FetchGitHubHttpClient({});
        const vault = VaultHttpPort.fromEnv();
        return GitHubAppTokenProvider.fromEnv({ vault, http: githubHttp, clock });
      })();
    }
    return memo;
  };
  return async (installationId: number): Promise<string> => (await lazy()).getToken(installationId);
}

/** Resolve the core DSN for a handler's per-dispatch DB ports: injected override or the env var the
 *  registered Temporal activities self-resolve. Fail-loud INSIDE the handler (not at registration)
 *  so registry composition stays env-free and the failure is persisted in the job's last_error. */
function requireDsn(deps: EventHandlersDeps, jobType: string): string {
  const dsn = deps.dsn ?? process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(`CODEMASTER_PG_CORE_DSN is not set; cannot run the ${jobType} handler`);
  }
  return dsn;
}

/**
 * Register the W3d.1 + W3d.2 event-driven handlers on the runner's registry. Called ONCE at the
 * composition root ({@link import("../background_runner_main.js").buildBackgroundRunner});
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
    const dsn = requireDsn(deps, "repair_installation_repositories");
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

  // ── W3d.2: the 2 knowledge-producer handlers ──

  // sync_code_owners — the Temporal syncCodeOwners workflow body is a pure single-activity
  // pass-through (sync_code_owners.workflow.ts); the adapter parses the producer payload
  // (_push_emitters.ts stamps the SyncCodeOwnersPayloadV1 keys verbatim) and dispatches the
  // EXISTING holder's syncCodeOwners. The holder is constructed PER DISPATCH — cheap object wiring;
  // the Postgres pool underneath is the memoized ADR-0062 shared pool (tenantKysely), so no
  // per-dispatch pool churn — with the composition-root CODEOWNERS port (injected stub under test;
  // deferred-Vault 3-path lookup otherwise), the flag gate (DEFAULT-OFF — module doc), and the
  // runner's Clock seam.
  const codeOwnersGithub = deps.codeOwnersGithub ?? makeLazyCodeOwnersFilePort();
  const codeOwnersIsEnabled: IsEnabled = deps.codeOwnersIsEnabled ?? (async (): Promise<boolean> => false);
  registry.register("sync_code_owners", async (payload, _signal, handlerDeps) => {
    const parsed = SyncCodeOwnersPayloadV1.parse(payload);
    const dsn = requireDsn(deps, "sync_code_owners");
    const holder = new SyncCodeOwnersActivity({
      github: codeOwnersGithub,
      repo: PostgresCodeOwnersRepo.fromDsn(dsn),
      isEnabled: codeOwnersIsEnabled,
      clock: handlerDeps.clock,
    });
    const written = await holder.syncCodeOwners(parsed);
    console.info(
      `sync_code_owners applied: rules_written=${written} repository_id=${parsed.repository_id} ` +
        `job_id=${handlerDeps.job.job_id}`,
    );
  });

  // refresh_semantic_docs — reproduces the Temporal refreshSemanticDocs workflow body's 2-step
  // sequence IN-PROCESS (refresh_semantic_docs.workflow.ts): Step 1 `clone_repository_activity`
  // produces the cloned-workspace path (single typed CloneRepositoryInputV1 built from the parsed
  // input — the invariant-11 shape the TS workflow already dispatches), THEN Step 2
  // `refreshSemanticDocs` discovers + chunks + embeds that workspace into core.knowledge_chunks.
  // customKnowledgePaths stays [] (v1 — the workflow body's literal). The production embedder is
  // resolved LAZILY on the first refresh dispatch + memoized (the same env-selected
  // resolveEmbeddingsConsumer the Temporal worker constructs; dynamic import keeps the Qwen/OpenAI
  // adapter graph off this module's static imports) so a runner without embedder env vars still
  // boots — the fail-loud env error settles the attempt failed with last_error persisted.
  const refreshGetToken = deps.refreshGetToken ?? makeLazyCloneTokenProvider();
  let refreshEmbedderMemo: EmbeddingsPort | undefined;
  const resolveRefreshEmbeddings = async (): Promise<EmbeddingsPort> => {
    if (deps.refreshEmbeddings !== undefined) {
      return deps.refreshEmbeddings;
    }
    if (refreshEmbedderMemo === undefined) {
      const { resolveEmbeddingsConsumer } = await import("#backend/adapters/resolve_embeddings.js");
      refreshEmbedderMemo = resolveEmbeddingsConsumer();
    }
    return refreshEmbedderMemo;
  };
  registry.register("refresh_semantic_docs", async (payload, _signal, handlerDeps) => {
    const parsed = RefreshSemanticDocsInputV1.parse(payload);
    const dsn = requireDsn(deps, "refresh_semantic_docs");

    // Step 1: clone the repository → workspace path (1:1 with the workflow body's Step 1; the
    // cloner/resolveRepo fall to the activity's REAL production defaults unless a test injects).
    const workspacePath = await cloneRepositoryActivity(
      {
        schema_version: 1,
        installation_id: parsed.installation_id,
        repository_id: parsed.repository_id,
        head_sha: parsed.head_sha,
      },
      {
        getToken: refreshGetToken,
        ...(deps.refreshCloner !== undefined ? { cloner: deps.refreshCloner } : {}),
      },
    );

    // Step 2: discover + chunk + embed + upsert (1:1 with the workflow body's Step 2).
    const holder = new RefreshSemanticDocsActivity({
      embeddings: await resolveRefreshEmbeddings(),
      chunkRepo: PostgresKnowledgeChunkRepo.fromDsn(dsn),
      modelName: REFRESH_EMBED_MODEL_NAME,
      clock: handlerDeps.clock,
    });
    const result = await holder.refreshSemanticDocs({
      input: parsed,
      workspacePath,
      customKnowledgePaths: [],
    });
    console.info(
      `refresh_semantic_docs applied: docs_discovered=${result.docs_discovered} ` +
        `chunks_persisted=${result.chunks_persisted} retrieval_degraded=${result.retrieval_degraded} ` +
        `degradation_reason=${result.degradation_reason ?? "none"} ` +
        `repository_id=${parsed.repository_id} job_id=${handlerDeps.job.job_id}`,
    );
  });

  // ── Phase 3e.3: trigger_page_resync — the LAST non-review event-driven workflow ──
  //
  // The admin-triggered single-page Confluence resync (trigger_page_resync.workflow.ts / the frozen
  // Python TriggerPageResyncWorkflow.run): on page-approval revocation, the DELETE-approval endpoint
  // (api/admin/confluence_pages_write.ts::revokePageApproval, via PageResyncDispatcherPort) enqueues
  // a resync so the revoked page's default-tagged chunks are flushed within minutes instead of
  // waiting for the next 6h confluence_ingest tick (spec §3.7 approval-drift bound). The handler
  // runs the SAME 4 per-page activities the ingest fan-out runs — fetch_page_body → sanitize_page →
  // chunk_and_embed → upsert_chunks — for exactly ONE (space_key, page_id), via the SHARED chain in
  // _confluence_page_sync.ts (no space listing, no reconcile — the workflow body's exact scope).
  // The upsert's approval LEFT JOIN sees the now-revoked approval and rejects the default-tagged
  // chunks (or persists them if the operator re-approved between enqueue and here).
  //
  // ## DIVERGENCE from the Temporal resync_complete contract (deliberate)
  // The TS Temporal workflow body fail-softs: it catches a transient downstream failure (after its
  // _PAGE_RETRY budget) and returns TriggerPageResyncOutputV1.resync_complete=false so "the caller
  // retries / escalates" — but no caller ever consumed that output (the dispatch is fire-and-forget
  // from the DELETE-approval endpoint). On the platform the handler THROWS instead: the runner's
  // markFailed retry/backoff redrives the attempt and dead-letters at max_attempts with last_error
  // persisted — the platform retry IS the retry the resync_complete=false contract asked the absent
  // caller to perform. A malformed payload (ZodError) dead-letters IMMEDIATELY — the runner's W4a.1
  // permanent-error classification (the module-doc retry-semantics note, same as every handler above).
  //
  // ## Result handling + cancellation
  // Returns void (the platform persists job OUTCOME, not TriggerPageResyncOutputV1 — consumed by
  // nobody but observability on the Temporal side); the upsert tally is logged. No `signal`
  // threading: the chain is a bounded 4-step sequence over idempotent activities (the upsert is
  // content-addressed ON CONFLICT), so a lease-lost duplicate re-run converges — the cron adapters'
  // posture.
  const resyncConfluenceClient = deps.confluenceClient ?? makeLazyConfluenceChunkClient();
  const resyncConfluenceEmbeddings = deps.confluenceEmbeddings ?? makeLazyConfluenceEmbeddings();
  registry.register("trigger_page_resync", async (payload, _signal, handlerDeps) => {
    const parsed = TriggerPageResyncInputV1.parse(payload);
    const dsn = requireDsn(deps, "trigger_page_resync");
    const acts = buildConfluenceSyncActivities({
      dsn,
      clock: handlerDeps.clock,
      client: resyncConfluenceClient,
      embeddings: resyncConfluenceEmbeddings,
    });
    // The deterministic cycle timestamp threaded as last_modified_at into sanitize + upsert — the
    // job-dispatch instant off the runner's Clock seam (the handler analogue of the workflow-start
    // instant the TS workflow pins via workflowInfo().startTime; `.toISOString()` yields the
    // tz-aware Z-suffixed RFC3339 string the offset:true constraint requires).
    const cycleStartedAt = handlerDeps.clock.now().toISOString();
    const upsertOut = await syncOneConfluencePage(acts, {
      spaceKey: parsed.space_key,
      pageId: parsed.page_id,
      cycleStartedAt,
    });
    console.info(
      `trigger_page_resync applied: space_key=${parsed.space_key} page_id=${parsed.page_id} ` +
        `upserted=${upsertOut.upserted} rejected_no_approval=${upsertOut.rejected_no_approval} ` +
        `rejected_default_cap=${upsertOut.rejected_default_cap} ` +
        `quarantined=${upsertOut.quarantined} ` +
        `triggered_by_user_id=${parsed.triggered_by_user_id ?? "none"} ` +
        `job_id=${handlerDeps.job.job_id}`,
    );
  });
}
