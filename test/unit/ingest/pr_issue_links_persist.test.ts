// Unit test for the webhook-side issue-link producer wiring — 1:1 in intent with the frozen Python
// `_maybe_persist_pr_issue_links` / `_safe_persist_pr_issue_links` in
// `codemaster/ingest/github_webhook_persistence.py`.
//
// NO DATABASE: the real `replaceLinks` (which talks to Postgres + opens a SAVEPOINT on `tx`) is injected as
// a STUB collaborator so we can assert the parsed links it RECEIVES, plus the fail-closed guard, without any
// DB. The production call site passes the real `replaceLinks`; this seam exists only for unit-testability.

import { describe, expect, it, vi } from "vitest";

import { maybePersistPrIssueLinks } from "#backend/ingest/github_webhook_persistence.js";

import type { IssueLink } from "#contracts/issue_link.v1.js";
import { FakeClock } from "#platform/clock.js";
import type { PrMetadata } from "#backend/ingest/_webhook_extractors.js";

// A minimal PrMetadata with the fields the producer reads; the rest are filler (the producer ignores them).
function makePrMeta(overrides: Partial<PrMetadata>): PrMetadata {
  return {
    action: "opened",
    prNumber: 7,
    headSha: "deadbeef",
    ghOwner: "acme",
    ghRepoName: "widgets",
    prTitle: "",
    prDescription: "",
    githubRepoId: 999,
    isCrossFork: false,
    headRepoFullName: "acme/widgets",
    githubPullRequestId: 123456,
    authorGithubUserId: 1,
    authorLogin: "octocat",
    authorUserType: "User",
    authorName: null,
    authorAvatarUrl: null,
    baseRef: "main",
    baseSha: "cafe",
    headRef: "",
    draft: false,
    merged: false,
    openedAt: null,
    ...overrides,
  };
}

// A no-op `tx` — the stub never touches it, and the savepoint SQL is only exercised on the real path. The
// producer collaborator we inject ignores `tx`, so an `unknown`-typed sentinel is sufficient here.
const FAKE_TX = {} as never;

// Pass-through savepoint runner: just runs `body` (no Postgres SAVEPOINT). This is the DB-free seam — the
// production call site uses the real Postgres savepoint runner (its default).
const passThroughSavepoint = (_tx: unknown, body: () => Promise<void>): Promise<void> => body();

describe("maybePersistPrIssueLinks", () => {
  it("parses description / title / branch_name and passes the parsed links to replaceLinks", async () => {
    const replaceLinks = vi
      .fn<(tx: unknown, args: { links: ReadonlyArray<IssueLink> }) => Promise<{ deleted: number; inserted: number }>>()
      .mockResolvedValue({ deleted: 0, inserted: 2 });

    await maybePersistPrIssueLinks(FAKE_TX, {
      prMeta: makePrMeta({ prDescription: "Fixes #42 and mentions #7" }),
      internalIid: "11111111-1111-1111-1111-111111111111",
      internalRepoId: "22222222-2222-2222-2222-222222222222",
      deliveryId: "delivery-abc",
      clock: new FakeClock(),
      replaceLinksImpl: replaceLinks,
      runInSavepoint: passThroughSavepoint,
    });

    expect(replaceLinks).toHaveBeenCalledTimes(1);
    const passedLinks = replaceLinks.mock.calls[0]![1].links;
    expect(passedLinks).toContainEqual<IssueLink>({
      github_issue_number: 42,
      linkage_kind: "fixes",
      source: "description",
    });
    expect(passedLinks).toContainEqual<IssueLink>({
      github_issue_number: 7,
      linkage_kind: "mentioned",
      source: "description",
    });
  });

  it("threads title + branch_name sources too", async () => {
    const replaceLinks = vi.fn().mockResolvedValue({ deleted: 0, inserted: 2 });

    await maybePersistPrIssueLinks(FAKE_TX, {
      prMeta: makePrMeta({ prTitle: "Closes #5", headRef: "resolves #9" }),
      internalIid: "11111111-1111-1111-1111-111111111111",
      internalRepoId: "22222222-2222-2222-2222-222222222222",
      deliveryId: "delivery-abc",
      clock: new FakeClock(),
      replaceLinksImpl: replaceLinks,
      runInSavepoint: passThroughSavepoint,
    });

    const passedLinks = replaceLinks.mock.calls[0]![1].links as ReadonlyArray<IssueLink>;
    expect(passedLinks).toContainEqual({ github_issue_number: 5, linkage_kind: "closes", source: "title" });
    expect(passedLinks).toContainEqual({
      github_issue_number: 9,
      linkage_kind: "resolves",
      source: "branch_name",
    });
  });

  it("fail-closed: githubPullRequestId === null → replaceLinks NOT called", async () => {
    const replaceLinks = vi.fn().mockResolvedValue({ deleted: 0, inserted: 0 });

    await maybePersistPrIssueLinks(FAKE_TX, {
      prMeta: makePrMeta({ prDescription: "Fixes #42", githubPullRequestId: null }),
      internalIid: "11111111-1111-1111-1111-111111111111",
      internalRepoId: "22222222-2222-2222-2222-222222222222",
      deliveryId: "delivery-abc",
      clock: new FakeClock(),
      replaceLinksImpl: replaceLinks,
    });

    expect(replaceLinks).not.toHaveBeenCalled();
  });

  it("fail-closed: githubPullRequestId <= 0 → replaceLinks NOT called", async () => {
    const replaceLinks = vi.fn().mockResolvedValue({ deleted: 0, inserted: 0 });

    await maybePersistPrIssueLinks(FAKE_TX, {
      prMeta: makePrMeta({ prDescription: "Fixes #42", githubPullRequestId: 0 }),
      internalIid: "11111111-1111-1111-1111-111111111111",
      internalRepoId: "22222222-2222-2222-2222-222222222222",
      deliveryId: "delivery-abc",
      clock: new FakeClock(),
      replaceLinksImpl: replaceLinks,
    });

    expect(replaceLinks).not.toHaveBeenCalled();
  });
});
