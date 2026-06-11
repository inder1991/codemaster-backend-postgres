import { z } from "zod";

import {
  type ConfluenceChunkClient,
  type ConfluenceSyncActivities,
} from "#backend/activities/confluence_sync.activity.js";
import { jobRetentionSweepActivity } from "#backend/activities/job_retention.activity.js";
import { ListActiveConfluenceSpacesActivity } from "#backend/activities/list_active_confluence_spaces.activity.js";
import { MarkStaleChunksActivity } from "#backend/activities/mark_stale_chunks.activity.js";
import { mutexJanitorActivity } from "#backend/activities/mutex_janitor.activity.js";
import { runPgPartmanMaintenanceActivity } from "#backend/activities/partition_maintenance.activity.js";
import {
  releaseWorkspace,
  type ReleaseWorkspaceDeps,
} from "#backend/activities/release_workspace.activity.js";
import { reviewRunReaperActivity } from "#backend/activities/review_run_reaper.activity.js";
import {
  runIdCloseStalePrsActivity,
  runIdDeleteOldEventsActivity,
  runIdRetireOldRunsActivity,
} from "#backend/activities/run_id_retention.activity.js";
import {
  runWorkspaceOrphanSweepActivity,
  runWorkspaceReapActivity,
  runWorkspaceReleasedRetentionActivity,
} from "#backend/activities/workspace_retention.activity.js";

import type { EmbeddingsPort } from "#backend/adapters/embeddings_port.js";
import type { GitHubApiClient } from "#backend/integrations/github/api_client.js";

import { WallClock } from "#platform/clock.js";

import { RefreshConfluenceInputV1 } from "#contracts/confluence_sync.v1.js";
import { MarkStaleChunksInputV1 } from "#contracts/confluence_sync_stale.v1.js";

import type { DisposableRegistry } from "../disposables.js";
import type { HandlerRegistry } from "../handler_registry.js";
import {
  buildConfluenceSyncActivities,
  makeLazyConfluenceChunkClient,
  makeLazyConfluenceEmbeddings,
  syncOneConfluencePage,
} from "./_confluence_page_sync.js";

// Phase 3b W3b.1 + W3b.2 + Phase 3d W3d.1 + Phase 3e W3e.1 + W3e.2: job_type → handler ADAPTERS for
// the 7 crons migrated off Temporal Schedules — the 2 INTERVAL crons (mutex_janitor every 5min +
// review_run_reaper every 10min), the 2 DAILY crons (mark_stale_chunks + partition_maintenance, both
// 02:00 UTC), the run_id_retention DAILY cron (03:00 UTC — the 3-sweep close→retire→delete chain the
// Temporal runIdRetentionWorkflow composes), the workspace_retention INTERVAL cron (every 5min —
// the FIRST MULTI-STEP workflow BODY ported: the orphan-sweep → per-id reap/release loop →
// retention-purge orchestration of workspaceRetentionWorkflow, with its per-id fail-open invariant),
// and the confluence_ingest INTERVAL cron (every 6h — the per-space × per-page NESTED FAN-OUT of
// confluenceIngestWorkflow, with BOTH fail-open layers + the F-40 live_page_ids-before-try ordering).
// Each adapter is a JobHandler over the EXISTING, tested activity bodies
// (apps/backend/src/activities/*) — the activity logic is NOT rewritten here; this is the de-Temporal
// analogue of the workflow bodies (mutex_janitor.workflow.ts / review_run_reaper.workflow.ts /
// mark_stale_chunks.workflow.ts / partition_maintenance.workflow.ts / run_id_retention.workflow.ts /
// workspace_retention.workflow.ts / confluence_ingest.workflow.ts), which stay in place until Phase 4
// deletes the Temporal side.
//
// ## Input contracts (handler-owned parsing — the W2b opaque-payload posture)
// The Temporal workflows dispatch their activities zero-arg or with the empty marker input (the
// activities resolve DSN / thresholds / clock at the activity boundary), so every scheduled `input`
// is `{}` and each cron input contract is STRICT: the interval pair + partition_maintenance parse a
// strict empty object; mark_stale_chunks parses the REAL `MarkStaleChunksInputV1` (the ADR-0047
// single-typed-input marker — `.strict()` with only the defaulted `schema_version`), exactly what
// the Temporal workflow threads through. Strict-fail-loud over silently-ignore: an operator who
// edits core.scheduled_jobs.input expecting an effect gets a parse error surfaced through the job's
// last_error/dead_reason (taxonomy-governance posture) instead of a no-op. Widening an input
// (e.g. a reaper stale-threshold override) is a deliberate contract change here, not payload drift.
//
// ## Result handling
// The handlers return void — the platform persists job OUTCOME (done/failed/dead), not activity
// results. Each sweep's tally is logged (the Temporal-side analogue was the workflow result payload,
// equally consumed by nobody but observability).
//
// ## Cancellation (`signal`) posture
// The SWEEP crons are idempotent (FOR UPDATE SKIP LOCKED / CTE UPDATE WHERE-guarded / pg_partman's
// own re-runnable maintenance / per-batch transactions guarded by `retired_at IS NULL`), so those
// adapters deliberately do not thread `signal`. A lease-lost duplicate dispatch re-sweeping is
// harmless by construction; the run_id_retention chain's bounded batches keep each step's loss
// window small (the Temporal side ran the same sweeps under at-least-once retries).
//
// confluence_ingest is the EXCEPTION (W4b.3 — review blocker #4): its per-space × per-page fan-out
// is long-running with EXTERNAL/COST calls (Confluence fetches, chunk embeds), so it HONORS the
// runner's abort cooperatively — `signal.throwIfAborted()` at the top of each SPACE iteration, each
// PAGE iteration, and before every per-page activity (_confluence_page_sync.ts). Without the
// checkpoints the runner can settle the attempt (lease loss / hard runtime ceiling) while the
// orphaned handler keeps fetching + embedding — duplicating the external calls the retry redrives.
// An abort is NOT a fail-open case: BOTH catches (per-space, per-page F-40) re-throw when
// `signal.aborted` so the cancellation propagates out instead of being swallowed as one more
// transient failure (the orchestrate/withAbortGate posture — no NEW external call starts after
// abort). The throw is `signal.reason`; the runner settles it failed (markFailed/lease_lost).

/** mutex_janitor scheduled input — zero-config, 1:1 with the Temporal zero-arg dispatch. */
export const MutexJanitorCronInputV1 = z.object({}).strict();

/** review_run_reaper scheduled input — zero-config; the stale threshold stays env-resolved
 *  (`CODEMASTER_REVIEW_RUN_REAPER_STALE_AFTER_SECONDS`, ADR-0074) at the activity boundary. */
export const ReviewRunReaperCronInputV1 = z.object({}).strict();

/** partition_maintenance scheduled input — zero-config, 1:1 with the Temporal zero-arg dispatch
 *  (the activity's only parameter is its DSN deps, a composition concern — not caller input). */
export const PartitionMaintenanceCronInputV1 = z.object({}).strict();

/** run_id_retention scheduled input — the three retention TTLs (days), 1:1 with the Temporal
 *  Schedule's pinned workflow input (run_id_retention.workflow.ts::RunIdRetentionInput; Python
 *  `args=[7, 30, 90]`). STRICT + all-required: the scheduled row carries the full TTL object, and a
 *  drifted/garbage operator edit fails the parse loudly instead of silently sweeping with defaults. */
export const RunIdRetentionCronInputV1 = z
  .object({
    prTtlDays: z.number().int().min(1),
    runTtlDays: z.number().int().min(1),
    eventTtlDays: z.number().int().min(1),
  })
  .strict();

/** workspace_retention scheduled input — zero-config, 1:1 with the Temporal workflow's zero-arg
 *  activity dispatches (every timing threshold is a WorkspaceConfig-default module constant resolved
 *  at the activity boundary — workspace_retention.activity.ts). */
export const WorkspaceRetentionCronInputV1 = z.object({}).strict();

/** job_retention scheduled input — the two terminal-job-row TTLs (days), W4.6 (L4+L5). STRICT +
 *  all-required (the run_id_retention posture): the scheduled row carries the full TTL object, and
 *  a drifted/garbage operator edit fails the parse loudly instead of silently sweeping with
 *  defaults. cache_idempotency needs no TTL — its rows carry their own expires_at. */
const JobRetentionCronInputV1 = z
  .object({
    reviewJobsTtlDays: z.number().int().min(1),
    backgroundJobsTtlDays: z.number().int().min(1),
  })
  .strict();

/**
 * A {@link GitHubApiClient} built lazily on first `.get`/`.patch` and memoized — the SAME
 * deferred-Vault shape the Temporal composition root hands `RunIdRetentionActivities`
 * (build_activities.ts::makeLazyRetentionGithubClient). The PR-closer only ever calls `.get` (list
 * open PRs by head) + `.patch` (close a PR), so this two-method structural slice is a faithful,
 * fully-real client seam. In dev the close-sweep candidate SQL returns ZERO stale ephemeral runs →
 * the client is NEVER built → an absent `VAULT_ADDR` / GitHub-App token cannot crash the 3am sweep.
 * The internal WallClock is composition wiring for token-expiry math (the runner's prod clock IS a
 * WallClock); the SWEEP cutoffs thread the handler's injected clock, not this one.
 */
function makeLazyRetentionGithubClient(): GitHubApiClient {
  let memo: Promise<GitHubApiClient> | undefined;
  const lazy = (): Promise<GitHubApiClient> => {
    if (memo === undefined) {
      // Dynamic imports (the hydrate-activity idiom) keep the Vault/GitHub wiring off this module's
      // static import graph — the runner boots without touching either.
      memo = (async (): Promise<GitHubApiClient> => {
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
    get: async (path: Parameters<GitHubApiClient["get"]>[0], opts: Parameters<GitHubApiClient["get"]>[1]) =>
      (await lazy()).get(path, opts),
    patch: async (
      path: Parameters<GitHubApiClient["patch"]>[0],
      opts: Parameters<GitHubApiClient["patch"]>[1],
    ) => (await lazy()).patch(path, opts),
  } as unknown as GitHubApiClient;
}

// ── W3e.2 confluence_ingest collaborators ──────────────────────────────────────────────────────────
// The per-page chain + holder construction + lazy deferred-Vault client/embedder builders moved to
// ./_confluence_page_sync.ts (Phase 3e.3) — ONE source of truth shared with the event_handlers
// 'trigger_page_resync' single-page handler so the two dispatch paths can never drift.

/** confluence_ingest scheduled input — the REAL `RefreshConfluenceInputV1` (the ADR-0047
 *  single-typed-input marker — `.strict()` with only the defaulted `schema_version`), exactly what the
 *  Temporal Schedule dispatches into confluenceIngestWorkflow (the mark_stale_chunks parse posture). */
export const ConfluenceIngestCronInput = RefreshConfluenceInputV1;

/** Per-space accumulator (1:1 with the workflow body's SpaceStats, including the F-40 `pages_failed`
 *  counter — observability-only, never aggregated into the cross-space tally). */
type ConfluenceSpaceStats = {
  pages_processed: number;
  pages_failed: number;
  chunks_upserted: number;
  chunks_rejected_no_approval: number;
  chunks_rejected_default_cap: number;
  chunks_quarantined: number;
  pages_soft_deleted: number;
};

/**
 * Sync one Confluence space end-to-end; return per-space stats. 1:1 with the workflow body's
 * `syncOneSpace` (confluence_ingest.workflow.ts) / the frozen Python `_sync_one_space` — the SAME
 * activity sequence over the SAME holder methods, dispatched in-process instead of via proxies.
 */
async function syncOneConfluenceSpace(
  acts: ConfluenceSyncActivities,
  spaceKey: string,
  cycleStartedAt: string,
  signal: AbortSignal,
): Promise<ConfluenceSpaceStats> {
  // Fetch all page references in the space.
  const pagesOut = await acts.fetchSpacePages({ schema_version: 1, space_key: spaceKey });

  const stats: ConfluenceSpaceStats = {
    pages_processed: 0,
    pages_failed: 0, // F-40: per-page failure counter (observability only; never returned).
    chunks_upserted: 0,
    chunks_rejected_no_approval: 0,
    chunks_rejected_default_cap: 0,
    chunks_quarantined: 0,
    pages_soft_deleted: 0,
  };
  const livePageIds: Array<string> = [];

  for (const pageRef of pagesOut.pages) {
    // W4b.3: cooperative cancellation at the PAGE boundary — an aborted job stops BEFORE the next
    // page's external chain starts (the throw propagates out of the whole handler, so the
    // downstream reconcile never runs against a partial livePageIds — F-40 stays intact).
    signal.throwIfAborted();
    // F-40 (confluence_sync_workflow.py:192-205): the page_id is appended to livePageIds BEFORE the
    // per-page try so a transient page failure does NOT get its chunks soft-deleted by the downstream
    // reconcile. If a page keeps failing across many cycles, an operator follow-up signal is needed —
    // silently flushing chunks would hide that.
    livePageIds.push(pageRef.page_id);
    try {
      // The shared 4-step per-page chain (fetch_body → sanitize → chunk_and_embed → upsert,
      // F-37 page_version threading included) — _confluence_page_sync.ts, Phase 3e.3 extraction.
      const upsertOut = await syncOneConfluencePage(acts, {
        spaceKey,
        pageId: pageRef.page_id,
        cycleStartedAt,
        signal,
      });

      // Page survived all 4 activities.
      stats.pages_processed += 1;
      stats.chunks_upserted += upsertOut.upserted;
      stats.chunks_rejected_no_approval += upsertOut.rejected_no_approval;
      stats.chunks_rejected_default_cap += upsertOut.rejected_default_cap;
      if (upsertOut.quarantined) {
        stats.chunks_quarantined += 1;
      }
    } catch (e) {
      // W4b.3: an ABORT is NOT a per-page fail-open case — re-throw so the cancellation propagates
      // out of the fan-out (no next page, no reconcile) instead of being swallowed as one more
      // transient page failure that would keep the orphaned loop fetching/embedding post-settle.
      if (signal.aborted) {
        throw e;
      }
      // Per-PAGE fail-open (F-40): bump the failure counter + continue with the next page. The page_id
      // is already in livePageIds (appended before the try) so reconcile won't soft-delete its chunks.
      stats.pages_failed += 1;
      console.warn(
        `confluence_ingest: page ${pageRef.page_id} in space ${spaceKey} failed; its chunks stay ` +
          `protected from reconcile (F-40): ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
  }

  // Reconcile deletions: soft-delete chunks for pages absent this cycle.
  const reconcileOut = await acts.reconcileDeletions({
    schema_version: 1,
    space_key: spaceKey,
    live_page_ids: livePageIds,
  });
  stats.pages_soft_deleted += reconcileOut.soft_deleted;
  return stats;
}

/**
 * Composition-root collaborators the cron adapters close over (the buildActivities idiom). The W3b.2
 * daily pair landed needing only the same dsn seam (MarkStaleChunksActivity is constructed over it at
 * registration; runPgPartmanMaintenanceActivity threads it as deps); grows as later Phase 3b waves
 * land handlers that need richer constructed services.
 */
export type CronHandlersDeps = {
  /** OPTIONAL DSN override threaded into each activity (integration tests inject the disposable
   *  :5434 DSN explicitly). Omitted in prod — each activity self-resolves `CODEMASTER_PG_CORE_DSN`
   *  exactly as it does under its Temporal zero-arg dispatch. */
  readonly dsn?: string;
  /** OPTIONAL GitHub client for the run_id_retention close-stale-PRs sweep (integration tests
   *  inject a fake `{ get, patch }` slice). Omitted in prod — the handler builds the deferred-Vault
   *  lazy client ({@link makeLazyRetentionGithubClient}), 1:1 with the Temporal composition root. */
  readonly retentionGithubClient?: GitHubApiClient;
  /** OPTIONAL collaborator overrides for the workspace_retention reap loop's per-id releaseWorkspace
   *  calls (integration tests inject a tmpdir `workspaceRoot` + optionally their disposable db).
   *  Omitted in prod — the release activity self-resolves env (`CODEMASTER_PG_CORE_DSN` /
   *  `CODEMASTER_WORKSPACE_ROOT`), exactly as under its Temporal `releaseWorkspace` registration;
   *  the runner's clock threads in as the default time seam either way. */
  readonly releaseWorkspaceDeps?: ReleaseWorkspaceDeps;
  /** OPTIONAL Confluence listPages/getPage slice for the confluence_ingest fan-out (integration tests
   *  inject a scripted fake). Omitted in prod — the handler builds the deferred-Vault lazy
   *  ConfluenceClient ({@link makeLazyConfluenceChunkClient}), 1:1 with the Temporal composition
   *  root's makeLazyConfluenceClient (build_activities.ts). */
  readonly confluenceClient?: ConfluenceChunkClient;
  /** OPTIONAL embeddings port for the confluence_ingest chunk embeds (integration tests inject the
   *  deterministic RecordingEmbeddingsClient). Omitted in prod — the env-selected platform embedder
   *  (resolveEmbeddingsConsumer, ADR-0059) resolved LAZILY on the FIRST embed call + memoized
   *  ({@link makeLazyConfluenceEmbeddings}), so a runner without embedder env vars still boots AND
   *  runs empty (zero-space / zero-page) cycles green. */
  readonly confluenceEmbeddings?: EmbeddingsPort;
  /** OPTIONAL dispose registry (W4c.2 #10): the composition root (buildBackgroundRunner) threads its
   *  shared registry so the DEFAULT lazy Confluence client's token-refresh loop gets a dispose
   *  handle for the runner's post-SIGTERM dispose phase. Omitted by tests that inject their own
   *  `confluenceClient` (an injected client owns its own lifecycle — nothing is registered). */
  readonly disposables?: DisposableRegistry;
};

/**
 * Register the W3b.1 + W3b.2 cron handlers on the runner's registry. Called ONCE at the composition root
 * ({@link import("../background_runner_main.js").buildBackgroundRunner}); HandlerRegistry.register
 * throws on duplicates, so double-wiring fails loud at boot.
 *
 * Each adapter: parse the verified payload with its OWN contract → run the existing activity body
 * (clock threaded from the runner's HandlerDeps — the Clock seam; DSN from `deps.dsn` or the
 * activity's env resolution) → log the sweep tally. A parse/activity throw propagates to the runner,
 * which settles the attempt failed (markFailed: backoff re-enqueue, then dead at exhaustion) — the
 * platform's analogue of the Temporal retry curve those workflows carried.
 */
export function registerCronHandlers(registry: HandlerRegistry, deps: CronHandlersDeps = {}): void {
  registry.register("mutex_janitor", async (payload, _signal, handlerDeps) => {
    MutexJanitorCronInputV1.parse(payload);
    const result = await mutexJanitorActivity({
      ...(deps.dsn !== undefined ? { dsn: deps.dsn } : {}),
      clock: handlerDeps.clock,
    });
    console.info(
      `mutex_janitor swept: scanned=${result.scanned} swept=${result.swept} job_id=${handlerDeps.job.job_id}`,
    );
  });

  registry.register("review_run_reaper", async (payload, _signal, handlerDeps) => {
    ReviewRunReaperCronInputV1.parse(payload);
    const result = await reviewRunReaperActivity({
      ...(deps.dsn !== undefined ? { dsn: deps.dsn } : {}),
      clock: handlerDeps.clock,
    });
    console.info(
      `review_run_reaper swept: scanned=${result.scanned} reaped=${result.reaped} job_id=${handlerDeps.job.job_id}`,
    );
  });

  // W3b.2: the 2 daily crons. MarkStaleChunksActivity is a CLASS (bound-method holder) — construct
  // it ONCE at registration over the same optional dsn override, exactly as build_activities.ts does
  // for the Temporal worker (`new MarkStaleChunksActivity({ dsn })` + `.markStaleChunks.bind(...)`);
  // neither daily activity takes a clock (both stamp via the DB `now()`, 1:1 with the frozen Python).
  const markStaleChunksActivity = new MarkStaleChunksActivity(
    deps.dsn !== undefined ? { dsn: deps.dsn } : {},
  );
  registry.register("mark_stale_chunks", async (payload, _signal, handlerDeps) => {
    const input = MarkStaleChunksInputV1.parse(payload);
    const result = await markStaleChunksActivity.markStaleChunks(input);
    console.info(
      `mark_stale_chunks swept: default=${result.chunks_marked_stale_default} ` +
        `security_policy=${result.chunks_marked_stale_security_policy} job_id=${handlerDeps.job.job_id}`,
    );
  });

  registry.register("partition_maintenance", async (payload, _signal, handlerDeps) => {
    PartitionMaintenanceCronInputV1.parse(payload);
    // dsn resolution order inside the activity: injected → CODEMASTER_PG_MAINT_DSN → CODEMASTER_PG_CORE_DSN.
    const result = await runPgPartmanMaintenanceActivity(
      deps.dsn !== undefined ? { dsn: deps.dsn } : {},
    );
    console.info(
      `partition_maintenance ran: tables_processed=${result.tables_processed} ` +
        `partitions_created=${result.partitions_created} job_id=${handlerDeps.job.job_id}`,
    );
  });

  // W3d.1: run_id_retention — the daily 03:00 UTC chain of the 3 run_id sweeps, SEQUENTIAL in the
  // SAME close → retire → delete order the Temporal runIdRetentionWorkflow body composes (a sweep
  // throw aborts the chain and fails the attempt, the platform analogue of the workflow surfacing an
  // activity failure after retries). Each TTL threads from the scheduled input — 1:1 with the
  // workflow threading its pinned input into the matching activity proxy. The retention GitHub
  // client (the close sweep's only egress) is closed over ONCE at registration: the injected test
  // fake, or the deferred-Vault lazy client (never built while the candidate SQL returns zero rows).
  const retentionGithubClient = deps.retentionGithubClient ?? makeLazyRetentionGithubClient();
  registry.register("run_id_retention", async (payload, _signal, handlerDeps) => {
    const input = RunIdRetentionCronInputV1.parse(payload);
    const dsnPart = deps.dsn !== undefined ? { dsn: deps.dsn } : {};
    const prCloser = await runIdCloseStalePrsActivity({
      ...dsnPart,
      clock: handlerDeps.clock,
      ttlDays: input.prTtlDays,
      githubClient: retentionGithubClient,
    });
    const runs = await runIdRetireOldRunsActivity({
      ...dsnPart,
      clock: handlerDeps.clock,
      ttlDays: input.runTtlDays,
    });
    const events = await runIdDeleteOldEventsActivity({
      ...dsnPart,
      clock: handlerDeps.clock,
      ttlDays: input.eventTtlDays,
    });
    console.info(
      `run_id_retention swept: prs_closed=${prCloser.closed} prs_skipped=${prCloser.skipped} ` +
        `runs_retired=${runs.retired} events_deleted=${events.deleted} ` +
        `events_batches=${events.batches} job_id=${handlerDeps.job.job_id}`,
    );
  });

  // W4.6 (L4+L5): job_retention — the daily 03:30 UTC janitor for the runner's OWN terminal job
  // rows (core.review_jobs done/dead/cancelled, core.background_jobs done/dead — both TTL'd from
  // the scheduled input) + the webhook idempotency ledger (cache.cache_idempotency past its own
  // expires_at). Idempotent bounded-batch DELETEs (FOR UPDATE SKIP LOCKED, per-batch transactions)
  // — the same no-signal posture as the other sweep crons (a lease-lost duplicate re-sweep is
  // harmless by construction).
  registry.register("job_retention", async (payload, _signal, handlerDeps) => {
    const input = JobRetentionCronInputV1.parse(payload);
    const result = await jobRetentionSweepActivity({
      ...(deps.dsn !== undefined ? { dsn: deps.dsn } : {}),
      clock: handlerDeps.clock,
      reviewJobsTtlDays: input.reviewJobsTtlDays,
      backgroundJobsTtlDays: input.backgroundJobsTtlDays,
    });
    console.info(
      `job_retention swept: review_jobs_deleted=${result.review_jobs_deleted} ` +
        `background_jobs_deleted=${result.background_jobs_deleted} ` +
        `idempotency_deleted=${result.idempotency_deleted} batches=${result.batches} ` +
        `job_id=${handlerDeps.job.job_id}`,
    );
  });

  // W3e.1: workspace_retention — the every-5-min MULTI-STEP janitor chain the Temporal
  // workspaceRetentionWorkflow body composes (workspace_retention.workflow.ts): orphan-sweep → reap
  // (per-id release loop) → retention-purge, IN ORDER. This re-implements the workflow BODY (the
  // orchestration) as a handler; the three sweep activities + the release activity are REUSED, not
  // rewritten. The per-id reap loop preserves the workflow's FAIL-OPEN invariant EXACTLY: each
  // releaseWorkspace call runs in its OWN try/catch, so ONE bad release (security violation,
  // transient rm/DB error, StateDrift) logs + leaves THAT lease in FAILED_CLEANUP for the next
  // sweep's cleanup-backoff window WITHOUT poisoning the rest of the sweep or the job —
  // releaseWorkspace is idempotent + the UNIVERSAL cleanup mechanism (spec §10.2); this handler does
  // NOT duplicate cleanup logic. A throw from any of the three SWEEP activities still propagates and
  // fails the attempt (markFailed: backoff re-enqueue, then dead at exhaustion) — the platform
  // analogue of the workflow surfacing a sweep-activity failure after its RetryPolicy exhausts.
  registry.register("workspace_retention", async (payload, _signal, handlerDeps) => {
    WorkspaceRetentionCronInputV1.parse(payload);
    const dsnPart = deps.dsn !== undefined ? { dsn: deps.dsn } : {};
    // Injected overrides win; the runner's clock is the default time seam (the Temporal registration
    // self-defaults WallClock inside the activity — the runner's prod clock IS a WallClock).
    const releaseDeps: ReleaseWorkspaceDeps = {
      clock: handlerDeps.clock,
      ...(deps.releaseWorkspaceDeps ?? {}),
    };

    // Step 1 — orphan sweep: ALLOCATED leases whose worker heartbeat is dead → ORPHANED.
    const orphan = await runWorkspaceOrphanSweepActivity({ ...dsnPart, clock: handlerDeps.clock });

    // Step 2 — reap: the activity returns the SORTED release-retry-eligible workspace_ids (NO side
    // effects); iterate + release each, fail-open PER ID (1:1 with the workflow body's per-id loop,
    // which gave each release its own RetryPolicy so one bad reap doesn't poison the whole sweep).
    const reap = await runWorkspaceReapActivity({ ...dsnPart, clock: handlerDeps.clock });
    let reaped = 0;
    for (const workspaceId of reap.workspace_ids) {
      try {
        await releaseWorkspace({ schema_version: 1, workspace_id: workspaceId }, releaseDeps);
        reaped += 1;
      } catch (e) {
        // The lease ended in FAILED_CLEANUP and the next sweep re-picks it up within the
        // cleanup-backoff window. Log + continue — 1:1 with the workflow's log.warn + continue.
        console.warn(
          `workspace_retention: releaseWorkspace failed for ${workspaceId}; lease left in ` +
            `FAILED_CLEANUP for next sweep: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }
    }

    // Step 3 — retention purge: hard-delete RELEASED rows past the 7d retention window.
    const purge = await runWorkspaceReleasedRetentionActivity({ ...dsnPart, clock: handlerDeps.clock });

    // The workflow body's { orphaned, reaped, retention_deleted } result counters, as the log tally
    // (the platform persists job OUTCOME, not results — same posture as every cron handler above).
    console.info(
      `workspace_retention swept: orphaned=${orphan.orphaned_count} reaped=${reaped} ` +
        `retention_deleted=${purge.deleted_count} job_id=${handlerDeps.job.job_id}`,
    );
  });

  // W3e.2: confluence_ingest — the every-6h per-space × per-page NESTED FAN-OUT the Temporal
  // confluenceIngestWorkflow body composes (confluence_ingest.workflow.ts / the frozen Python
  // ConfluenceIngestWorkflow.run): list_active_spaces → per space (syncOneConfluenceSpace) → per page
  // (fetch_body → sanitize → chunk_and_embed → upsert) → reconcile_deletions. This re-implements the
  // workflow BODY (the orchestration) as a handler; the 7 confluence activities are REUSED, not
  // rewritten. BOTH fail-open layers are preserved EXACTLY:
  //   • per-SPACE: a space whose sync throws is recorded in failed_spaces + the loop CONTINUES (ALL
  //     exceptions caught, no auth carve-out — the ONLY carve-out is the W4b.3 abort re-throw, the
  //     module-doc cancellation posture) — one broken space cannot abort the full cycle. The
  //     broken space's reconcile is never reached, so its existing corpus is untouched.
  //   • per-PAGE (F-40): each page_id is appended to live_page_ids BEFORE the per-page try inside
  //     syncOneConfluenceSpace, so a transiently-failed page is NOT soft-deleted by reconcile.
  // A throw from list_active_spaces (or a per-space reconcile slipping the catch — it can't; the
  // catch wraps the whole space) propagates and fails the attempt (markFailed: backoff re-enqueue,
  // then dead at exhaustion) — the platform analogue of the workflow surfacing the listing activity's
  // failure after its RetryPolicy exhausts. The holder is constructed PER DISPATCH over the resolved
  // DSN (the sync_code_owners idiom — repos are thin wrappers over the shared memoized pool); the
  // lazy client/embedder are closed over ONCE at registration so their memos persist across cycles.
  let confluenceClient: ConfluenceChunkClient;
  if (deps.confluenceClient !== undefined) {
    confluenceClient = deps.confluenceClient;
  } else {
    // W4c.2 #10: the DEFAULT lazy client starts the ConfluenceTokenProvider refresh loop (a LIVE
    // timer) on first use; hand its dispose to the composition root's shared registry so the
    // runner's post-SIGTERM dispose phase can stop it and the process exits promptly.
    const lazyClient = makeLazyConfluenceChunkClient();
    deps.disposables?.register({
      name: "confluence_ingest.confluence_chunk_client",
      dispose: lazyClient.dispose,
    });
    confluenceClient = lazyClient.client;
  }
  const confluenceEmbeddings = deps.confluenceEmbeddings ?? makeLazyConfluenceEmbeddings();
  registry.register("confluence_ingest", async (payload, signal, handlerDeps) => {
    ConfluenceIngestCronInput.parse(payload);
    const dsn = deps.dsn ?? process.env.CODEMASTER_PG_CORE_DSN;
    if (dsn === undefined || dsn === "") {
      throw new Error("CODEMASTER_PG_CORE_DSN is not set; cannot run the confluence_ingest handler");
    }
    // The SAME collaborator set the Temporal composition root wires into ConfluenceSyncActivities
    // (build_activities.ts) — the shared construction in _confluence_page_sync.ts. Clock = the
    // runner's seam (prod IS a WallClock).
    const acts = buildConfluenceSyncActivities({
      dsn,
      clock: handlerDeps.clock,
      client: confluenceClient,
      embeddings: confluenceEmbeddings,
    });
    const listActivity = new ListActiveConfluenceSpacesActivity({ dsn });

    // Step 1: list active spaces (1:1 with the workflow body's first activity).
    const spacesOut = await listActivity.listActiveSpaces({ schema_version: 1 });

    // Deterministic cycle timestamp threaded as last_modified_at into sanitize + upsert — the
    // job-dispatch instant off the runner's Clock seam (the handler analogue of the workflow-start
    // instant the TS workflow pins via workflowInfo().startTime; constant across all spaces).
    // `.toISOString()` yields a tz-aware Z-suffixed RFC3339 string (the offset:true constraint).
    const cycleStartedAt = handlerDeps.clock.now().toISOString();

    let pagesProcessed = 0;
    let chunksUpserted = 0;
    let chunksRejectedNoApproval = 0;
    let chunksRejectedDefaultCap = 0;
    let chunksQuarantined = 0;
    let pagesSoftDeleted = 0;
    const failedSpaces: Array<string> = [];

    for (const spaceRef of spacesOut.spaces) {
      // W4b.3: cooperative cancellation at the SPACE boundary — an aborted job stops BEFORE the
      // next space's fan-out starts (module-doc cancellation posture).
      signal.throwIfAborted();
      try {
        const stats = await syncOneConfluenceSpace(acts, spaceRef.space_key, cycleStartedAt, signal);
        pagesProcessed += stats.pages_processed;
        chunksUpserted += stats.chunks_upserted;
        chunksRejectedNoApproval += stats.chunks_rejected_no_approval;
        chunksRejectedDefaultCap += stats.chunks_rejected_default_cap;
        chunksQuarantined += stats.chunks_quarantined;
        pagesSoftDeleted += stats.pages_soft_deleted;
      } catch (e) {
        // W4b.3: an ABORT is NOT a per-space fail-open case — re-throw so the cancellation fails the
        // attempt instead of being recorded as one more failed space while the loop keeps driving
        // external work the runner already settled away.
        if (signal.aborted) {
          throw e;
        }
        // Per-SPACE failure is non-fatal (confluence_sync_workflow.py:146-153): record the space_key +
        // continue so other spaces still get processed this cycle. ALL exceptions caught (no auth
        // carve-out) — 1:1 with the workflow body's bare catch.
        failedSpaces.push(spaceRef.space_key);
        console.warn(
          `confluence_ingest: space ${spaceRef.space_key} failed this cycle; continuing with the ` +
            `remaining spaces: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }
    }

    // The workflow body's RefreshConfluenceOutputV1 result fields, as the log tally (the platform
    // persists job OUTCOME, not results — pages_failed stays per-space-internal, 1:1 with the Python
    // never returning it).
    console.info(
      `confluence_ingest swept: pages_processed=${pagesProcessed} chunks_upserted=${chunksUpserted} ` +
        `chunks_rejected_no_approval=${chunksRejectedNoApproval} ` +
        `chunks_rejected_default_cap=${chunksRejectedDefaultCap} ` +
        `chunks_quarantined=${chunksQuarantined} pages_soft_deleted=${pagesSoftDeleted} ` +
        `failed_spaces=${JSON.stringify(failedSpaces)} job_id=${handlerDeps.job.job_id}`,
    );
  });
}
