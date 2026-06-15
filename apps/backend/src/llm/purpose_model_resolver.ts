// DB-backed purpose→model resolver (ADR-0060 "step 1"). The admin Job Routing UI writes
// core.llm_purpose_model; this resolver is what makes those assignments actually drive which model the
// runtime invokes. It reads the purpose pins joined to their catalog model's enabled/validation state,
// caches the result for a short TTL, and resolves a purpose to its pinned model ONLY when the pin's model
// is enabled AND has passed preflight (last_validation_status='ok'). For any other case — no pin, a pin to
// a missing/disabled/not-yet-validated model, or any read error — it FAILS OPEN to the static
// PURPOSE_MODEL_SEED (via modelForPurpose). A review must never break because the routing table is
// unreachable or a pin went stale.
//
// Kept deliberately SEPARATE from LlmClientCache: that cache's repo port exposes no DB handle and its
// freshness is a provider-settings fingerprint (which a purpose-routing write does not bump), so a
// purpose resolver cannot ride it. We use a plain monotonic-clock TTL instead — model enable/disable and
// /test validation mutate core.llm_models WITHOUT touching core.llm_purpose_model, so a purpose-table-only
// freshness signal would miss them; a TTL bounds staleness across both tables uniformly.

import { type Clock, WallClock } from "#platform/clock.js";

import { modelForPurpose } from "#backend/llm/model_router.js";

/** One purpose pin joined to its catalog model's validity state. `last_validation_status` is `null` when
 *  the pinned model_id is absent from core.llm_models (a LEFT JOIN miss) — treated as invalid. */
export type PurposeModelRow = {
  purpose: string;
  model_id: string;
  enabled: boolean;
  last_validation_status: string | null;
};

/** The read side the resolver needs: every purpose pin joined to its model's enabled + validation state. */
export type PurposeModelReadRepo = {
  listPurposeModelsWithState(): Promise<ReadonlyArray<PurposeModelRow>>;
};

/** The narrow resolver seam injected into the runtime call sites (curator/rerank/review/walkthrough/
 *  fix-prompt). Deliberately distinct from `LlmClientCacheLike` so model resolution is not bolted onto the
 *  LLM-client cache shape. */
export type PurposeModelResolverLike = {
  resolve(purpose: string): Promise<string>;
};

/** Default freshness window. 30s bounds how long a Job-Routing change (or a model enable/disable/validate)
 *  takes to take effect at runtime, without a per-call query. */
export const DEFAULT_PURPOSE_RESOLVER_TTL_MS = 30_000;

export class PurposeModelResolver implements PurposeModelResolverLike {
  private readonly repo: PurposeModelReadRepo;
  private readonly clock: Clock;
  private readonly ttlSeconds: number;
  // purpose → pinned model_id, holding ONLY valid pins (enabled + ok); invalid/missing are omitted so
  // resolve() falls through to the seed. `null` until the first (re)fetch.
  private cache: Map<string, string> | null = null;
  private lastFetchSeconds = Number.NEGATIVE_INFINITY;

  public constructor(args: { repo: PurposeModelReadRepo; clock?: Clock; ttlMs?: number }) {
    this.repo = args.repo;
    this.clock = args.clock ?? new WallClock();
    this.ttlSeconds = (args.ttlMs ?? DEFAULT_PURPOSE_RESOLVER_TTL_MS) / 1000;
  }

  public async resolve(purpose: string): Promise<string> {
    await this.refreshIfStale();
    // cache is non-null after refreshIfStale; a valid pin wins, else the static seed.
    return this.cache?.get(purpose) ?? modelForPurpose(purpose);
  }

  private async refreshIfStale(): Promise<void> {
    const nowSeconds = this.clock.monotonic();
    if (this.cache !== null && nowSeconds - this.lastFetchSeconds < this.ttlSeconds) {
      return;
    }
    this.lastFetchSeconds = nowSeconds;
    try {
      const rows = await this.repo.listPurposeModelsWithState();
      const next = new Map<string, string>();
      for (const row of rows) {
        if (row.enabled && row.last_validation_status === "ok") {
          next.set(row.purpose, row.model_id);
        }
      }
      this.cache = next;
    } catch {
      // Fail-open: any read error → resolve from the static seed until the next TTL window. We already set
      // lastFetchSeconds, so a persistently-erroring DB is retried at most once per TTL, not per call.
      this.cache = new Map<string, string>();
    }
  }
}

/** Static resolver that wraps the seed only — the default for unit/cassette paths and any wiring without a
 *  DB. Identical behavior to the pre-step-1 call sites (`modelForPurpose`). */
export const staticPurposeModelResolver: PurposeModelResolverLike = {
  resolve: (purpose: string): Promise<string> => Promise.resolve(modelForPurpose(purpose)),
};
