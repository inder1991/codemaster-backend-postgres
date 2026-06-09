/**
 * Unit tests for the TS GitHubApiReviewClient — the 1:1 port of
 * `codemaster/integrations/github/review_client.py` (frozen Python, Sprint 15 / S15.X-post-review-wiring).
 *
 * The REAL GitHubApiReviewClient is driven over a RECORDING STUB of the GitHubApiClient transport
 * (mirrors the `post_check_run.parity.test.ts` real-wire test): the stub records each HTTP request and
 * returns the next scripted response, so we byte-assert the EXACT REST method / url / json body for
 * every method WITHOUT a network round-trip.
 *
 * Coverage:
 *   - findExistingReviewByMarker → GET reviews; first body CONTAINING the marker wins; null-body skipped;
 *     no match → null.
 *   - createReview WITH comments → TWO requests (POST review, then GET comments); event ALWAYS "COMMENT";
 *     commentIds parsed IN ORDER.
 *   - createReview with NO comments → ONE request (POST only); commentIds = [].
 *   - event is ALWAYS "COMMENT" (CLAUDE.md invariant-9 pin — the type has no `event` param, so there is
 *     no way to send APPROVE / REQUEST_CHANGES).
 *   - updateReview → PUT (NOT PATCH).
 *   - createIssueComment / listIssueComments / deleteIssueComment exact wire; delete URL OMITS pr_number.
 *   - constructor rejects installationId < 1.
 */

import { describe, it, expect } from "vitest";

import { FakeClock } from "#platform/clock.js";
import {
  GitHubApiClient,
  type GitHubHttpClient,
  type GitHubHttpRequestArgs,
  type GitHubHttpResponse,
  type TokenProvider,
} from "#backend/integrations/github/api_client.js";
import {
  GitHubApiReviewClient,
  REVIEW_EVENT,
} from "#backend/integrations/github/review_client.js";

/** A recording GitHubHttpClient: records each request and returns the NEXT scripted response. */
function recordingTransport(responses: ReadonlyArray<GitHubHttpResponse>): {
  http: GitHubHttpClient;
  requests: Array<GitHubHttpRequestArgs>;
} {
  const requests: Array<GitHubHttpRequestArgs> = [];
  let i = 0;
  const http: GitHubHttpClient = {
    request(args: GitHubHttpRequestArgs): Promise<GitHubHttpResponse> {
      requests.push(args);
      const resp = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      return Promise.resolve(resp);
    },
  };
  return { http, requests };
}

function okJson(body: unknown): GitHubHttpResponse {
  return { status: 200, headers: {}, body_text: JSON.stringify(body) };
}

/** A 200 carrying a `Link: rel="next"` header (W3.2 pagination) pointing at `nextPath` (a relative path,
 *  the shape GitHub emits after the api client's host-strip). */
function okJsonWithNext(body: unknown, nextPath: string): GitHubHttpResponse {
  return {
    status: 200,
    headers: { Link: `<https://api.github.com${nextPath}>; rel="next"` },
    body_text: JSON.stringify(body),
  };
}

/** A recording transport that returns DISTINCT responses per call (no overflow-clamp), so a paginated
 *  scan walks page 1 → page 2 → … in order and a stray extra request surfaces as an error. */
function strictRecordingTransport(responses: ReadonlyArray<GitHubHttpResponse>): {
  http: GitHubHttpClient;
  requests: Array<GitHubHttpRequestArgs>;
} {
  const requests: Array<GitHubHttpRequestArgs> = [];
  let i = 0;
  const http: GitHubHttpClient = {
    request(args: GitHubHttpRequestArgs): Promise<GitHubHttpResponse> {
      requests.push(args);
      const resp = responses[i];
      if (resp === undefined) {
        return Promise.reject(new Error(`unexpected request #${i + 1}: ${args.method} ${args.url}`));
      }
      i += 1;
      return Promise.resolve(resp);
    },
  };
  return { http, requests };
}

function strictClient(responses: ReadonlyArray<GitHubHttpResponse>): {
  client: GitHubApiReviewClient;
  requests: Array<GitHubHttpRequestArgs>;
} {
  const { http, requests } = strictRecordingTransport(responses);
  const api = new GitHubApiClient({ tokenProvider, http, clock: new FakeClock() });
  const client = new GitHubApiReviewClient({ api, installationId: INSTALLATION_ID });
  return { client, requests };
}

const tokenProvider: TokenProvider = () => Promise.resolve("tok");
const INSTALLATION_ID = 555;

function realClient(responses: ReadonlyArray<GitHubHttpResponse>): {
  client: GitHubApiReviewClient;
  requests: Array<GitHubHttpRequestArgs>;
} {
  const { http, requests } = recordingTransport(responses);
  const api = new GitHubApiClient({ tokenProvider, http, clock: new FakeClock() });
  const client = new GitHubApiReviewClient({ api, installationId: INSTALLATION_ID });
  return { client, requests };
}

describe("GitHubApiReviewClient — constructor", () => {
  it("rejects installationId < 1", () => {
    const { http } = recordingTransport([]);
    const api = new GitHubApiClient({ tokenProvider, http, clock: new FakeClock() });
    expect(() => new GitHubApiReviewClient({ api, installationId: 0 })).toThrow(
      "installation_id must be >= 1",
    );
  });
});

describe("GitHubApiReviewClient — findExistingReviewByMarker (exact REST wire)", () => {
  it("GET pulls/{n}/reviews; returns the id of the FIRST review whose body contains the marker", async () => {
    const { client, requests } = realClient([
      okJson([
        { id: 1, body: "unrelated review" },
        { id: 2, body: null },
        { id: 99, body: "header\n<!-- codemaster:marker -->\nfooter" },
        { id: 100, body: "also contains <!-- codemaster:marker -->" },
      ]),
    ]);
    const id = await client.findExistingReviewByMarker({
      owner: "octo",
      repo: "hello-world",
      prNumber: 42,
      marker: "<!-- codemaster:marker -->",
    });
    expect(id).toBe(99);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe(
      "https://api.github.com/repos/octo/hello-world/pulls/42/reviews",
    );
  });

  it("skips reviews with a null OR empty-string body and returns null when no body contains the marker", async () => {
    const { client } = realClient([
      okJson([
        { id: 1, body: null },
        { id: 2, body: "" }, // empty-string body is falsy in Python (`if review_body`) — must be skipped
        { id: 3, body: "no marker here" },
      ]),
    ]);
    const id = await client.findExistingReviewByMarker({
      owner: "octo",
      repo: "hello-world",
      prNumber: 42,
      marker: "<!-- codemaster:marker -->",
    });
    expect(id).toBeNull();
  });

  it("W3.2 — PAGINATES: page-1 has no match, follows Link rel=next to page 2 where the marker IS found", async () => {
    const { client, requests } = strictClient([
      okJsonWithNext(
        [
          { id: 1, body: "unrelated" },
          { id: 2, body: null },
        ],
        "/repositories/9/pulls/42/reviews?page=2",
      ),
      okJson([{ id: 314, body: "header\n<!-- codemaster:marker -->\nfooter" }]),
    ]);
    const id = await client.findExistingReviewByMarker({
      owner: "octo",
      repo: "hello-world",
      prNumber: 42,
      marker: "<!-- codemaster:marker -->",
    });
    expect(id).toBe(314);
    // TWO requests: the bare first page, then the server-provided next link verbatim.
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe("https://api.github.com/repos/octo/hello-world/pulls/42/reviews");
    expect(requests[1]!.url).toBe("https://api.github.com/repositories/9/pulls/42/reviews?page=2");
  });

  it("W3.2 — first page MATCH short-circuits: never fetches page 2 even when Link rel=next is present", async () => {
    const { client, requests } = strictClient([
      okJsonWithNext(
        [{ id: 77, body: "<!-- codemaster:marker -->" }],
        "/repositories/9/pulls/42/reviews?page=2",
      ),
      // page 2 response present but MUST NOT be requested (the strict transport would still serve it; the
      // assertion is on requests.length).
      okJson([{ id: 999, body: "<!-- codemaster:marker -->" }]),
    ]);
    const id = await client.findExistingReviewByMarker({
      owner: "octo",
      repo: "hello-world",
      prNumber: 42,
      marker: "<!-- codemaster:marker -->",
    });
    expect(id).toBe(77); // FIRST match wins (page 1), page 2 never fetched
    expect(requests).toHaveLength(1);
  });

  it("W3.2 — no Link header → ONE request, byte-identical to the v1 single-page wire", async () => {
    const { client, requests } = strictClient([okJson([{ id: 1, body: "no marker" }])]);
    const id = await client.findExistingReviewByMarker({
      owner: "octo",
      repo: "hello-world",
      prNumber: 42,
      marker: "<!-- codemaster:marker -->",
    });
    expect(id).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.github.com/repos/octo/hello-world/pulls/42/reviews");
  });
});

describe("GitHubApiReviewClient — listReviewComments (W3.2 takeover recovery)", () => {
  it("GET pulls/{n}/reviews/{id}/comments → comment ids in submission (id-ascending) order", async () => {
    const { client, requests } = strictClient([okJson([{ id: 11 }, { id: 22 }, { id: 33 }])]);
    const ids = await client.listReviewComments({
      owner: "octo",
      repo: "hello-world",
      prNumber: 42,
      reviewId: 999,
    });
    expect(ids).toEqual([11, 22, 33]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe(
      "https://api.github.com/repos/octo/hello-world/pulls/42/reviews/999/comments",
    );
  });

  it("empty review (no inline comments) → []", async () => {
    const { client } = strictClient([okJson([])]);
    const ids = await client.listReviewComments({
      owner: "octo",
      repo: "hello-world",
      prNumber: 42,
      reviewId: 999,
    });
    expect(ids).toEqual([]);
  });
});

describe("GitHubApiReviewClient — createReview (exact REST wire + comment-id flow)", () => {
  it("WITH comments → TWO requests (POST review, then GET comments); event=COMMENT; ids in order", async () => {
    const { client, requests } = realClient([
      okJson({ id: 4242 }), // POST /reviews response
      okJson([{ id: 11 }, { id: 22 }, { id: 33 }]), // GET /reviews/{id}/comments response (id-ascending)
    ]);
    const comments = [
      { path: "a.py", line: 1, body: "nit 1" },
      { path: "b.py", line: 2, body: "nit 2" },
      { path: "c.py", line: 3, body: "nit 3" },
    ];
    const created = await client.createReview({
      owner: "octo",
      repo: "hello-world",
      prNumber: 42,
      body: "Walkthrough.",
      commitId: "abc123",
      comments,
    });

    expect(created).toEqual({ reviewId: 4242, commentIds: [11, 22, 33] });

    // TWO requests: POST then GET.
    expect(requests).toHaveLength(2);

    // Request 1: POST /reviews with the EXACT body (event hard-coded to COMMENT).
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe(
      "https://api.github.com/repos/octo/hello-world/pulls/42/reviews",
    );
    expect(requests[0]!.json_body).toEqual({
      commit_id: "abc123",
      body: "Walkthrough.",
      event: "COMMENT",
      comments,
    });

    // Request 2: GET the per-review comments to learn their ids.
    expect(requests[1]!.method).toBe("GET");
    expect(requests[1]!.url).toBe(
      "https://api.github.com/repos/octo/hello-world/pulls/42/reviews/4242/comments",
    );
    // The GET carries no request body — the generic `get` helper threads `json_body: null`.
    expect(requests[1]!.json_body).toBeNull();
  });

  it("with NO comments → ONE request (POST only); commentIds = []", async () => {
    const { client, requests } = realClient([okJson({ id: 4242 })]);
    const created = await client.createReview({
      owner: "octo",
      repo: "hello-world",
      prNumber: 42,
      body: "Body-only review.",
      commitId: "abc123",
      comments: [],
    });

    expect(created).toEqual({ reviewId: 4242, commentIds: [] });
    // ONLY the POST happened — the comments GET is skipped.
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.json_body).toEqual({
      commit_id: "abc123",
      body: "Body-only review.",
      event: "COMMENT",
      comments: [],
    });
  });

  it("CLAUDE.md invariant-9 pin: event is ALWAYS COMMENT (the type exposes no event param)", async () => {
    const { client, requests } = realClient([okJson({ id: 7 })]);
    await client.createReview({
      owner: "octo",
      repo: "hello-world",
      prNumber: 1,
      body: "x",
      commitId: "sha",
      comments: [],
    });
    expect(REVIEW_EVENT).toBe("COMMENT");
    expect((requests[0]!.json_body as { event: string }).event).toBe("COMMENT");
  });
});

describe("GitHubApiReviewClient — updateReview (PUT, NOT PATCH)", () => {
  it("PUT pulls/{n}/reviews/{id} with the exact { body } payload", async () => {
    const { client, requests } = realClient([okJson({ id: 4242 })]);
    await client.updateReview({
      owner: "octo",
      repo: "hello-world",
      prNumber: 42,
      reviewId: 4242,
      body: "Updated walkthrough.",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("PUT");
    expect(requests[0]!.url).toBe(
      "https://api.github.com/repos/octo/hello-world/pulls/42/reviews/4242",
    );
    expect(requests[0]!.json_body).toEqual({ body: "Updated walkthrough." });
  });
});

describe("GitHubApiReviewClient — issue-comment surface (exact REST wire)", () => {
  it("createIssueComment → POST issues/{n}/comments { body }, returns the new id", async () => {
    const { client, requests } = realClient([okJson({ id: 9001 })]);
    const id = await client.createIssueComment({
      owner: "octo",
      repo: "hello-world",
      prNumber: 42,
      body: "Reviewing this PR...",
    });
    expect(id).toBe(9001);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe(
      "https://api.github.com/repos/octo/hello-world/issues/42/comments",
    );
    expect(requests[0]!.json_body).toEqual({ body: "Reviewing this PR..." });
  });

  it("listIssueComments → GET issues/{n}/comments, returns the array verbatim", async () => {
    const payload = [
      { id: 1, body: "first" },
      { id: 2, body: "second" },
    ];
    const { client, requests } = realClient([okJson(payload)]);
    const comments = await client.listIssueComments({
      owner: "octo",
      repo: "hello-world",
      prNumber: 42,
    });
    expect(comments).toEqual(payload);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe(
      "https://api.github.com/repos/octo/hello-world/issues/42/comments",
    );
  });

  it("deleteIssueComment → DELETE issues/comments/{id}; URL OMITS the pr_number (global id)", async () => {
    const { client, requests } = realClient([{ status: 204, headers: {}, body_text: null }]);
    await client.deleteIssueComment({
      owner: "octo",
      repo: "hello-world",
      commentId: 9001,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("DELETE");
    // No pr_number segment — addressed by the global comment id.
    expect(requests[0]!.url).toBe(
      "https://api.github.com/repos/octo/hello-world/issues/comments/9001",
    );
  });
});
