/**
 * Unit tests for the TS installation-token cache + exchange — the 1:1 port of
 * `codemaster/integrations/github/installation_token.py` (frozen Python, Sprint 4 / S4.1.1).
 *
 * The cache's "now" is the injected {@link FakeClock}; the HTTP transport is either the deterministic
 * {@link CassetteHttpClient} (replaying the recorded success exchange) or a counting stub (to assert
 * the exactly-one-exchange concurrency invariant). NO DB — the Python cache is an in-memory dict.
 *
 * Coverage:
 *   - getFresh:        far-future expiry → HIT; within 30s of expiry → MISS; exactly at the
 *                      `expires_at - 30s` boundary → MISS (the `<=` semantics).
 *   - getInstallationToken: cache miss → exchange (cassette) + cache; second call → cache HIT (no
 *                      second exchange).
 *   - concurrency:     N=10 concurrent calls for the SAME installation → EXACTLY 1 exchange (lock +
 *                      double-check); two DIFFERENT installations concurrently → 2 exchanges.
 *   - errors:          401 → GitHubAppUnauthorized; other 4xx → GitHubAppUnauthorized.
 *   - parsing:         the GitHub `Z`-suffixed expires_at is normalized to `+00:00` in the cached
 *                      contract.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { CassetteHttpClient } from "#backend/infra/cassettes.js";
import {
  type GitHubHttpClient,
  type GitHubHttpResponse,
} from "#backend/integrations/github/api_client.js";

import { InstallationTokenV1 } from "#contracts/installation_token.v1.js";

import {
  GitHubAppUnauthorized,
  INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS,
  InstallationTokenCache,
  getInstallationToken,
} from "#backend/integrations/github/installation_token.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// test/unit/integrations/github -> test/cassettes/github
const GH_CASSETTES = resolve(HERE, "..", "..", "..", "cassettes", "github");

function successCassette(): CassetteHttpClient {
  return CassetteHttpClient.fromPath(resolve(GH_CASSETTES, "installation_token_success.yaml"));
}

const INSTALLATION_ID = 12345;
// The instant at which the recorded cassette's token expires.
const EXPIRES_AT = new Date("2026-05-02T13:00:00.000Z");
// A clock instant well before expiry (and well outside the 30s margin) → a fetched token is fresh.
const BEFORE_EXPIRY = new Date("2026-05-02T12:00:00.000Z");

/** A counting HTTP stub: returns a canned 201 token exchange and records its call count + delays. */
function countingHttp(options?: {
  status?: number;
  bodyText?: string | null;
  delayResolutions?: number;
}): { http: GitHubHttpClient; calls: () => number; pending: () => Array<() => void> } {
  let calls = 0;
  const releasers: Array<() => void> = [];
  const status = options?.status ?? 201;
  const bodyText =
    options?.bodyText ??
    JSON.stringify({ token: "ghs_counted", expires_at: "2026-05-02T13:00:00Z" });
  const http: GitHubHttpClient = {
    async request(): Promise<GitHubHttpResponse> {
      calls += 1;
      // Optionally hold the response open so concurrent callers all pile up on the lock before ANY
      // exchange completes — the strongest test of the double-check (if it raced, we'd see >1 call).
      if (options?.delayResolutions) {
        await new Promise<void>((res) => releasers.push(res));
      } else {
        await Promise.resolve();
      }
      return { status, headers: {}, body_text: bodyText };
    },
  };
  return { http, calls: () => calls, pending: () => releasers };
}

describe("InstallationTokenCache.getFresh — 30s margin boundary", () => {
  it("returns the cached token when expiry is far in the future (HIT)", () => {
    const clock = new FakeClock({ now: BEFORE_EXPIRY });
    const cache = new InstallationTokenCache(clock);
    const token = InstallationTokenV1.parse({ token: "ghs_x", expires_at: EXPIRES_AT.toISOString() });
    cache.put(INSTALLATION_ID, token);

    expect(cache.getFresh(INSTALLATION_ID)).toEqual(token);
  });

  it("returns null within the 30s margin (advance to expires-29s) → MISS", () => {
    const clock = new FakeClock({
      now: new Date(EXPIRES_AT.getTime() - 29 * 1000),
    });
    const cache = new InstallationTokenCache(clock);
    cache.put(
      INSTALLATION_ID,
      InstallationTokenV1.parse({ token: "ghs_x", expires_at: EXPIRES_AT.toISOString() }),
    );

    expect(cache.getFresh(INSTALLATION_ID)).toBeNull();
  });

  it("returns null EXACTLY at the expires-30s boundary (the <= semantics) → MISS", () => {
    const clock = new FakeClock({
      now: new Date(EXPIRES_AT.getTime() - INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS * 1000),
    });
    const cache = new InstallationTokenCache(clock);
    cache.put(
      INSTALLATION_ID,
      InstallationTokenV1.parse({ token: "ghs_x", expires_at: EXPIRES_AT.toISOString() }),
    );

    expect(cache.getFresh(INSTALLATION_ID)).toBeNull();
  });

  it("returns the token one second BEFORE the boundary (expires-31s) → HIT", () => {
    const clock = new FakeClock({
      now: new Date(EXPIRES_AT.getTime() - 31 * 1000),
    });
    const cache = new InstallationTokenCache(clock);
    const token = InstallationTokenV1.parse({ token: "ghs_x", expires_at: EXPIRES_AT.toISOString() });
    cache.put(INSTALLATION_ID, token);

    expect(cache.getFresh(INSTALLATION_ID)).toEqual(token);
  });

  it("returns null for an installation never cached", () => {
    const cache = new InstallationTokenCache(new FakeClock());
    expect(cache.getFresh(INSTALLATION_ID)).toBeNull();
  });

  it("invalidate() drops the entry", () => {
    const clock = new FakeClock({ now: BEFORE_EXPIRY });
    const cache = new InstallationTokenCache(clock);
    cache.put(
      INSTALLATION_ID,
      InstallationTokenV1.parse({ token: "ghs_x", expires_at: EXPIRES_AT.toISOString() }),
    );
    cache.invalidate(INSTALLATION_ID);
    expect(cache.getFresh(INSTALLATION_ID)).toBeNull();
  });
});

describe("getInstallationToken — exchange + cache", () => {
  it("performs the exchange on a cache miss, caches it, and HITs on the second call (one exchange)", async () => {
    const clock = new FakeClock({ now: BEFORE_EXPIRY });
    const cache = new InstallationTokenCache(clock);
    const http = successCassette();

    const first = await getInstallationToken({
      installationId: INSTALLATION_ID,
      jwtToken: "jwt-abc",
      http,
      cache,
    });
    expect(first.token).toBe("ghs_redactedtokenvalue");
    // GitHub's `Z` suffix is normalized to `+00:00` in the cached contract.
    expect(first.expires_at).toBe("2026-05-02T13:00:00+00:00");
    // The cassette recorded exactly one interaction → it was consumed.
    http.assertFullyConsumed();

    // Second call: cache HIT — does NOT touch http (the cassette is exhausted; another call would throw).
    const second = await getInstallationToken({
      installationId: INSTALLATION_ID,
      jwtToken: "jwt-abc",
      http,
      cache,
    });
    expect(second).toEqual(first);
  });

  it("raises GitHubAppUnauthorized on a 401", async () => {
    const clock = new FakeClock({ now: BEFORE_EXPIRY });
    const cache = new InstallationTokenCache(clock);
    const { http } = countingHttp({ status: 401, bodyText: "unauthorized" });

    await expect(
      getInstallationToken({ installationId: INSTALLATION_ID, jwtToken: "jwt", http, cache }),
    ).rejects.toBeInstanceOf(GitHubAppUnauthorized);
  });

  it("raises GitHubAppUnauthorized on another 4xx (e.g. 404)", async () => {
    const clock = new FakeClock({ now: BEFORE_EXPIRY });
    const cache = new InstallationTokenCache(clock);
    const { http } = countingHttp({ status: 404, bodyText: "not found" });

    await expect(
      getInstallationToken({ installationId: INSTALLATION_ID, jwtToken: "jwt", http, cache }),
    ).rejects.toBeInstanceOf(GitHubAppUnauthorized);
  });
});

describe("getInstallationToken — per-installation lock (thundering herd)", () => {
  it("fires N=10 concurrent calls for the SAME installation → EXACTLY 1 exchange", async () => {
    const clock = new FakeClock({ now: BEFORE_EXPIRY });
    const cache = new InstallationTokenCache(clock);
    // delayResolutions: hold ALL responses open so every concurrent caller is blocked on the lock
    // BEFORE the single exchange resolves; if the double-check raced, we'd observe >1 call.
    const { http, calls, pending } = countingHttp({ delayResolutions: 1 });

    const inFlight = Array.from({ length: 10 }, () =>
      getInstallationToken({ installationId: INSTALLATION_ID, jwtToken: "jwt", http, cache }),
    );

    // Let the microtask queue drain so the lone exchange call registers (and the rest queue on the lock).
    await new Promise<void>((res) => setImmediate(res));
    // Exactly ONE caller got past the lock + double-check into the http exchange.
    expect(calls()).toBe(1);

    // Release the held exchange → all 10 resolve to the SAME cached token.
    for (const release of pending()) release();
    const results = await Promise.all(inFlight);

    expect(calls()).toBe(1);
    for (const r of results) expect(r.token).toBe("ghs_counted");
  });

  it("fires concurrent calls for TWO different installations → 2 exchanges (independent locks)", async () => {
    const clock = new FakeClock({ now: BEFORE_EXPIRY });
    const cache = new InstallationTokenCache(clock);
    const { http, calls, pending } = countingHttp({ delayResolutions: 1 });

    const a = getInstallationToken({ installationId: 111, jwtToken: "jwt", http, cache });
    const b = getInstallationToken({ installationId: 222, jwtToken: "jwt", http, cache });

    await new Promise<void>((res) => setImmediate(res));
    // Different installations have independent locks → both proceed to the exchange concurrently.
    expect(calls()).toBe(2);

    for (const release of pending()) release();
    await Promise.all([a, b]);
    expect(calls()).toBe(2);
  });

  it("serializes same-installation calls but the FIRST result is reused by the rest (cache hit)", async () => {
    const clock = new FakeClock({ now: BEFORE_EXPIRY });
    const cache = new InstallationTokenCache(clock);
    const { http, calls } = countingHttp();

    const [r1, r2, r3] = await Promise.all([
      getInstallationToken({ installationId: INSTALLATION_ID, jwtToken: "jwt", http, cache }),
      getInstallationToken({ installationId: INSTALLATION_ID, jwtToken: "jwt", http, cache }),
      getInstallationToken({ installationId: INSTALLATION_ID, jwtToken: "jwt", http, cache }),
    ]);

    expect(calls()).toBe(1);
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });
});
