// Unit tests for GhCheckRunClient.findExistingCheckRun — the find-before-create idempotency scan that
// keeps a review redrive from creating a DUPLICATE check-run (W3.4 external-boundary idempotency / XM9).
// The scan must PAGINATE (follow Link: rel="next"), else an existing codemaster check-run sitting past
// the first page (≥30 other runs on the head_sha) is missed → a duplicate is created on redrive.

import { describe, expect, it } from "vitest";

import { type GitHubApiClient } from "#backend/integrations/github/api_client.js";
import { GitHubApiCheckRunClient } from "#backend/integrations/github/check_run_client.js";

type GetCall = { path: string };

/** A stub GitHubApiClient that serves scripted GET pages (body + Link header) in order. */
function stubApi(pages: Array<{ body: unknown; link?: string }>): {
  api: GitHubApiClient;
  calls: Array<GetCall>;
} {
  const calls: Array<GetCall> = [];
  let i = 0;
  const api = {
    get: (path: string) => {
      calls.push({ path });
      const page = pages[i] ?? { body: { check_runs: [] } };
      i += 1;
      return Promise.resolve({
        status: 200,
        headers: page.link !== undefined ? { Link: page.link } : {},
        body_text: JSON.stringify(page.body),
      });
    },
  } as unknown as GitHubApiClient;
  return { api, calls };
}

const CHECK_RUNS = (...names: Array<{ name: string; id: number }>): { check_runs: Array<unknown> } => ({
  check_runs: names.map((n) => ({ name: n.name, id: n.id })),
});

describe("GhCheckRunClient.findExistingCheckRun", () => {
  const find = (api: GitHubApiClient): Promise<number | null> =>
    new GitHubApiCheckRunClient({ api, installationId: 1 }).findExistingCheckRun({
      owner: "o",
      repo: "r",
      headSha: "abc",
      name: "codemaster",
    });

  it("finds the run on the FIRST page (single-page wire unchanged)", async () => {
    const { api, calls } = stubApi([{ body: CHECK_RUNS({ name: "codemaster", id: 42 }) }]);
    expect(await find(api)).toBe(42);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/repos/o/r/commits/abc/check-runs"); // bare path, no query
  });

  it("PAGINATES: finds an existing run on page 2 via Link rel=next (XM9 — no duplicate on redrive)", async () => {
    const { api, calls } = stubApi([
      { body: CHECK_RUNS({ name: "other-a", id: 1 }, { name: "other-b", id: 2 }), link: '</repos/o/r/commits/abc/check-runs?page=2>; rel="next"' },
      { body: CHECK_RUNS({ name: "codemaster", id: 99 }) },
    ]);
    expect(await find(api)).toBe(99); // BEFORE the fix this returned null (page-1-only) → duplicate create
    expect(calls).toHaveLength(2);
    expect(calls[1]!.path).toBe("/repos/o/r/commits/abc/check-runs?page=2");
  });

  it("returns null when no page has the run", async () => {
    const { api } = stubApi([
      { body: CHECK_RUNS({ name: "other", id: 1 }), link: '</repos/o/r/commits/abc/check-runs?page=2>; rel="next"' },
      { body: CHECK_RUNS({ name: "another", id: 2 }) },
    ]);
    expect(await find(api)).toBeNull();
  });

  it("is BOUNDED — a never-ending Link chain stops at the page cap (no infinite scan)", async () => {
    // Every page declares a next link + never the target → the cap must stop it.
    const endless = Array.from({ length: 50 }, () => ({
      body: CHECK_RUNS({ name: "noise", id: 0 }),
      link: '</repos/o/r/commits/abc/check-runs?page=next>; rel="next"',
    }));
    const { api, calls } = stubApi(endless);
    expect(await find(api)).toBeNull();
    expect(calls.length).toBeLessThanOrEqual(20); // CHECK_RUN_SCAN_MAX_PAGES
  });
});
