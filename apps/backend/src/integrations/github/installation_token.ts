/**
 * GitHub installation-token exchange + cache — 1:1 port of
 * `codemaster/integrations/github/installation_token.py` (frozen Python, Sprint 4 / S4.1.1).
 *
 * Exchanges an App-level JWT (from `app_jwt.signAppJwt`) for a 1-hour installation token via
 * `POST /app/installations/{id}/access_tokens`. The token is what {@link GitHubApiClient} uses to
 * act on behalf of the installation.
 *
 * In-memory cache scoped per `installationId`; entries are treated as stale at
 * `expires_at - INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS` so we never present a token within seconds
 * of its expiry. Concurrent calls for the SAME installation are serialized via a per-installation
 * async lock (the {@link KeyedMutex}) — Python uses `asyncio.Lock`; JS has no built-in, so the lock is
 * a promise tail-chain keyed by `installationId` (NO `setTimeout`, NO wall-clock).
 *
 * --- Injected seams (everything non-deterministic is injected) ---
 *   - `clock`: the cache's "now" is the injected {@link Clock} (`clock.now()`), NEVER `Date.now()` —
 *     the check_clock_random gate enforces this and tests advance a {@link FakeClock} to drive the
 *     30s-margin boundary.
 *   - `http`: the HTTP transport. Production passes a `fetch`-backed {@link GitHubHttpClient}; tests
 *     pass the `CassetteHttpClient` (its `request` signature + `{ status, headers, body_text }` return
 *     shape are a structural match for {@link GitHubHttpClient}).
 *
 * Port fidelity notes vs the Python:
 *   - The Python `_AsyncHttpClient.post(url, *, headers, timeout)` is adapted onto the cassette-shaped
 *     `GitHubHttpClient.request({ method, url, headers, text_body })` (the same adapter the api_client
 *     port uses). The token-exchange POST carries an EMPTY body, so it passes `text_body: ""` (matching
 *     the recorded cassette's `body: ""`).
 *   - `InstallationTokenV1` lives inline in the Python module; here it is the ported Zod contract from
 *     `#contracts/installation_token.v1`.
 *   - `GitHubAppUnauthorized` is REUSED from `#backend/integrations/github/api_client` (the same error
 *     type the api_client raises on a twice-401), so callers catch one symbol.
 */

import {
  InstallationTokenV1 as InstallationTokenV1Schema,
  type InstallationTokenV1,
} from "#contracts/installation_token.v1.js";

import { type Clock } from "#platform/clock.js";

import {
  GitHubAppUnauthorized,
  type GitHubHttpClient,
} from "#backend/integrations/github/api_client.js";

// ─── Constants (1:1 with the frozen Python module constants) ──────────────────────────────────

/** Evict (treat as stale) at `expires_at - 30s` so a token is never presented near its expiry. */
export const INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS = 30;
/** The exchange path; `{installation_id}` is substituted at call time. */
export const INSTALLATION_TOKEN_HTTP_PATH =
  "/app/installations/{installation_id}/access_tokens";

const DEFAULT_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_ACCEPT = "application/vnd.github+json";

// HTTP status sentinels (mirroring the Python literals).
const HTTP_UNAUTHORIZED = 401;
const HTTP_CLIENT_ERROR_FLOOR = 400;

const MS_PER_SECOND = 1000;

export { GitHubAppUnauthorized } from "#backend/integrations/github/api_client.js";
export { type InstallationTokenV1 } from "#contracts/installation_token.v1.js";

// ─── Per-key async lock (the asyncio.Lock analogue — the load-bearing concurrency piece) ──────

/**
 * A keyed mutex: serializes async sections that share a key while letting different keys run
 * concurrently. JS has no `asyncio.Lock`, so each key holds the tail of a promise CHAIN — a new
 * acquirer awaits the previous tail, and `release()` settles its own slot so the next waiter proceeds.
 *
 * Promise-only by construction: NO `setTimeout`, NO wall-clock — so the check_clock_random gate is
 * satisfied and the ordering is purely event-loop microtask scheduling.
 *
 * Usage:
 *   const release = await mutex.acquire(key);
 *   try { ...critical section... } finally { release(); }
 */
export class KeyedMutex<K> {
  // Per key: the promise that resolves when the CURRENT holder releases. Absent ⇒ uncontended.
  private readonly tails = new Map<K, Promise<void>>();

  /**
   * Acquire the lock for `key`. Resolves once this caller holds it; the returned `release` MUST be
   * called (in a `finally`) to hand the lock to the next waiter.
   */
  public async acquire(key: K): Promise<() => void> {
    // The previous tail (the lock held by whoever is ahead of us); resolved/absent ⇒ we go immediately.
    const previous = this.tails.get(key) ?? Promise.resolve();

    // Our own slot: the next acquirer will await `ours`, and we settle it via `release`.
    let release: () => void = () => {};
    const ours = new Promise<void>((resolve) => {
      release = (): void => {
        // Drop our tail from the map only if we are still the LAST link (no one chained after us),
        // so the map doesn't leak a settled promise for an idle key.
        if (this.tails.get(key) === ours) this.tails.delete(key);
        resolve();
      };
    });
    this.tails.set(key, ours);

    // Wait for everyone ahead of us to release before we are considered the holder.
    await previous;
    return release;
  }
}

// ─── The cache ────────────────────────────────────────────────────────────────────────────────

/**
 * Per-installation in-memory cache; treats an entry as stale at `expires_at - 30s`.
 *
 * The store is a plain `Map<number, InstallationTokenV1>` (the Python `_store` dict). The
 * per-installation lock is the {@link KeyedMutex} (the Python `_locks` dict of `asyncio.Lock`); it is
 * exposed via {@link lockFor} so {@link getInstallationToken} can serialize the exchange.
 */
export class InstallationTokenCache {
  private readonly clock: Clock;
  private readonly store = new Map<number, InstallationTokenV1>();
  private readonly mutex = new KeyedMutex<number>();

  public constructor(clock: Clock) {
    this.clock = clock;
  }

  /** Acquire the per-installation exchange lock (the `asyncio.Lock` analogue). */
  public acquireLock(installationId: number): Promise<() => void> {
    return this.mutex.acquire(installationId);
  }

  /**
   * Return the cached token if it is still fresh, else `null`. Fresh ⇔
   * `expires_at - 30s > now` (Python: returns `None` when `expires_at - margin <= now`). The
   * comparison uses the INJECTED clock; both sides are absolute UTC instants.
   */
  public getFresh(installationId: number): InstallationTokenV1 | null {
    const cached = this.store.get(installationId);
    if (cached === undefined) return null;
    const expiresMs = new Date(cached.expires_at).getTime();
    const marginMs = INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS * MS_PER_SECOND;
    const nowMs = this.clock.now().getTime();
    // Python: `cached.expires_at - margin <= now` ⇒ stale (miss). The `<=` makes the exact
    // `expires_at - 30s` boundary a MISS.
    if (expiresMs - marginMs <= nowMs) return null;
    return cached;
  }

  public put(installationId: number, token: InstallationTokenV1): void {
    this.store.set(installationId, token);
  }

  public invalidate(installationId: number): void {
    this.store.delete(installationId);
  }
}

// ─── The exchange ─────────────────────────────────────────────────────────────────────────────

/**
 * Return a live installation token; cache hits skip the round trip. Concurrent calls for the SAME
 * installation are serialized via the per-installation lock, and the double-check inside the lock
 * makes all-but-one waiter return the just-refreshed cached value (exactly ONE HTTP exchange).
 */
export async function getInstallationToken({
  installationId,
  jwtToken,
  http,
  cache,
  baseUrl = DEFAULT_BASE_URL,
}: {
  installationId: number;
  jwtToken: string;
  http: GitHubHttpClient;
  cache: InstallationTokenCache;
  baseUrl?: string;
}): Promise<InstallationTokenV1> {
  const cached = cache.getFresh(installationId);
  if (cached !== null) return cached;

  const release = await cache.acquireLock(installationId);
  try {
    // Re-check inside the lock — another waiter may have just refreshed.
    const fresh = cache.getFresh(installationId);
    if (fresh !== null) return fresh;

    const url =
      baseUrl + INSTALLATION_TOKEN_HTTP_PATH.replace("{installation_id}", String(installationId));
    const resp = await http.request({
      method: "POST",
      url,
      headers: {
        Accept: DEFAULT_ACCEPT,
        Authorization: `Bearer ${jwtToken}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      // The token-exchange POST carries an EMPTY body (matches the recorded cassette's `body: ""`).
      text_body: "",
    });

    if (resp.status === HTTP_UNAUTHORIZED) {
      throw new GitHubAppUnauthorized(
        `GitHub returned 401 for installation_id=${installationId}; ` +
          "check clock skew, App suspension, or rotated private key",
      );
    }
    if (resp.status >= HTTP_CLIENT_ERROR_FLOOR) {
      throw new GitHubAppUnauthorized(
        `GitHub returned ${resp.status} for installation_id=${installationId}`,
      );
    }

    const body = JSON.parse(resp.body_text ?? "") as { token: string; expires_at: string };
    const token = InstallationTokenV1Schema.parse({
      token: body.token,
      // Python: `datetime.fromisoformat(expires_at.replace("Z", "+00:00"))`. We keep the ISO string in
      // the contract; normalize the trailing `Z` to `+00:00` so the stored value is offset-bearing.
      expires_at: body.expires_at.replace("Z", "+00:00"),
    });
    cache.put(installationId, token);
    return token;
  } finally {
    release();
  }
}
