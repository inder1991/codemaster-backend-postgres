// Phase 3e.3: the SHARED per-page Confluence sync core — the 4-activity chain (fetch_page_body →
// sanitize_page → chunk_and_embed → upsert_chunks) plus the collaborator construction BOTH the
// confluence handlers run:
//   * cron_handlers.ts 'confluence_ingest' (W3e.2) — the every-6h per-space × per-page fan-out
//     dispatches this chain inside its per-page loop (confluence_ingest.workflow.ts /
//     ConfluenceIngestWorkflow.run);
//   * event_handlers.ts 'trigger_page_resync' (this wave) — the admin-triggered single-page resync
//     dispatches it ONCE for the revoked page (trigger_page_resync.workflow.ts /
//     TriggerPageResyncWorkflow.run — the Temporal workflow chains the SAME 4 per-page activities).
// ONE source of truth for the chain's exact input threading (the F-37 fetched page_version, the
// cycle timestamp into sanitize + upsert) and for the holder's collaborator set — extracted from
// the W3e.2 cron handler verbatim so the two dispatch paths can never drift.
//
// The lazy deferred-Vault client/embedder builders live here too (moved from cron_handlers.ts):
// both registration sites close over their own instance, exactly as each module previously built
// its own lazy GitHub clients (the makeLazyRetentionGithubClient / makeLazyHydrateGithubPort
// precedent).

import {
  ConfluenceSyncActivities,
  PoolExistingChunkRowsReader,
  type ConfluenceChunkClient,
} from "#backend/activities/confluence_sync.activity.js";
import { makeLazyEmbedderCache } from "#backend/adapters/embedder_cache.js";
import type { EmbeddingsPort } from "#backend/adapters/embeddings_port.js";
import { PostgresConfluenceChunksRepo } from "#backend/domain/repos/confluence_chunks_repo.js";
import { PostgresConfluencePageApprovalsRepo } from "#backend/domain/repos/confluence_page_approvals_repo.js";

import { WallClock, type Clock } from "#platform/clock.js";
import { tenantKysely } from "#platform/db/database.js";

import type { UpsertChunksOutputV1 } from "#contracts/confluence_sync.v1.js";

/** The model name every confluence chunk embed routes through — byte-identical with the Temporal
 *  composition root's wiring (build_activities.ts) and the event_handlers REFRESH_EMBED_MODEL_NAME. */
export const CONFLUENCE_EMBED_MODEL_NAME = "qwen3-embed-0.6b";

/**
 * A {@link ConfluenceChunkClient} (the narrow listPages/getPage slice) that builds the REAL
 * Vault-token-backed ConfluenceClient on first use and memoizes it — 1:1 with the Temporal composition
 * root's `makeLazyConfluenceClient` (build_activities.ts). The Confluence Vault token is ABSENT in dev
 * (ADR-0075) and `ConfluenceTokenProvider.fromVault` is fail-HARD, so construction is deferred to the
 * FIRST `listPages`/`getPage` call: in dev, `list_active_confluence_spaces_activity` returns ZERO
 * spaces → the per-space loop never runs → the client is NEVER built → the absent token cannot fail
 * the 6h cycle. (The resync path defers identically: the first job's fetch_page_body settles the
 * attempt failed with the Vault error in last_error instead of crashing the runner at boot.) Dynamic
 * imports (the hydrate-activity idiom) keep the Vault/Confluence wiring off this module's static
 * import graph.
 */
export function makeLazyConfluenceChunkClient(): ConfluenceChunkClient {
  let memo: Promise<ConfluenceChunkClient> | undefined;
  const lazy = (): Promise<ConfluenceChunkClient> => {
    if (memo === undefined) {
      memo = (async (): Promise<ConfluenceChunkClient> => {
        const { ConfluenceClient } = await import("#backend/integrations/confluence/client.js");
        const { ConfluenceTokenProvider } = await import(
          "#backend/integrations/confluence/token_provider.js"
        );
        const { VaultHttpPort } = await import("#backend/adapters/vault_http.js");
        const clock = new WallClock();
        const vault = VaultHttpPort.fromEnv();
        const tokenProvider = await ConfluenceTokenProvider.fromVault({ vault, clock });
        tokenProvider.startRefreshLoop();
        // `authEmail` selects HTTP-Basic (Atlassian Cloud) vs Bearer (Server/DC PAT); OMITTED (not
        // set to undefined) when absent, per exactOptionalPropertyTypes.
        const authEmail = tokenProvider.authEmail;
        return new ConfluenceClient({
          baseUrl: tokenProvider.baseUrl,
          tokenProvider: tokenProvider.getToken.bind(tokenProvider),
          ...(authEmail !== null ? { authEmail } : {}),
          clock,
        });
      })();
    }
    return memo;
  };
  return {
    listPages: async (args) => (await lazy()).listPages(args),
    getPage: async (args) => (await lazy()).getPage(args),
  };
}

/**
 * An {@link EmbeddingsPort} that resolves the REAL env-selected platform embedder
 * (resolveEmbeddingsConsumer, ADR-0059 — fail-loud on missing env) on the FIRST `embed` call and
 * memoizes it (the event_handlers `resolveRefreshEmbeddings` idiom, pushed one seam deeper). Deferring
 * to the first EMBED (not the first dispatch) keeps the dev posture intact: a cycle over zero
 * spaces/pages never embeds → never resolves → a runner without embedder env vars both BOOTS and runs
 * empty 6h cycles green; the fail-loud env error surfaces on the first real chunk embed, settling the
 * attempt failed with last_error persisted.
 */
export function makeLazyConfluenceEmbeddings(): EmbeddingsPort {
  let memo: EmbeddingsPort | undefined;
  return {
    embed: async (req) => {
      if (memo === undefined) {
        // Dynamic import keeps the Qwen/OpenAI adapter graph off this module's static imports.
        const { resolveEmbeddingsConsumer } = await import("#backend/adapters/resolve_embeddings.js");
        memo = resolveEmbeddingsConsumer();
      }
      return memo.embed(req);
    },
  };
}

/**
 * Construct the per-dispatch {@link ConfluenceSyncActivities} holder over the resolved DSN — the
 * SAME collaborator set the Temporal composition root wires (build_activities.ts): the chunks repo
 * satisfies BOTH the idempotency-lookup and writer slices; the approvals repo the reader slice; the
 * pool reader the hard-limit candidate fetch; the lazy DSN-memoized EmbedderCache the SCOPE-A
 * dual-write (refresh() builds the singleton on the first upsert — an empty cycle never touches it).
 * Per-dispatch construction is cheap object wiring (the sync_code_owners idiom — repos are thin
 * wrappers over the shared memoized ADR-0062 pool); the lazy client/embedder memos live in the
 * REGISTRATION closure, not here, so they persist across dispatches.
 */
export function buildConfluenceSyncActivities(o: {
  dsn: string;
  /** The runner's Clock seam (prod IS a WallClock). */
  clock: Clock;
  client: ConfluenceChunkClient;
  embeddings: EmbeddingsPort;
}): ConfluenceSyncActivities {
  const db = tenantKysely<unknown>(o.dsn);
  const chunksRepo = new PostgresConfluenceChunksRepo({ db, clock: o.clock });
  return new ConfluenceSyncActivities({
    client: o.client,
    embeddings: o.embeddings,
    modelName: CONFLUENCE_EMBED_MODEL_NAME,
    chunkEmbeddingLookup: chunksRepo,
    chunksWriter: chunksRepo,
    approvalsReader: new PostgresConfluencePageApprovalsRepo({ db }),
    existingChunkRowsReader: new PoolExistingChunkRowsReader({ dsn: o.dsn }),
    embedderCache: makeLazyEmbedderCache(o.dsn, { clock: o.clock }),
  });
}

/**
 * Sync ONE Confluence page end-to-end — the 4-activity per-page chain, 1:1 with the per-page body of
 * confluenceIngestWorkflow's syncOneSpace AND the whole of triggerPageResyncWorkflow
 * (trigger_page_resync.workflow.ts steps 1-4 / the frozen Python TriggerPageResyncWorkflow.run):
 *   1. fetch_page_body  — the page body from Confluence;
 *   2. sanitize_page    — HTML sanitation + injection-pattern detection;
 *   3. chunk_and_embed  — chunk + embed via the platform embedder (idempotency-cached);
 *   4. upsert_chunks    — persist; the page-approval LEFT JOIN inside the upsert sees the CURRENT
 *      approval state and rejects default-tagged chunks with no active approval (the resync's
 *      raison d'être) or persists them otherwise.
 * `cycleStartedAt` threads as last_modified_at into sanitize + upsert (the workflows' deterministic
 * cycle-timestamp role); `page_version` is the REAL fetched version (the F-37 fix — both workflow
 * bodies thread `bodyOut.page.version`). Failures propagate to the CALLER, which owns the policy:
 * the ingest loop catches per-page (F-40 fail-open); the resync handler lets the throw fail the job
 * attempt (platform retry/backoff).
 *
 * ## Cancellation (W4b.3 — review blocker #4)
 * `signal` is the runner's cooperative-cancellation seam (aborted on lease loss AND at the hard
 * runtime ceiling). `signal.throwIfAborted()` fires BEFORE each of the 4 activities, so an aborted
 * job stops at the next step boundary instead of orphan-driving external work (the Confluence
 * fetch, the chunk EMBED — the network/cost steps) after the runner already settled the attempt:
 * a settled-then-orphaned handler would duplicate those calls when the retry redrives. The throw is
 * `signal.reason` (the runner's abort Error), which propagates to the CALLER — see each caller's
 * abort-is-not-fail-open re-throw posture.
 */
export async function syncOneConfluencePage(
  acts: ConfluenceSyncActivities,
  args: { spaceKey: string; pageId: string; cycleStartedAt: string; signal: AbortSignal },
): Promise<UpsertChunksOutputV1> {
  args.signal.throwIfAborted();
  const bodyOut = await acts.fetchPageBody({
    schema_version: 1,
    page_id: args.pageId,
    space_key: args.spaceKey,
  });

  args.signal.throwIfAborted();
  const sanitizedOut = await acts.sanitizePage({
    schema_version: 1,
    page: bodyOut.page,
    last_modified_at: args.cycleStartedAt,
  });

  args.signal.throwIfAborted();
  const chunkedOut = await acts.chunkAndEmbed({
    schema_version: 1,
    sanitized: sanitizedOut.sanitized,
  });

  args.signal.throwIfAborted();

  return await acts.upsertChunks({
    schema_version: 1,
    space_key: args.spaceKey,
    page_id: bodyOut.page.page_id,
    page_title: bodyOut.page.title,
    // F-37: pass page_version from the fetched body.
    page_version: bodyOut.page.version,
    page_status: bodyOut.page.status,
    last_modified_at: args.cycleStartedAt,
    raw_labels: bodyOut.page.labels,
    injection_flags: sanitizedOut.sanitized.injection_flags,
    chunks: chunkedOut.chunks,
  });
}
