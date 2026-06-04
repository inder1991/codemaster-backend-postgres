/**
 * Unit tests for the TS GitHubApiClient — the 1:1 port of
 * `codemaster/integrations/github/api_client.py` (frozen Python, Sprint 5 / S5.1.2 +).
 *
 * The HTTP transport is the injected `CassetteHttpClient` (the deterministic replay double built in
 * task 2.8); ALL timing is the injected `FakeClock` so the backoff sleeps are asserted via
 * `recordedSleeps()` — never real wall-clock waits. The `tokenProvider` is an in-memory function
 * whose call count we assert (the 401-refresh-once semantics).
 *
 * Coverage (the byte-significant `_request` decisions, each exercised against a real cassette):
 *   (a) 5xx-then-200      → retries, ONE backoff sleep of 0.5s, returns the 200 envelope.
 *   (b) 5xx exhausted     → MAX_5XX_RETRIES attempts, sleeps [0.5, 1.0], raises GitHubApiUnavailableError.
 *   (c) 401-then-200      → refreshes the token ONCE (provider called twice), retries, succeeds.
 *   (d) 401-then-401      → refresh does NOT repeat (provider called twice TOTAL), raises GitHubAppUnauthorized.
 *   (e) rate-limit window → a SUCCESSFUL 200 with X-RateLimit-Remaining:0 raises GitHubRateLimitExceeded
 *                            carrying reset_at (the frozen Python `maybe_raise_for_window` behaviour —
 *                            it RAISES, it does not block-and-wait; the reset instant is surfaced for
 *                            the Temporal layer to reschedule on).
 *   (f) secondary 403     → raises GitHubRateLimitExceeded carrying the parsed Retry-After.
 *   (g) happy GET         → replays the real get_pr.yaml cassette end-to-end into the envelope.
 *   (h) get files         → paginated single-page replay of get_pr_files.yaml.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { CassetteHttpClient } from "#backend/infra/cassettes.js";

import {
  GitHubApiClient,
  GitHubApiUnavailableError,
  GitHubAppUnauthorized,
  GitHubRateLimitExceeded,
  INITIAL_BACKOFF_SECONDS,
  MAX_5XX_RETRIES,
  type TokenProvider,
} from "#backend/integrations/github/api_client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// test/unit/integrations/github -> test/cassettes/github
const GH_CASSETTES = resolve(HERE, "..", "..", "..", "cassettes", "github");

function cassetteClient(name: string): CassetteHttpClient {
  return CassetteHttpClient.fromPath(resolve(GH_CASSETTES, name));
}

/** An in-memory token provider that yields a sequence of tokens and records its call count. */
function recordingTokenProvider(tokens: ReadonlyArray<string>): {
  provider: TokenProvider;
  calls: () => number;
} {
  let i = 0;
  const provider: TokenProvider = async () => {
    await Promise.resolve();
    const token = tokens[Math.min(i, tokens.length - 1)]!;
    i += 1;
    return token;
  };
  return { provider, calls: () => i };
}

const INSTALLATION_ID = 12345;

describe("GitHubApiClient — 5xx retry/backoff", () => {
  it("(a) retries a 503 then returns the 200; records exactly one 0.5s backoff sleep", async () => {
    const http = cassetteClient("server_error_then_ok.yaml");
    const clock = new FakeClock();
    const { provider, calls } = recordingTokenProvider(["tok"]);
    const client = new GitHubApiClient({ tokenProvider: provider, http, clock });

    const pr = await client.getPullRequest({
      installationId: INSTALLATION_ID,
      owner: "acme",
      repo: "example",
      prNumber: 42,
    });

    expect(pr.number).toBe(42);
    expect(pr.title).toBe("recovered after 503");
    expect(pr.head_sha).toBe("rec1");
    // Exactly one retry happened → one backoff sleep at the INITIAL value.
    expect(clock.recordedSleeps()).toEqual([INITIAL_BACKOFF_SECONDS]);
    // Token fetched once at loop top; no 401 so no refresh.
    expect(calls()).toBe(1);
    http.assertFullyConsumed();
  });

  it("(b) raises GitHubApiUnavailableError after MAX_5XX_RETRIES; sleeps double 0.5→1.0", async () => {
    const http = cassetteClient("server_error_exhausted.yaml");
    const clock = new FakeClock();
    const { provider } = recordingTokenProvider(["tok"]);
    const client = new GitHubApiClient({ tokenProvider: provider, http, clock });

    await expect(
      client.getPullRequest({
        installationId: INSTALLATION_ID,
        owner: "acme",
        repo: "example",
        prNumber: 42,
      }),
    ).rejects.toBeInstanceOf(GitHubApiUnavailableError);

    // MAX_5XX_RETRIES attempts ⇒ MAX_5XX_RETRIES-1 sleeps, doubling from INITIAL_BACKOFF_SECONDS.
    expect(clock.recordedSleeps()).toEqual([
      INITIAL_BACKOFF_SECONDS,
      INITIAL_BACKOFF_SECONDS * 2,
    ]);
    expect(clock.recordedSleeps().length).toBe(MAX_5XX_RETRIES - 1);
    http.assertFullyConsumed();
  });
});

describe("GitHubApiClient — 401 refresh-once", () => {
  it("(c) 401-then-200 refreshes the token ONCE (provider called twice), retries, succeeds", async () => {
    const http = cassetteClient("401_token_invalid.yaml");
    const clock = new FakeClock();
    const { provider, calls } = recordingTokenProvider(["stale", "fresh"]);
    const client = new GitHubApiClient({ tokenProvider: provider, http, clock });

    const pr = await client.getPullRequest({
      installationId: INSTALLATION_ID,
      owner: "acme",
      repo: "example",
      prNumber: 42,
    });

    expect(pr.title).toBe("after refresh");
    // Called twice TOTAL: once at loop top, once on the single 401-refresh.
    expect(calls()).toBe(2);
    // A 401-refresh is NOT a 5xx backoff: no sleeps recorded.
    expect(clock.recordedSleeps()).toEqual([]);
    http.assertFullyConsumed();
  });

  it("(d) 401-then-401 does NOT refresh again (provider called twice total) and raises GitHubAppUnauthorized", async () => {
    const http = cassetteClient("401_twice_unauthorized.yaml");
    const clock = new FakeClock();
    const { provider, calls } = recordingTokenProvider(["stale", "also-stale", "never-used"]);
    const client = new GitHubApiClient({ tokenProvider: provider, http, clock });

    await expect(
      client.getPullRequest({
        installationId: INSTALLATION_ID,
        owner: "acme",
        repo: "example",
        prNumber: 42,
      }),
    ).rejects.toBeInstanceOf(GitHubAppUnauthorized);

    // First fetch + ONE refresh = 2; the second 401 raises WITHOUT a third fetch.
    expect(calls()).toBe(2);
    expect(clock.recordedSleeps()).toEqual([]);
    http.assertFullyConsumed();
  });
});

describe("GitHubApiClient — rate limit", () => {
  it("(e) a 200 with X-RateLimit-Remaining:0 raises GitHubRateLimitExceeded carrying reset_at", async () => {
    const http = cassetteClient("rate_limit_exceeded.yaml");
    const clock = new FakeClock();
    const { provider } = recordingTokenProvider(["tok"]);
    const client = new GitHubApiClient({ tokenProvider: provider, http, clock });

    let raised: GitHubRateLimitExceeded | null = null;
    try {
      await client.getPullRequest({
        installationId: INSTALLATION_ID,
        owner: "acme",
        repo: "example",
        prNumber: 42,
      });
    } catch (e) {
      if (e instanceof GitHubRateLimitExceeded) raised = e;
      else throw e;
    }

    expect(raised).not.toBeNull();
    expect(raised!.resource).toBe("core");
    // X-RateLimit-Reset: "1799999999" (epoch seconds) → that UTC instant.
    expect(raised!.resetAt.getTime()).toBe(1799999999 * 1000);
    // The rate-limit decision is RAISE, not block-and-wait → no clock sleep recorded.
    expect(clock.recordedSleeps()).toEqual([]);
    http.assertFullyConsumed();
  });

  it("(f) a 403 secondary-rate-limit body raises GitHubRateLimitExceeded with the Retry-After", async () => {
    const http = cassetteClient("secondary_rate_limit.yaml");
    const clock = new FakeClock();
    const { provider } = recordingTokenProvider(["tok"]);
    const client = new GitHubApiClient({ tokenProvider: provider, http, clock });

    let raised: GitHubRateLimitExceeded | null = null;
    try {
      await client.getPullRequest({
        installationId: INSTALLATION_ID,
        owner: "acme",
        repo: "example",
        prNumber: 42,
      });
    } catch (e) {
      if (e instanceof GitHubRateLimitExceeded) raised = e;
      else throw e;
    }

    expect(raised).not.toBeNull();
    expect(raised!.resource).toBe("secondary");
    expect(raised!.retryAfterSeconds).toBe(30);
    http.assertFullyConsumed();
  });
});

describe("GitHubApiClient — happy-path cassette replay", () => {
  it("(g) replays get_pr.yaml into a PullRequestEnvelopeV1", async () => {
    const http = cassetteClient("get_pr.yaml");
    const clock = new FakeClock();
    const { provider } = recordingTokenProvider(["tok"]);
    const client = new GitHubApiClient({ tokenProvider: provider, http, clock });

    const pr = await client.getPullRequest({
      installationId: INSTALLATION_ID,
      owner: "acme",
      repo: "example",
      prNumber: 42,
    });

    expect(pr.number).toBe(42);
    expect(pr.state).toBe("open");
    expect(pr.title).toBe("Refactor the widgets");
    expect(pr.head_sha).toBe("abc123");
    expect(pr.base_ref).toBe("main");
    expect(clock.recordedSleeps()).toEqual([]);
    http.assertFullyConsumed();
  });

  it("(h) replays the paginated files cassette into PullRequestFileEnvelopeV1 entries", async () => {
    const http = cassetteClient("get_pr_files_paginated.yaml");
    const clock = new FakeClock();
    const { provider } = recordingTokenProvider(["tok"]);
    const client = new GitHubApiClient({ tokenProvider: provider, http, clock });

    const files = await client.getPullRequestFiles({
      installationId: INSTALLATION_ID,
      owner: "acme",
      repo: "example",
      prNumber: 42,
    });

    expect(files.map((f) => f.filename)).toEqual(["src/foo.py", "tests/test_foo.py"]);
    expect(files[0]!.status).toBe("modified");
    expect(files[1]!.additions).toBe(50);
    // The cassette has no rel="next" Link header → single page, single interaction consumed.
    http.assertFullyConsumed();
  });
});
