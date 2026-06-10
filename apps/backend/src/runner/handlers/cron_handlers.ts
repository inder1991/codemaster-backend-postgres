import { z } from "zod";

import { MarkStaleChunksActivity } from "#backend/activities/mark_stale_chunks.activity.js";
import { mutexJanitorActivity } from "#backend/activities/mutex_janitor.activity.js";
import { runPgPartmanMaintenanceActivity } from "#backend/activities/partition_maintenance.activity.js";
import { reviewRunReaperActivity } from "#backend/activities/review_run_reaper.activity.js";
import {
  runIdCloseStalePrsActivity,
  runIdDeleteOldEventsActivity,
  runIdRetireOldRunsActivity,
} from "#backend/activities/run_id_retention.activity.js";

import type { GitHubApiClient } from "#backend/integrations/github/api_client.js";

import { WallClock } from "#platform/clock.js";

import { MarkStaleChunksInputV1 } from "#contracts/confluence_sync_stale.v1.js";

import type { HandlerRegistry } from "../handler_registry.js";

// Phase 3b W3b.1 + W3b.2 + Phase 3d W3d.1: job_type → handler ADAPTERS for the 5 crons migrated off
// Temporal Schedules — the 2 INTERVAL crons (mutex_janitor every 5min + review_run_reaper every
// 10min), the 2 DAILY crons (mark_stale_chunks + partition_maintenance, both 02:00 UTC), and the
// run_id_retention DAILY cron (03:00 UTC — the 3-sweep close→retire→delete chain the Temporal
// runIdRetentionWorkflow composes). Each adapter is a thin JobHandler shim over the EXISTING, tested
// activity body (apps/backend/src/activities/*) — the activity logic is NOT rewritten here; this is
// the de-Temporal analogue of the workflow pass-through bodies (mutex_janitor.workflow.ts /
// review_run_reaper.workflow.ts / mark_stale_chunks.workflow.ts / partition_maintenance.workflow.ts /
// run_id_retention.workflow.ts), which stay in place until Phase 4 deletes the Temporal side.
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
// All the sweeps are idempotent (FOR UPDATE SKIP LOCKED / CTE UPDATE WHERE-guarded / pg_partman's
// own re-runnable maintenance / per-batch transactions guarded by `retired_at IS NULL`), so the
// adapters deliberately do not thread `signal`. A lease-lost duplicate dispatch re-sweeping is
// harmless by construction; the run_id_retention chain's bounded batches keep each step's loss
// window small (the Temporal side ran the same sweeps under at-least-once retries).

/** mutex_janitor scheduled input — zero-config, 1:1 with the Temporal zero-arg dispatch. */
const MutexJanitorCronInputV1 = z.object({}).strict();

/** review_run_reaper scheduled input — zero-config; the stale threshold stays env-resolved
 *  (`CODEMASTER_REVIEW_RUN_REAPER_STALE_AFTER_SECONDS`, ADR-0074) at the activity boundary. */
const ReviewRunReaperCronInputV1 = z.object({}).strict();

/** partition_maintenance scheduled input — zero-config, 1:1 with the Temporal zero-arg dispatch
 *  (the activity's only parameter is its DSN deps, a composition concern — not caller input). */
const PartitionMaintenanceCronInputV1 = z.object({}).strict();

/** run_id_retention scheduled input — the three retention TTLs (days), 1:1 with the Temporal
 *  Schedule's pinned workflow input (run_id_retention.workflow.ts::RunIdRetentionInput; Python
 *  `args=[7, 30, 90]`). STRICT + all-required: the scheduled row carries the full TTL object, and a
 *  drifted/garbage operator edit fails the parse loudly instead of silently sweeping with defaults. */
const RunIdRetentionCronInputV1 = z
  .object({
    prTtlDays: z.number().int().min(1),
    runTtlDays: z.number().int().min(1),
    eventTtlDays: z.number().int().min(1),
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
}
