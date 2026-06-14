// F6a — GitHub client resilience (P1-A 401 forceRefresh, P1-B 429 + primary-rate-limit 403).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { CassetteHttpClient } from "#backend/infra/cassettes.js";

import {
  GitHubApiClient,
  GitHubRateLimitExceeded,
  type GitHubHttpClient,
  type GitHubHttpResponse,
  type TokenProvider,
} from "#backend/integrations/github/api_client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GH_CASSETTES = resolve(HERE, "..", "..", "..", "cassettes", "github");
const INSTALLATION_ID = 12345;

/** A token provider that records the `forceRefresh` flag of each call. */
function recordingProvider(): { provider: TokenProvider; opts: Array<boolean> } {
  const opts: Array<boolean> = [];
  const provider: TokenProvider = async (_id, o) => {
    await Promise.resolve();
    opts.push(o?.forceRefresh === true);
    return "tok";
  };
  return { provider, opts };
}

/** A one-shot stub transport returning a scripted response (for the throw-before-parse paths). */
function stubHttp(resp: GitHubHttpResponse): GitHubHttpClient {
  return { request: async () => Promise.resolve(resp) };
}

describe("GitHubApiClient — F6a P1-A: 401 forces a token re-mint", () => {
  it("the 401-refresh re-calls the provider with forceRefresh=true (not the same cached token)", async () => {
    const http = CassetteHttpClient.fromPath(resolve(GH_CASSETTES, "401_token_invalid.yaml"));
    const { provider, opts } = recordingProvider();
    const client = new GitHubApiClient({ tokenProvider: provider, http, clock: new FakeClock() });

    await client.getPullRequest({ installationId: INSTALLATION_ID, owner: "acme", repo: "example", prNumber: 42 });

    // First fetch (loop top) NOT forced; the 401-refresh IS forced — the bug was a plain re-call that
    // returned the same still-fresh cached token, making the refresh a no-op.
    expect(opts).toEqual([false, true]);
  });
});

describe("GitHubApiClient — F6a P1-B: rate-limit responses are retryable", () => {
  it("429 Too Many Requests → GitHubRateLimitExceeded carrying retry_after", async () => {
    const http = stubHttp({ status: 429, headers: { "retry-after": "30" }, body_text: "rate limited" });
    const client = new GitHubApiClient({
      tokenProvider: (async () => "tok") as TokenProvider,
      http,
      clock: new FakeClock(),
    });
    await expect(
      client.getPullRequest({ installationId: INSTALLATION_ID, owner: "acme", repo: "example", prNumber: 1 }),
    ).rejects.toMatchObject({ name: "GitHubRateLimitExceeded", retryAfterSeconds: 30 });
  });

  it("403 PRIMARY rate-limit (x-ratelimit-remaining:0) → GitHubRateLimitExceeded, not a terminal 403", async () => {
    const http = stubHttp({
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "4102444800" },
      body_text: "API rate limit exceeded for installation",
    });
    const client = new GitHubApiClient({
      tokenProvider: (async () => "tok") as TokenProvider,
      http,
      clock: new FakeClock(),
    });
    await expect(
      client.getPullRequest({ installationId: INSTALLATION_ID, owner: "acme", repo: "example", prNumber: 1 }),
    ).rejects.toBeInstanceOf(GitHubRateLimitExceeded);
  });
});
