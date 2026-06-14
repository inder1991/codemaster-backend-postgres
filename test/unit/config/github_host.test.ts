// F6b — GitHub host config (GHE + github.com). The resolvers, the api-client API base, and the cloner's
// host-configurable repo_url validation.

import { afterEach, describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { resolveGithubApiBase, resolveGithubWebHost } from "#backend/config/github_host.js";
import {
  GitHubApiClient,
  type GitHubHttpClient,
  type TokenProvider,
} from "#backend/integrations/github/api_client.js";
import { GitSubprocessCloner } from "#backend/integrations/git/cloner.js";

const SAVED_API = process.env.GITHUB_API_BASE;
const SAVED_WEB = process.env.GITHUB_WEB_HOST;
afterEach(() => {
  if (SAVED_API === undefined) delete process.env.GITHUB_API_BASE;
  else process.env.GITHUB_API_BASE = SAVED_API;
  if (SAVED_WEB === undefined) delete process.env.GITHUB_WEB_HOST;
  else process.env.GITHUB_WEB_HOST = SAVED_WEB;
});

describe("github host resolvers (F6b)", () => {
  it("default to github.com (zero-config / next-year cloud move)", () => {
    delete process.env.GITHUB_API_BASE;
    delete process.env.GITHUB_WEB_HOST;
    expect(resolveGithubApiBase()).toBe("https://api.github.com");
    expect(resolveGithubWebHost()).toBe("github.com");
  });

  it("honor GITHUB_API_BASE / GITHUB_WEB_HOST for GHE (trailing slash + scheme normalized)", () => {
    process.env.GITHUB_API_BASE = "https://ghe.example.com/api/v3/";
    process.env.GITHUB_WEB_HOST = "https://ghe.example.com/";
    expect(resolveGithubApiBase()).toBe("https://ghe.example.com/api/v3");
    expect(resolveGithubWebHost()).toBe("ghe.example.com");
  });
});

describe("GitHubApiClient honors GITHUB_API_BASE with no explicit baseUrl (all ~15 sites) (F6b)", () => {
  it("sends requests to the configured GHE API base", async () => {
    process.env.GITHUB_API_BASE = "https://ghe.example.com/api/v3";
    let capturedUrl = "";
    const http: GitHubHttpClient = {
      request: async (a) => {
        capturedUrl = a.url;
        return { status: 404, headers: {}, body_text: "nope" };
      },
    };
    const client = new GitHubApiClient({
      tokenProvider: (async () => "tok") as TokenProvider,
      http,
      clock: new FakeClock(),
    });
    await client
      .getPullRequest({ installationId: 1, owner: "acme", repo: "example", prNumber: 7 })
      .catch(() => undefined); // 404 → throws; we only assert the URL it hit
    expect(capturedUrl).toBe("https://ghe.example.com/api/v3/repos/acme/example/pulls/7");
  });
});

describe("GitSubprocessCloner repo_url host is configurable (F6b)", () => {
  function cloner(): GitSubprocessCloner {
    return new GitSubprocessCloner({
      tokenProvider: (async () => "tok") as TokenProvider,
      spawnFn: () => {
        throw new Error("PASSED_VALIDATION_should_not_reach_spawn");
      },
    });
  }
  const base = { workspace: "/tmp/ws-f6b", headSha: "abc1234", installationId: 1, paths: [] as ReadonlyArray<string> };

  it("rejects a github.com URL when GITHUB_WEB_HOST is a GHE host", async () => {
    process.env.GITHUB_WEB_HOST = "ghe.example.com";
    await expect(
      cloner().clone({ ...base, repoUrl: "https://github.com/acme/widget.git" }),
    ).rejects.toThrow(/repo_url must be an https:\/\/ghe\.example\.com/);
  });

  it("accepts a GHE-host URL under GITHUB_WEB_HOST (passes validation, reaches spawn)", async () => {
    process.env.GITHUB_WEB_HOST = "ghe.example.com";
    await expect(
      cloner().clone({ ...base, repoUrl: "https://ghe.example.com/acme/widget.git" }),
    ).rejects.toThrow(/PASSED_VALIDATION_should_not_reach_spawn/); // got past the URL guard
  });
});
