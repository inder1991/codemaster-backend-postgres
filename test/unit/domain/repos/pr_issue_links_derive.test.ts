// Parity test for derivePrIssueLinkId — the deterministic per-link uuid5 (1:1 with the frozen Python
// `codemaster/domain/repos/pr_issue_links_repo.py::derive_pr_issue_link_id`:
//   uuid5(PR_ISSUE_LINK_UUID5_NAMESPACE, "{pr_id}|{github_issue_number}|{linkage_kind}|{source}")).
// The golden vectors below were produced by the LIVE frozen Python so this byte-matches.

import { describe, expect, it } from "vitest";

import {
  PR_ISSUE_LINK_UUID5_NAMESPACE,
  derivePrIssueLinkId,
} from "#backend/domain/repos/pr_issue_links_repo.js";

const PR_ID = "949b2f08-2774-562a-9a9d-ea5472e0ccfa";

describe("derivePrIssueLinkId", () => {
  it("uses the frozen namespace (MUST NOT change)", () => {
    expect(PR_ISSUE_LINK_UUID5_NAMESPACE).toBe("8d8c9d14-0a3e-5e0f-9b7e-fc2c3a8d9704");
  });

  it("byte-matches the frozen Python golden vectors", () => {
    expect(
      derivePrIssueLinkId({
        prId: PR_ID,
        githubIssueNumber: 42,
        linkageKind: "fixes",
        source: "description",
      }),
    ).toBe("33b7722b-30c5-5115-bbf0-8cffa8456d7d");

    expect(
      derivePrIssueLinkId({
        prId: PR_ID,
        githubIssueNumber: 7,
        linkageKind: "mentioned",
        source: "title",
      }),
    ).toBe("cc0a8501-709c-5b1a-bc75-c64a633eb7ae");
  });

  it("is deterministic + stable for fixed inputs", () => {
    const args = {
      prId: PR_ID,
      githubIssueNumber: 42,
      linkageKind: "fixes" as const,
      source: "description" as const,
    };
    expect(derivePrIssueLinkId(args)).toBe(derivePrIssueLinkId(args));
  });

  it("differs when ANY component differs (kind / source / number)", () => {
    const base = derivePrIssueLinkId({
      prId: PR_ID,
      githubIssueNumber: 42,
      linkageKind: "fixes",
      source: "description",
    });
    // kind differs
    expect(
      derivePrIssueLinkId({ prId: PR_ID, githubIssueNumber: 42, linkageKind: "closes", source: "description" }),
    ).not.toBe(base);
    // source differs
    expect(
      derivePrIssueLinkId({ prId: PR_ID, githubIssueNumber: 42, linkageKind: "fixes", source: "title" }),
    ).not.toBe(base);
    // number differs
    expect(
      derivePrIssueLinkId({ prId: PR_ID, githubIssueNumber: 43, linkageKind: "fixes", source: "description" }),
    ).not.toBe(base);
  });
});
