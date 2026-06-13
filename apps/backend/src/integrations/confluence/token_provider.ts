/**
 * ConfluenceTokenProvider — Vault-backed single-token Confluence credential provider.
 *   - No per-installation fan-out (single platform-wide bearer token); no installation_id arg.
 *   - Background refresh loop (every 30 min ± jitter), driven through the injected {@link Clock} sleep.
 *   - Runtime refresh failure is fail-OPEN (keep serving the cached token).
 *   - Startup is fail-HARD (from_vault raises if the Vault read / schema validation fails).
 *
 * The architectural choice is deliberate: a transient Vault outage must NOT cascade into a total
 * Confluence sync outage, because Confluence bearer tokens have multi-day lifetimes and the cached
 * value is almost certainly still valid through the outage window.
 *
 * --- Injected seams (everything non-deterministic is injected) ---
 *   - `vault`: the {@link VaultPort} KV reader (the secret lives at {@link VAULT_KV_PATH}).
 *   - `clock`: ALL timing — the refresh-loop `sleep`, the `monotonic` token-age axis, and the `now`
 *     wall-clock timestamp — goes through the injected {@link Clock}, NEVER `setTimeout`/`Date`.
 *   - `jitterRng`: the {@link Random} seam for anti-storm refresh jitter (default {@link SystemRandom}).
 *
 * NOTE ON ENV FALLBACK: this is Vault-ONLY (no env fallback). The env-fallback path lives in the
 * worker-bootstrap composition root. The `recordEnvFallbackUsed` counter lives in
 * `#backend/observability/confluence_token_metrics.js` for the eventual bootstrap caller to wire.
 */

import { type Clock } from "#platform/clock.js";
import { type Random, SystemRandom } from "#platform/randomness.js";

import { type VaultPort } from "#backend/adapters/vault_port.js";
import * as metrics from "#backend/observability/confluence_token_metrics.js";

// ─── Operational defaults (locked per plan doc) ───────────────────────────────────────────────────

/** Mirrors the GitHub Vault refresh cadence (ADR-0033). */
const REFRESH_INTERVAL_SECONDS = 1800; // 30 min
/** Anti-storm jitter: ±5 min uniform around the refresh interval. */
const JITTER_RANGE_SECONDS = 300;
/** Alarm threshold: transient Vault outages (one or two missed refreshes) shouldn't fire the stale-warning. */
const STALE_WARNING_SECONDS = 7200; // 2 hours
/** Exponential backoff for runtime refresh failures. */
const BACKOFF_INITIAL_SECONDS = 60.0;
const BACKOFF_MAX_SECONDS = 600.0; // 10 min
/** Vault KV path. Mirrors `codemaster/github/app`. */
export const VAULT_KV_PATH = "codemaster/confluence/token";

/** Vault payload schema. The secret stored under VAULT_KV_PATH MUST contain these keys. */
const REQUIRED_VAULT_KEYS: ReadonlyArray<string> = ["base_url", "token"];

const MIN_REFRESH_INTERVAL_SECONDS = 60;

// ─── Errors ───────────────────────────────────────────────────────────────────────────────────────

/** Base class for ConfluenceTokenProvider failures. */
export class ConfluenceTokenError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfluenceTokenError";
  }
}

/** Non-retryable: missing keys at the Vault path, malformed secret. */
export class PermanentConfluenceTokenError extends ConfluenceTokenError {
  public constructor(message: string) {
    super(message);
    this.name = "PermanentConfluenceTokenError";
  }
}

/** Retryable: Vault timeout, network blip, transient 5xx. */
export class TransientConfluenceTokenError extends ConfluenceTokenError {
  public constructor(message: string) {
    super(message);
    this.name = "TransientConfluenceTokenError";
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────────────────────────

export type ConfluenceTokenProviderOptions = {
  vault: VaultPort;
  clock: Clock;
  refreshIntervalSeconds?: number;
  jitterRangeSeconds?: number;
  staleWarningSeconds?: number;
  backoffInitialSeconds?: number;
  backoffMaxSeconds?: number;
  vaultPath?: string;
  /** Test seam: deterministic jitter. Default {@link SystemRandom} (unpredictable across pods). */
  jitterRng?: Random;
};

export class ConfluenceTokenProvider {
  private readonly vault: VaultPort;
  private readonly clock: Clock;
  private readonly refreshInterval: number;
  private readonly jitterRange: number;
  private readonly staleWarning: number;
  private readonly backoffInitial: number;
  private readonly backoffMax: number;
  private readonly vaultPath: string;
  private readonly rng: Random;

  // Cached state — set by the initial _refresh_once on from_vault.
  private token: string | null = null;
  private baseUrlValue: string | null = null;
  // Optional Atlassian Cloud account email → selects HTTP-Basic auth downstream. Not a required key.
  private authEmailValue: string | null = null;
  private lastRefreshAtMonotonic: number | null = null;
  private lastRefreshWallTs: number | null = null;
  private consecutiveFailuresValue = 0;
  private refreshTask: Promise<void> | null = null;
  private stopped = false;

  public constructor({
    vault,
    clock,
    refreshIntervalSeconds = REFRESH_INTERVAL_SECONDS,
    jitterRangeSeconds = JITTER_RANGE_SECONDS,
    staleWarningSeconds = STALE_WARNING_SECONDS,
    backoffInitialSeconds = BACKOFF_INITIAL_SECONDS,
    backoffMaxSeconds = BACKOFF_MAX_SECONDS,
    vaultPath = VAULT_KV_PATH,
    jitterRng,
  }: ConfluenceTokenProviderOptions) {
    if (refreshIntervalSeconds < MIN_REFRESH_INTERVAL_SECONDS) {
      throw new Error(
        `refreshIntervalSeconds must be >= ${MIN_REFRESH_INTERVAL_SECONDS}, got ${refreshIntervalSeconds}`,
      );
    }
    if (jitterRangeSeconds < 0) {
      throw new Error(`jitterRangeSeconds must be >= 0, got ${jitterRangeSeconds}`);
    }
    if (backoffMaxSeconds < backoffInitialSeconds) {
      throw new Error("backoffMaxSeconds must be >= backoffInitialSeconds");
    }
    this.vault = vault;
    this.clock = clock;
    this.refreshInterval = refreshIntervalSeconds;
    this.jitterRange = jitterRangeSeconds;
    this.staleWarning = staleWarningSeconds;
    this.backoffInitial = backoffInitialSeconds;
    this.backoffMax = backoffMaxSeconds;
    this.vaultPath = vaultPath;
    this.rng = jitterRng ?? new SystemRandom();
  }

  // ─── Construction ───────────────────────────────────────────────────────────────────────────

  /**
   * Construct + perform the initial Vault read (1:1 with `from_vault`). Startup fail-hard: any Vault
   * error or schema violation rejects and the caller (worker bootstrap) lets it propagate so the pod
   * fails to start; kubelet retries with backoff.
   */
  public static async fromVault(opts: ConfluenceTokenProviderOptions): Promise<ConfluenceTokenProvider> {
    const provider = new ConfluenceTokenProvider(opts);
    await provider.refreshOnce({ isStartup: true });
    return provider;
  }

  // ─── Public accessors ───────────────────────────────────────────────────────────────────────

  /**
   * Return the current cached bearer token (1:1 with `get_token`). Always returns the cached value —
   * never blocks on a Vault read in the hot path.
   */
  public async getToken(): Promise<string> {
    await Promise.resolve();
    if (this.token === null) {
      throw new PermanentConfluenceTokenError(
        "ConfluenceTokenProvider used before fromVault completed",
      );
    }
    return this.token;
  }

  public get baseUrl(): string {
    if (this.baseUrlValue === null) {
      throw new PermanentConfluenceTokenError(
        "ConfluenceTokenProvider used before fromVault completed",
      );
    }
    return this.baseUrlValue;
  }

  /** Cloud account email (HTTP Basic auth) when configured; null for Bearer-PAT deployments. */
  public get authEmail(): string | null {
    return this.authEmailValue;
  }

  public get tokenAgeSeconds(): number {
    if (this.lastRefreshAtMonotonic === null) return Number.POSITIVE_INFINITY;
    return this.clock.monotonic() - this.lastRefreshAtMonotonic;
  }

  public get lastRefreshAtWallTs(): number | null {
    return this.lastRefreshWallTs;
  }

  public get consecutiveFailures(): number {
    return this.consecutiveFailuresValue;
  }

  // ─── Refresh loop ─────────────────────────────────────────────────────────────────────────────

  /** Start the background refresh task. Idempotent (1:1 with `start_refresh_loop`). */
  public startRefreshLoop(): void {
    if (this.refreshTask !== null) return;
    this.stopped = false;
    this.refreshTask = this.refreshLoop();
  }

  /** Cancel the refresh loop. Idempotent (1:1 with `stop`). */
  public async stop(): Promise<void> {
    this.stopped = true;
    const task = this.refreshTask;
    this.refreshTask = null;
    if (task !== null) {
      // The loop checks `stopped` after each sleep returns; with a real clock the in-flight sleep
      // resolves on its own timer. Awaiting drains the loop to completion.
      await task;
    }
  }

  private async refreshLoop(): Promise<void> {
    while (!this.stopped) {
      await this.clock.sleep(this.nextSleepSeconds());
      if (this.stopped) break;
      try {
        await this.refreshOnce({ isStartup: false });
      } catch {
        // refreshOnce handles its own logging/metrics; this catch exists only so a never-classified
        // exception can't kill the background loop.
      }
    }
  }

  /** Compute the next sleep interval with jitter or backoff (1:1 with `_next_sleep_seconds`). */
  private nextSleepSeconds(): number {
    if (this.consecutiveFailuresValue > 0) {
      // Exponential backoff after a failure.
      const backoff = Math.min(
        this.backoffInitial * 2 ** (this.consecutiveFailuresValue - 1),
        this.backoffMax,
      );
      // Add jitter to the backoff too (no synchronized retry storms).
      return backoff + this.rng.uniform(0, backoff / 4);
    }
    // Normal refresh interval ± jitter.
    const jitter = this.rng.uniform(-this.jitterRange, this.jitterRange);
    return this.refreshInterval + jitter;
  }

  /**
   * Read from Vault and update cached state (1:1 with `_refresh_once`). Startup mode rejects on failure
   * (fail-hard). Runtime mode records the metric + keeps the cached value (fail-open).
   */
  private async refreshOnce({ isStartup }: { isStartup: boolean }): Promise<void> {
    let secret: Record<string, string>;
    try {
      secret = await this.vault.kvRead({ path: this.vaultPath });
    } catch {
      if (isStartup) {
        throw new TransientConfluenceTokenError(`Vault read failed at ${this.vaultPath}`);
      }
      // Runtime: fail-open.
      this.consecutiveFailuresValue += 1;
      metrics.recordRefresh({ outcome: "failure" });
      this.maybeEmitStaleWarning();
      return;
    }

    // Validate payload.
    const missing = REQUIRED_VAULT_KEYS.filter((k) => !(k in secret));
    if (missing.length > 0) {
      this.handleValidationError(
        `Vault payload at ${this.vaultPath} missing keys: ${[...missing].sort().join(", ")}`,
        isStartup,
      );
      return;
    }

    const baseUrl = secret["base_url"];
    const token = secret["token"];
    if (typeof baseUrl !== "string" || typeof token !== "string") {
      this.handleValidationError(
        `Vault payload at ${this.vaultPath} has non-string values`,
        isStartup,
      );
      return;
    }
    if (baseUrl === "" || token === "") {
      this.handleValidationError(`Vault payload at ${this.vaultPath} has empty values`, isStartup);
      return;
    }

    // Success path.
    this.token = token;
    this.baseUrlValue = baseUrl.replace(/\/+$/, "");
    // Optional email → selects Cloud HTTP-Basic auth downstream. Ignore non-string / empty (stay Bearer).
    const email = secret["email"];
    this.authEmailValue = typeof email === "string" && email !== "" ? email : null;
    this.lastRefreshAtMonotonic = this.clock.monotonic();
    this.lastRefreshWallTs = this.clock.now().getTime() / 1000;
    this.consecutiveFailuresValue = 0;
    metrics.recordRefresh({ outcome: "success" });
    metrics.updateAgeGauge({ refreshTimestamp: this.lastRefreshWallTs });
  }

  /** Test-only — drive one refresh cycle without scheduling the loop. */
  public async refreshOnceForTest(): Promise<void> {
    await this.refreshOnce({ isStartup: false });
  }

  private handleValidationError(msg: string, isStartup: boolean): void {
    if (isStartup) {
      throw new PermanentConfluenceTokenError(msg);
    }
    this.consecutiveFailuresValue += 1;
    metrics.recordRefresh({ outcome: "failure" });
  }

  private maybeEmitStaleWarning(): void {
    const age = this.tokenAgeSeconds;
    if (age === Number.POSITIVE_INFINITY) return;
    if (age > this.staleWarning) {
      // The Python logs a structured warning here; the log seam is the bootstrap layer's concern. The
      // observable signal (consecutive_failures + token_age) is exposed via the accessors above.
    }
  }
}
