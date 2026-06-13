/**
 * GhReviewClient — the GitHub Reviews-API surface the `post_review_results` activity depends on.
 * Wraps {@link GitHubApiClient}'s GET / POST / PUT / DELETE helpers so all 6 methods route through
 * the shared retry / 401-refresh / rate-limit-header / typed-error envelope (`_request`).
 * NO DB, NO Temporal — just the REST client.
 *
 * ## CLAUDE.md invariant 9 — advisory, never blocks merge
 *
 * The bot is advisory; the review `event` is ALWAYS `"COMMENT"`. The {@link GhReviewClient} type
 * deliberately does NOT expose `event` as a parameter on `createReview`; this impl hard-codes
 * {@link REVIEW_EVENT} so a future refactor cannot accidentally introduce the option to APPROVE /
 * REQUEST_CHANGES. Pinned by the recording-stub test asserting `json_body.event === "COMMENT"`.
 *
 * ## Idempotency complement
 *
 * `findExistingReviewByMarker` is the GitHub-side dedupe path; it complements (rather than replaces)
 * Sprint-14.D's `core.posted_reviews` atomic claim in `_do_post` (the actual TOCTOU fix). The W3.2
 * same-run takeover (v3-F1) promotes it to the RECOVERY oracle for the "createReview succeeded but the
 * DB UPDATE crashed" window, so it now PAGINATES (follows `Link: rel="next"`) — our marker must not be
 * missed behind >30 other reviews, otherwise the takeover would double-post a second review.
 *
 * ## Exact REST endpoints (byte-ported from the Python concrete impl)
 *
 *   - findExistingReviewByMarker → GET  /repos/{owner}/{repo}/pulls/{prNumber}/reviews
 *       PAGINATED (W3.2): the first request is the bare path (byte-identical to v1); subsequent pages
 *       follow `Link: rel="next"` up to a page cap. Returns the id of the FIRST review whose `body`
 *       CONTAINS `marker`; reviews with `body: null` are skipped. Else null.
 *   - createReview → POST /repos/{owner}/{repo}/pulls/{prNumber}/reviews
 *       Body: { commit_id, body, event: "COMMENT", comments }. Parses `review_id` from the response id.
 *       THEN, ONLY when `comments` is non-empty, GET
 *       /repos/{owner}/{repo}/pulls/{prNumber}/reviews/{review_id}/comments to learn the per-comment
 *       ids IN ORDER (GitHub returns id-ascending == submission order). Empty comments → ONE request
 *       (POST only), commentIds = []. Returns {@link CreatedReviewV1}.
 *   - updateReview → PUT  /repos/{owner}/{repo}/pulls/{prNumber}/reviews/{reviewId}
 *       Body: { body }. GitHub uses PUT for review-body update — NOT PATCH (unlike Check Runs which use
 *       PATCH). Pinned by the recording-stub test asserting `method === "PUT"`.
 *   - createIssueComment  → POST   /repos/{owner}/{repo}/issues/{prNumber}/comments  { body } → id
 *   - listIssueComments   → GET    /repos/{owner}/{repo}/issues/{prNumber}/comments  → array
 *   - deleteIssueComment  → DELETE /repos/{owner}/{repo}/issues/comments/{commentId}
 *       The issue-comment delete URL does NOT include the PR number — GitHub addresses issue comments by
 *       their GLOBAL comment id.
 *
 * ## Why a class over the GitHubApiClient (not a bare fetch)
 *
 * The Python `GhReviewHttpClient` wraps `GitHubApiClient` so all methods inherit the unified retry /
 * rate-limit posture across ALL GitHub-facing activities (the worker reuses ONE `GitHubApiClient`
 * singleton). The TS impl preserves that: the client is constructed over an injected
 * {@link GitHubApiClient} + a fixed `installationId`.
 */

import {
  extractNextLink,
  type GitHubApiClient,
  type GitHubHttpResponse,
} from "#backend/integrations/github/api_client.js";

// CLAUDE.md invariant 9 — locked here so the type stays event-free.
export const REVIEW_EVENT = "COMMENT";

/**
 * Hard cap on the number of `/pulls/{n}/reviews` pages the marker scan will walk before giving up. A PR
 * with >100×{@link MARKER_SCAN_MAX_PAGES} reviews is pathological; the cap bounds the worst case so a
 * runaway Link chain (or a server that never drops `rel="next"`) cannot spin forever. The first page is
 * always fetched at the bare path (no query string) so the single-page wire stays byte-identical.
 */
const MARKER_SCAN_MAX_PAGES = 20;

/**
 * Return envelope for {@link GhReviewClient.createReview} — the 1:1 analogue of the Python
 * `CreatedReviewV1` dataclass. This is the INTERNAL return of `createReview` (client → activity); it
 * does NOT cross the Temporal activity boundary, so it is a plain exported TYPE here — NOT a
 * versioned `contracts/` schema (unlike the activity-boundary `PostedCheckRunV1`).
 *
 * Carries both the new review's id and the per-inline-comment ids GitHub returned. The comment ids are
 * required so the workflow body's finding-delivery-lifecycle dispatch can pair persisted
 * `review_finding_id` UUIDs with their GitHub comment ids via the `kept_finding_indices` mapping the
 * activity surfaces on `PostedReviewV1`.
 *
 * Invariant (CLAUDE.md invariant 12 — comment_ids length-mismatch): `commentIds.length` equals the
 * number of inline comments GitHub accepted (i.e. the `comments` arg length minus any silent 422
 * drops). The ACTIVITY layer asserts this against `kept_findings` and raises if GitHub returned a
 * partial set; this client just reports what GitHub returned.
 */
export type CreatedReviewV1 = {
  reviewId: number;
  commentIds: ReadonlyArray<number>;
};

/** One inline review comment as GitHub's POST /reviews `comments` array accepts it (opaque to the
 *  client — the activity layer builds these; the client round-trips them verbatim). Mirrors the
 *  Python `list[dict[str, object]]` arg. */
export type ReviewComment = Record<string, unknown>;

/**
 * The 6-method GitHub Reviews-API surface the `post_review_results` activity needs. Each method takes
 * a single camelCase args object, so the dispatch is positional-arg-free at the seam.
 *
 * NOTE: `createReview` deliberately has NO `event` parameter — `event` is hard-coded to "COMMENT" in
 * the impl (CLAUDE.md invariant 9), making APPROVE / REQUEST_CHANGES structurally impossible.
 */
export type GhReviewClient = {
  /**
   * Returns the id of the first review whose body CONTAINS `marker`, or null when none match. Reviews
   * with a null/empty body are skipped. PAGINATED (W3.2): follows GitHub's `Link: rel="next"` across up
   * to {@link MARKER_SCAN_MAX_PAGES} pages so our marker isn't missed behind >30 other reviews — the
   * same-run takeover (W3.2/E7/v3-F1) relies on this to recover an orphaned remote review created by a
   * crashed self before it would otherwise blindly re-create (double-post). The FIRST page is fetched at
   * the bare path so the single-page wire stays byte-identical to v1.
   */
  findExistingReviewByMarker(args: {
    owner: string;
    repo: string;
    prNumber: number;
    marker: string;
  }): Promise<number | null>;

  /**
   * GET the inline comment ids of an EXISTING review, in submission (id-ascending) order — the recovery
   * oracle for the W3.2 takeover's "createReview succeeded but the DB UPDATE crashed" window: the marker
   * scan recovers the review id, then this re-fetches its comment ids so they can be CAS-stored on
   * `core.posted_reviews.comment_ids` WITHOUT a second createReview. Mirrors the follow-up GET that
   * {@link createReview} already issues after a fresh POST.
   */
  listReviewComments(args: {
    owner: string;
    repo: string;
    prNumber: number;
    reviewId: number;
  }): Promise<ReadonlyArray<number>>;

  /**
   * POST a new review (event ALWAYS "COMMENT"); returns {@link CreatedReviewV1}. When `comments` is
   * non-empty a follow-up GET fetches the per-comment ids in order; when empty the GET is skipped and
   * `commentIds` is `[]`.
   */
  createReview(args: {
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
    commitId: string;
    comments: ReadonlyArray<ReviewComment>;
  }): Promise<CreatedReviewV1>;

  /** PUT an existing review's body in place (GitHub uses PUT for reviews, NOT PATCH). */
  updateReview(args: {
    owner: string;
    repo: string;
    prNumber: number;
    reviewId: number;
    body: string;
  }): Promise<void>;

  /** POST a PR conversation-tab (issue) comment; returns the created comment's global id. */
  createIssueComment(args: {
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<number>;

  /** GET the first page of PR conversation-tab (issue) comments. The marker filter happens caller-side. */
  listIssueComments(args: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<Array<Record<string, unknown>>>;

  /** DELETE a PR conversation-tab (issue) comment by its GLOBAL id (NO pr_number in the URL). */
  deleteIssueComment(args: { owner: string; repo: string; commentId: number }): Promise<void>;
};

/** JSON-decode a response body; empty body → `{}` parse target. */
function jsonOf(resp: GitHubHttpResponse): unknown {
  return JSON.parse(resp.body_text ?? "{}");
}

/** Case-insensitive header lookup (GitHub may lowercase header names) — local twin of the api_client's
 *  non-exported `header`, used by the paginated marker scan to read the `Link` header. Iterates entries
 *  (no bracket-index sink) since `name` is a fixed literal at every call site. */
function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Production {@link GhReviewClient}: implements the 6 methods over an injected {@link GitHubApiClient}.
 */
export class GitHubApiReviewClient implements GhReviewClient {
  private readonly api: GitHubApiClient;
  private readonly installationId: number;

  public constructor({ api, installationId }: { api: GitHubApiClient; installationId: number }) {
    if (installationId <= 0) {
      throw new Error(`installation_id must be >= 1, got ${installationId}`);
    }
    this.api = api;
    this.installationId = installationId;
  }

  public async findExistingReviewByMarker({
    owner,
    repo,
    prNumber,
    marker,
  }: {
    owner: string;
    repo: string;
    prNumber: number;
    marker: string;
  }): Promise<number | null> {
    // W3.2: paginate via GitHub's `Link: rel="next"` header. The FIRST request stays at the bare path
    // (no query string) so the single-page wire is byte-identical to v1; subsequent pages follow the
    // server-provided next link verbatim (extractNextLink returns a relative path the api client
    // re-prepends the base url to). Bounded by MARKER_SCAN_MAX_PAGES so a never-ending chain can't spin.
    let path: string | null = `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
    for (let page = 0; path !== null && page < MARKER_SCAN_MAX_PAGES; page += 1) {
      const resp: GitHubHttpResponse = await this.api.get(path, {
        installationId: this.installationId,
      });
      const body = jsonOf(resp) as Array<Record<string, unknown>>;
      for (const review of body) {
        const reviewBody = review["body"];
        // Mirror Python's `if review_body and marker in review_body`: a falsy (empty-string or null)
        // body is skipped. The `!== ""` guard makes the truthiness byte-exact (only observable when the
        // marker is "" — never in production, where the marker is a non-empty literal — but kept faithful).
        if (typeof reviewBody === "string" && reviewBody !== "" && reviewBody.includes(marker)) {
          return Number(review["id"]);
        }
      }
      path = extractNextLink(headerOf(resp.headers, "Link"));
    }
    return null;
  }

  public async listReviewComments({
    owner,
    repo,
    prNumber,
    reviewId,
  }: {
    owner: string;
    repo: string;
    prNumber: number;
    reviewId: number;
  }): Promise<ReadonlyArray<number>> {
    // Same follow-up GET createReview issues after a fresh POST — GitHub returns the inline comments
    // id-ascending == submission order, so the ids align with the original payload order.
    const resp = await this.api.get(
      `/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments`,
      { installationId: this.installationId },
    );
    const commentsJson = jsonOf(resp) as Array<Record<string, unknown>>;
    return commentsJson.map((c) => Number(c["id"]));
  }

  public async createReview({
    owner,
    repo,
    prNumber,
    body,
    commitId,
    comments,
  }: {
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
    commitId: string;
    comments: ReadonlyArray<ReviewComment>;
  }): Promise<CreatedReviewV1> {
    // `event` is hard-coded to "COMMENT" — the bot is advisory (CLAUDE.md invariant 9). The type
    // surface has no `event` param, so APPROVE / REQUEST_CHANGES is structurally impossible.
    const requestBody = {
      commit_id: commitId,
      body,
      event: REVIEW_EVENT,
      comments,
    };
    const resp = await this.api.post(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
      installationId: this.installationId,
      jsonBody: requestBody,
    });
    const bodyJson = jsonOf(resp) as { id: number };
    const reviewId = Number(bodyJson.id);

    // GitHub's POST /reviews response carries the Review object metadata only — NOT the inline
    // comments. Empty `comments` → body-only review, no ids to fetch (skip the GET).
    if (comments.length === 0) {
      return { reviewId, commentIds: [] };
    }

    // Follow-up GET to learn the per-comment ids. GitHub returns them id-ascending == submission
    // order, so the ids align positionally with the request's `comments` arg.
    const commentsResp = await this.api.get(
      `/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments`,
      { installationId: this.installationId },
    );
    const commentsJson = jsonOf(commentsResp) as Array<Record<string, unknown>>;
    return {
      reviewId,
      commentIds: commentsJson.map((c) => Number(c["id"])),
    };
  }

  public async updateReview({
    owner,
    repo,
    prNumber,
    reviewId,
    body,
  }: {
    owner: string;
    repo: string;
    prNumber: number;
    reviewId: number;
    body: string;
  }): Promise<void> {
    // GitHub's API uses PUT for review-body update (different from Check Runs which use PATCH).
    await this.api.put(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}`, {
      installationId: this.installationId,
      jsonBody: { body },
    });
  }

  // ─── Issue-comment surface (serves the future placeholder + cleanup activities) ─────────────────
  //
  // The placeholder + cleanup activities use PR conversation-tab comments (issue comments), NOT review
  // comments. GitHub treats every PR as an issue with the same number for the issue-comments API, so
  // `/issues/{prNumber}/comments` lands a comment on the PR conversation tab without touching the
  // per-line review surface.

  public async createIssueComment({
    owner,
    repo,
    prNumber,
    body,
  }: {
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<number> {
    const resp = await this.api.post(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      installationId: this.installationId,
      jsonBody: { body },
    });
    const parsed = jsonOf(resp) as { id: number };
    return Number(parsed.id);
  }

  public async listIssueComments({
    owner,
    repo,
    prNumber,
  }: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<Array<Record<string, unknown>>> {
    const resp = await this.api.get(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      installationId: this.installationId,
    });
    return jsonOf(resp) as Array<Record<string, unknown>>;
  }

  public async deleteIssueComment({
    owner,
    repo,
    commentId,
  }: {
    owner: string;
    repo: string;
    commentId: number;
  }): Promise<void> {
    // The issue-comment delete URL does NOT include the PR number — GitHub addresses issue comments by
    // their global comment id. 204 No Content on success.
    await this.api.delete(`/repos/${owner}/${repo}/issues/comments/${commentId}`, {
      installationId: this.installationId,
    });
  }
}
