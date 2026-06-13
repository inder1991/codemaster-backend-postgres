/**
 * PrDescriptionClient — production GitHub adapter for the `update_pr_description_summary` activity.
 * The activity needs exactly two operations on a PR's description (a metadata field — CLAUDE.md
 * invariant 9: the bot edits the description, NOT the review event; it remains advisory):
 *
 *   1. GET the current PR body, so the prior codemaster summary block can be stripped + recomposed.
 *   2. PATCH the PR body back with the original-author content + the fresh summary appended.
 *
 * The {@link GhPrDescriptionClient} type is the narrow 2-method surface (the TS analogue of the frozen
 * Python Protocol) so the activity stays decoupled from the full {@link GitHubApiClient} surface and a
 * test double does not have to implement it all. {@link GitHubApiPrDescriptionClient} is the production
 * impl over an injected {@link GitHubApiClient} (so both operations inherit the unified retry /
 * 401-refresh / rate-limit-header / typed-error envelope — `GitHubApiClient._request`).
 *
 * ## Exact REST endpoints (byte-ported from the Python `_PrDescriptionGitHubAdapter`)
 *
 *   - getPullRequestBody → GitHubApiClient.getPullRequest(GET /repos/{owner}/{repo}/pulls/{pr_number}).
 *       GitHub returns a null `body` on PRs without a description; the Python `getattr(envelope, "body",
 *       "") or ""` collapses null → "" so the contract surfaces the empty string. Ported verbatim:
 *       `envelope.body ?? ""` ( `PullRequestEnvelopeV1.body` defaults to `null`).
 *   - patchPullRequestBody → GitHubApiClient.patch(PATCH /repos/{owner}/{repo}/pulls/{pr_number}) with
 *       JSON body `{ body }`. The Python adapter PATCHes the SAME URL shape with `json={"body": body}`;
 *       this port mirrors that exactly (the cassette round-trip test asserts method=PATCH, the URL, AND
 *       the JSON body `{"body": <recomposed body>}` byte-for-byte).
 */

import { type GitHubApiClient } from "#backend/integrations/github/api_client.js";

/**
 * The minimal 2-method surface `updatePrDescriptionSummary` needs from the GitHub API. Each method
 * takes a single camelCase args object, so the dispatch is positional-arg-free at the seam.
 */
export type GhPrDescriptionClient = {
  /**
   * Read the PR's current description body. Returns "" (never null) when the developer left the
   * description blank — GitHub surfaces that as a null `body`, collapsed here to the empty string.
   */
  getPullRequestBody(args: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<string>;

  /** Write the PR's description body via PATCH /repos/{owner}/{repo}/pulls/{prNumber} `{ body }`. */
  patchPullRequestBody(args: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<void>;
};

/**
 * Production {@link GhPrDescriptionClient}: implements the 2 methods over an injected
 * {@link GitHubApiClient}. `installationId` is fixed at construction — the worker is
 * single-installation-per-pod.
 */
export class GitHubApiPrDescriptionClient implements GhPrDescriptionClient {
  private readonly api: GitHubApiClient;
  private readonly installationId: number;

  public constructor({ api, installationId }: { api: GitHubApiClient; installationId: number }) {
    if (installationId <= 0) {
      throw new Error(`installation_id must be >= 1, got ${installationId}`);
    }
    this.api = api;
    this.installationId = installationId;
  }

  public async getPullRequestBody({
    installationId,
    owner,
    repo,
    prNumber,
  }: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<string> {
    const envelope = await this.api.getPullRequest({ installationId, owner, repo, prNumber });
    // GitHub returns a null body on PRs without a description; the contract surfaces that as "".
    // (PullRequestEnvelopeV1.body defaults to null; mirror the Python `... or ""`.)
    return envelope.body ?? "";
  }

  public async patchPullRequestBody({
    installationId,
    owner,
    repo,
    prNumber,
    body,
  }: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<void> {
    await this.api.patch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
      installationId,
      jsonBody: { body },
    });
  }
}
