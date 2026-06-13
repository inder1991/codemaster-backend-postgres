/**
 * TTL-refreshing LLM credentials provider (de-stub step 2). Source of fresh LLM provider credentials
 * for the worker's SDK adapter. Sits between the Postgres LLM provider settings repo
 * ({@link LlmProviderSettingsRepoPort} — production `PostgresLlmProviderSettingsRepo`, which decrypts
 * `api_key_ciphertext` via Vault Transit `"llm_provider_settings"`) and the LLM SDK adapter.
 *
 * ── Why TTL refresh + not pod-restart-on-rotation? ──
 * An admin clicking Save in the admin console expects the change to take effect within a
 * human-operator timescale (seconds-to-minutes), not a deploy cycle. The worker holds the
 * credentials in an in-memory cache; every {@link LlmCredentialsProvider.current} call checks cache
 * freshness and refreshes (one SELECT + one Vault Transit decrypt) when older than `ttlSeconds`.
 * Concurrent `current()` calls during a refresh share the single fetch via the per-role lock
 * (double-checked locking).
 *
 * ── Cache design — per-role Map ──
 * The cache is `Map<role, { creds, expiresAt }>`, NOT a single field. A single-field
 * `cached: LlmCredentials | null` would leak between roles: calling `current('primary')` then
 * `current('secondary')` inside the TTL window would return primary's creds for secondary. The Map
 * keys explicitly on role so the two roles cache independently and cannot bleed into each other's
 * slot.
 *
 * ── Failure ladder (the load-bearing semantics) ──
 *   1. Fresh cache (`now < expiresAt`): return cached credentials immediately; no I/O.
 *   2. Stale cache + refresh succeeds: cache repopulated; returns new credentials.
 *   3. Stale cache + refresh fails (transient): logs a structured
 *      `rule=bedrock-credentials-refresh-failed` warning, holds the prior cache, returns cached
 *      credentials. The caller does NOT see the failure — LLM invocations continue against the prior
 *      token. Transient I/O blips don't take down the review pipeline.
 *   4. Hard-stale (refresh has been failing for `hardStaleSeconds`): raises
 *      {@link LlmCredentialsExpiredError}. The worker activity catches it, lets Temporal retry, and
 *      the exception-rate alert fires. Default 30 min: long enough that a 5-min Postgres maintenance
 *      blip doesn't cascade, short enough that a real Vault outage surfaces within an SLA.
 *   5. Initial population failure (cache never populated; first `current()` raises): same as
 *      hard-stale — the activity fails fast and the operator sees the alert.
 *
 * ── Cheap rotation detection ──
 * Before the freshness check, `current()` does a cheap PK-scan via
 * {@link LlmProviderSettingsRepoPort.readLastRotatedAt} (`scope=platform, role`). If the
 * `last_rotated_at` fingerprint moved since last seen, the cached entry is invalidated immediately so
 * the slow path refetches under the lock — an operator rotation takes effect within sub-millisecond
 * latency instead of waiting for the TTL to expire. Mirrors the mechanism in `LlmClientCache.for_role`.
 *
 * ── Seams (everything non-deterministic is injected) ──
 *   - `clock`: ALL time reads (`now()` for freshness + hard-stale) go through the injected
 *     {@link Clock}, NEVER `Date.now()` — the check_clock_random gate enforces this.
 *   - per-role locks: the {@link KeyedMutex} REUSED from `installation_token.ts` (the `asyncio.Lock`
 *     analogue — a promise tail-chain keyed by role). One lock PER role, not one across both: a single
 *     lock would invert the failover design (Vault slowness during a primary refresh would serialize
 *     every secondary call, exactly when the worker needs the secondary path to absorb load).
 *
 * ── Port-fidelity divergence vs the Python ──
 * The Python `current(role, **_legacy_kwargs)` carries a deploy-ordering shim
 * (`reject_unknown_legacy_kwargs`) that swallows an `installation_id=` kwarg old worker pods may pass
 * during a rolling update. That shim is a Python-rollout artifact with no analogue in this fresh TS
 * codebase (no old TS pods exist), so it is intentionally NOT ported — `current(role)` takes the role
 * only. The Python module's Bedrock* back-compat aliases (`BedrockCredentials`, etc.) are likewise a
 * Phase-0 rename artifact and are NOT re-exported here.
 */

import { type Clock, WallClock } from "#platform/clock.js";

import { KeyedMutex } from "#backend/integrations/github/installation_token.js";
import {
  LlmCredentialsExpiredError,
  LlmRoleDisabledError,
  LlmRoleNotConfiguredError,
} from "#backend/integrations/llm/errors.js";
import {
  type LlmProviderRole,
  type LlmProviderSettings,
} from "#backend/integrations/llm/llm_provider_settings_repo.js";

// ─── Constants ────────────────────────────────────────────────────────────────────────────────

/**
 * Default TTL between forced refreshes from the LLM provider settings row. 5 minutes balances
 * rotation latency (admin saves a new token → workers pick it up) against DB load (each refresh is
 * one SELECT + one Vault Transit decrypt). Operator overrides via the constructor.
 */
const DEFAULT_TTL_SECONDS = 300;

/**
 * Hard-stale threshold — how long the provider holds a stale cache before fail-closing. Greater than
 * the longest transient Postgres / Vault blip we tolerate (typically minutes); less than the SLA at
 * which the operator MUST be paged.
 */
const DEFAULT_HARD_STALE_SECONDS = 1800; // 30 minutes

const MS_PER_SECOND = 1000;

// ─── The credential triple the SDK adapter consumes ───────────────────────────────────────────

/**
 * The credential triple the LLM SDK adapter consumes. In-process value (no `schema_version`) — it
 * never leaves the worker.
 *
 * The `apiKey` field holds the PLAINTEXT token — consumed immediately by the SDK adapter and MUST NOT
 * be logged, stored, or surfaced outside the call frame.
 */
export type LlmCredentials = {
  readonly apiKey: string;
  readonly region: string;
  readonly modelId: string;
};

// ─── Persistence port (the surface the repo satisfies) ─────────────────────────────────────────

/**
 * Persistence surface — the `PostgresLlmProviderSettingsRepo` adapter in production; an in-memory
 * stub in tests. A structural subset of the repo so the provider depends only on the two reads it
 * uses (decrypt + rotation probe), not the whole adapter.
 */
export type LlmProviderSettingsRepoPort = {
  /**
   * Return the decrypted settings row, or `null` if absent OR disabled (fail-closed). The returned
   * object exposes `provider`, `modelId`, `region`, `apiKey`, and `enabled`. In production this is
   * {@link LlmProviderSettings} from `./llm_provider_settings_repo.ts`.
   */
  readDecryptedSettings(role: LlmProviderRole): Promise<LlmProviderSettings | null>;

  /**
   * Return `last_rotated_at` for the `(scope, role)` row or `null`. Cheap single-row PK-scan; called
   * on every `current()` to detect operator-initiated rotations within sub-ms latency instead of
   * waiting for the TTL to expire. `null` means no row exists yet (first install before the admin
   * saves credentials) — treated as `no rotation seen`.
   */
  readLastRotatedAt(args: { scope: "platform"; role: LlmProviderRole }): Promise<Date | null>;
};

// ─── Cache envelope ────────────────────────────────────────────────────────────────────────────

/** Per-role cache entry: the credentials + the absolute UTC instant they go stale at. */
type CacheEntry = {
  readonly creds: LlmCredentials;
  readonly expiresAt: Date;
};

// ─── The provider ──────────────────────────────────────────────────────────────────────────────

export type LlmCredentialsProviderOptions = {
  readonly repo: LlmProviderSettingsRepoPort;
  readonly clock?: Clock;
  readonly ttlSeconds?: number;
  readonly hardStaleSeconds?: number;
};

/**
 * TTL-refreshing in-memory credential cache.
 *
 * One instance per worker pod; constructed in the worker bootstrap and injected into the per-role SDK
 * adapter wiring. The cache is keyed on role so primary and secondary credentials are cached
 * independently and cannot bleed into each other's slot.
 */
export class LlmCredentialsProvider {
  private readonly repo: LlmProviderSettingsRepoPort;
  private readonly clock: Clock;
  private readonly ttlSeconds: number;
  private readonly hardStaleSeconds: number;

  // Per-role cache. A single-field `cached: LlmCredentials | null` would leak between roles; the Map
  // keys explicitly on role so the two roles cache independently.
  private readonly cached = new Map<LlmProviderRole, CacheEntry>();

  // Per-role failure tracking for hard-stale detection: the first instant the current run of
  // refresh failures began (cleared on the next success).
  private readonly lastRefreshFailedAt = new Map<LlmProviderRole, Date>();

  // Per-role last-seen rotation fingerprint (`last_rotated_at`). A cheap PK-scan on every `current()`
  // detects operator-initiated rotations within sub-ms latency instead of waiting for the TTL.
  // `undefined` ⇒ never probed yet; `null` ⇒ probed, no row seeded — distinct so the first probe of
  // an unseeded role does not spuriously look like a rotation.
  private readonly fingerprints = new Map<LlmProviderRole, Date | null>();

  // Per-role locks (the `asyncio.Lock`-per-role analogue). A single lock across both roles would
  // invert the failover design — Vault slowness during a primary refresh would serialize every
  // secondary call, exactly when the worker needs the secondary path to absorb load. REUSED from the
  // github installation-token seam.
  private readonly locks = new KeyedMutex<LlmProviderRole>();

  public constructor(options: LlmCredentialsProviderOptions) {
    this.repo = options.repo;
    this.clock = options.clock ?? new WallClock();
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.hardStaleSeconds = options.hardStaleSeconds ?? DEFAULT_HARD_STALE_SECONDS;
  }

  /**
   * Return current credentials for the given role.
   *
   * Refreshes from the repo if the cache is older than `ttlSeconds`. Concurrent callers during a
   * refresh share the single fetch via the per-role lock; only one DB read happens per TTL window
   * even under high concurrency.
   *
   * @throws {@link LlmRoleNotConfiguredError} no row exists for `role` — operator hasn't seeded via
   *   the admin UI yet.
   * @throws {@link LlmRoleDisabledError} a row exists but `enabled=false`.
   * @throws {@link LlmCredentialsExpiredError} Vault decrypt / repo failure with no prior cache, or
   *   past the hard-stale threshold.
   */
  public async current(role: LlmProviderRole): Promise<LlmCredentials> {
    // Cheap PK-scan first: detect operator rotation immediately rather than waiting for the TTL to
    // expire. If the fingerprint moved, invalidate the cached entry so the slow path below refetches
    // under the lock.
    const latestFp = await this.repo.readLastRotatedAt({ scope: "platform", role });
    if (this.fingerprintMoved(role, latestFp)) {
      this.cached.delete(role);
      this.fingerprints.set(role, latestFp);
    }

    if (this.cacheIsFresh(role)) {
      // Non-null: cacheIsFresh returned true ⇒ an entry exists.
      return this.cached.get(role)!.creds;
    }

    const release = await this.locks.acquire(role);
    try {
      // Double-check: another caller may have refreshed while we waited for the lock.
      if (this.cacheIsFresh(role)) {
        return this.cached.get(role)!.creds;
      }
      return await this.refreshOrServeStale(role);
    } finally {
      release();
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────────────────────

  /**
   * Did `last_rotated_at` move since we last saw it? `undefined` (never probed) vs `null` (probed, no
   * row) is a meaningful distinction: the first probe of an unseeded role records `null` WITHOUT
   * spuriously invalidating a not-yet-populated cache. A genuine rotation (timestamp change) or a
   * row-appears (`null` → a Date) both register as moved.
   */
  private fingerprintMoved(role: LlmProviderRole, latest: Date | null): boolean {
    if (!this.fingerprints.has(role)) {
      // First probe: record it. Treated as moved so an already-populated cache (e.g. a manual
      // pre-seed) is re-validated once, matching the Python `latest_fp != self._fingerprints.get(role)`
      // where `.get` defaults to None and a real first timestamp differs from None.
      return latest !== null;
    }
    const previous = this.fingerprints.get(role) ?? null;
    if (previous === null && latest === null) {
      return false;
    }
    if (previous === null || latest === null) {
      return true;
    }
    return previous.getTime() !== latest.getTime();
  }

  private cacheIsFresh(role: LlmProviderRole): boolean {
    const entry = this.cached.get(role);
    if (entry === undefined) {
      return false;
    }
    return this.clock.now().getTime() < entry.expiresAt.getTime();
  }

  /**
   * Fetch from the repo. On success, repopulate the cache + reset the last-failure marker. On
   * exception, log + check hard-stale via {@link handleRefreshFailure}.
   */
  private async refreshOrServeStale(role: LlmProviderRole): Promise<LlmCredentials> {
    let settings: LlmProviderSettings | null;
    try {
      settings = await this.repo.readDecryptedSettings(role);
    } catch (err) {
      return this.handleRefreshFailure(role, err);
    }

    if (settings === null) {
      // `readDecryptedSettings` returns `null` for BOTH an absent row AND a disabled row (the repo
      // folds disabled into absent, fail-closed). The Python provider distinguishes them by reading
      // `enabled` off a non-null settings object; here that distinction is already collapsed upstream,
      // so we surface the not-configured error — the operator either hasn't seeded the slot or has
      // disabled it, and in both cases there are no usable credentials for this role.
      throw new LlmRoleNotConfiguredError(`no LLM provider configured for role=${role}`);
    }

    if (!settings.enabled) {
      // Defense-in-depth: the repo already returns null for a disabled slot, but if a future repo
      // surfaces a disabled-but-present row, fail with the specific disabled error.
      throw new LlmRoleDisabledError(`LLM provider for role=${role} is disabled`);
    }

    const creds: LlmCredentials = {
      apiKey: settings.apiKey,
      // Python: `region=settings.region or ""` — a NULL region becomes the empty string.
      region: settings.region ?? "",
      modelId: settings.modelId,
    };
    const expiresAt = new Date(this.clock.now().getTime() + this.ttlSeconds * MS_PER_SECOND);
    this.cached.set(role, { creds, expiresAt });
    // Clear the failure marker on success.
    this.lastRefreshFailedAt.delete(role);
    return creds;
  }

  /**
   * Cache miss / decrypt failure / repo error path. Hold the prior cache up to `hardStaleSeconds`,
   * then fail-closed.
   */
  private handleRefreshFailure(role: LlmProviderRole, err: unknown): LlmCredentials {
    const now = this.clock.now();
    if (!this.lastRefreshFailedAt.has(role)) {
      this.lastRefreshFailedAt.set(role, now);
    }
    const failingSince = this.lastRefreshFailedAt.get(role)!;

    const priorEntry = this.cached.get(role);
    const staleForSeconds = (now.getTime() - failingSince.getTime()) / MS_PER_SECOND;

    // Structured WARN — `console.warn` is the established no-dep logging analogue in this codebase
    // (post_review_results.activity.ts, pr_mutex.ts). The `rule` token + `role` are the
    // operator-side signal the bedrock-credentials-refresh-failed alert keys on. The plaintext token
    // is NEVER logged — only the error type/message + cache metadata.
    console.warn("llm-credentials refresh failed; serving stale cache", {
      rule: "bedrock-credentials-refresh-failed",
      role,
      error_type: errorType(err),
      error: errorMessage(err),
      had_cache: priorEntry !== undefined,
      stale_for_seconds: Math.trunc(staleForSeconds),
    });

    // No prior cache → caller has nothing to fall back to. Fail-closed immediately.
    if (priorEntry === undefined) {
      throw new LlmCredentialsExpiredError(
        `initial llm credentials fetch failed for role=${role}: ${errorType(err)}: ${errorMessage(err)}`,
      );
    }

    // Hard-stale window exceeded → fail-closed.
    if (staleForSeconds > this.hardStaleSeconds) {
      throw new LlmCredentialsExpiredError(
        `llm credentials refresh has been failing for ${Math.trunc(staleForSeconds)}s ` +
          `(hard-stale threshold ${this.hardStaleSeconds}s) for role=${role}`,
      );
    }

    // Within the hard-stale window — serve the stale cache. The caller is unaware; the warning log +
    // alert is the operator-side signal.
    return priorEntry.creds;
  }

  /**
   * Test-only: reset the cache so the next call refetches. Used by integration tests that verify a
   * fresh fetch picks up a UI-driven rotation. Mirrors the Python `_reset_cache_for_testing`.
   */
  public resetCacheForTesting(): void {
    this.cached.clear();
    this.lastRefreshFailedAt.clear();
  }
}

// ─── Error introspection helpers (thrown values are `unknown` in TS) ───────────────────────────

/** The constructor-name analogue of Python's `type(err).__name__`. */
function errorType(err: unknown): string {
  if (err instanceof Error) {
    return err.name;
  }
  return typeof err;
}

/** The message analogue of Python's `str(err)`. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
