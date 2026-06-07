import { describe, expect, it } from "vitest";

import {
  GitHubInstallationPayloadV1,
  GitHubInstallationRepositoriesPayloadV1,
  GitHubRepositoryV1,
} from "#contracts/github_installation_payload.v1.js";
import {
  ReconcileInstallationResultV1,
  ReconcileRepositoriesResultV1,
} from "#contracts/reconcile_results.v1.js";
import { RepairResultV1 } from "#contracts/repair_installation_repositories.v1.js";

// Round-trip parse unit tests for the auto-registration port contracts (the missing Zod shapes built
// from the frozen Python at vendor/codemaster-py). Pure Zod — no Pydantic oracle, no DB. Each contract
// must (a) accept a valid payload INCLUDING its defaults, and (b) for the `extra=forbid` (.strict())
// result contracts, REJECT an unknown key. The `extra=ignore` (.strip()) webhook payloads instead STRIP
// the unknown key (GitHub adds fields freely). The Pydantic↔Zod canonical-JSON parity diffs are deferred
// to the per-contract .parity.test.ts files (oracle-backed); these tests pin shape/defaults in isolation.

const account = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  login: "octocat",
  type: "User",
  ...overrides,
});

describe("GitHubRepositoryV1 (extra=ignore → strip)", () => {
  it("accepts a minimal payload and applies default_branch / archived defaults", () => {
    const parsed = GitHubRepositoryV1.parse({
      id: 99,
      full_name: "acme/widget",
      owner: account(),
    });
    expect(parsed.default_branch).toBe("main");
    expect(parsed.archived).toBe(false);
    expect(parsed.id).toBe(99);
    expect(parsed.owner.login).toBe("octocat");
  });

  it("strips an unknown key (extra=ignore parity)", () => {
    const parsed = GitHubRepositoryV1.parse({
      id: 1,
      full_name: "a/b",
      owner: account(),
      private: true, // not modelled → dropped
    });
    expect("private" in parsed).toBe(false);
  });

  it("rejects an empty / over-length full_name", () => {
    expect(GitHubRepositoryV1.safeParse({ id: 1, full_name: "", owner: account() }).success).toBe(
      false,
    );
    expect(
      GitHubRepositoryV1.safeParse({ id: 1, full_name: "x".repeat(201), owner: account() }).success,
    ).toBe(false);
  });
});

describe("GitHubInstallationPayloadV1 (extra=ignore → strip)", () => {
  it("accepts a valid payload and applies the schema_version default (1)", () => {
    const parsed = GitHubInstallationPayloadV1.parse({
      action: "created",
      installation: { id: 555, account: account({ type: "Organization" }) },
      sender: account(),
    });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.action).toBe("created");
    expect(parsed.installation.id).toBe(555);
    expect(parsed.installation.account?.login).toBe("octocat");
  });

  it("accepts all four normalized actions", () => {
    for (const action of ["created", "deleted", "suspended", "unsuspended"] as const) {
      const r = GitHubInstallationPayloadV1.safeParse({
        action,
        installation: { id: 1 },
        sender: account(),
      });
      expect(r.success, action).toBe(true);
    }
  });

  it("rejects the un-normalized webhook action 'suspend' (producer normalizes before validation)", () => {
    expect(
      GitHubInstallationPayloadV1.safeParse({
        action: "suspend",
        installation: { id: 1 },
        sender: account(),
      }).success,
    ).toBe(false);
  });

  it("strips an unknown key (extra=ignore parity)", () => {
    const parsed = GitHubInstallationPayloadV1.parse({
      action: "created",
      installation: { id: 1 },
      sender: account(),
      bogus: "x", // dropped
    });
    expect("bogus" in parsed).toBe(false);
  });
});

describe("GitHubInstallationRepositoriesPayloadV1 (extra=ignore → strip)", () => {
  it("accepts a valid payload and defaults both repo arrays to []", () => {
    const parsed = GitHubInstallationRepositoriesPayloadV1.parse({
      action: "added",
      installation: { id: 7 },
      sender: account(),
    });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.repositories_added).toEqual([]);
    expect(parsed.repositories_removed).toEqual([]);
  });

  it("accepts populated repo arrays with per-repo defaults", () => {
    const parsed = GitHubInstallationRepositoriesPayloadV1.parse({
      action: "added",
      installation: { id: 7 },
      sender: account(),
      repositories_added: [{ id: 10, full_name: "acme/a", owner: account() }],
    });
    expect(parsed.repositories_added).toHaveLength(1);
    expect(parsed.repositories_added[0]?.default_branch).toBe("main");
    expect(parsed.repositories_added[0]?.archived).toBe(false);
  });

  it("rejects an unknown action", () => {
    expect(
      GitHubInstallationRepositoriesPayloadV1.safeParse({
        action: "transferred",
        installation: { id: 1 },
        sender: account(),
      }).success,
    ).toBe(false);
  });

  it("strips an unknown key (extra=ignore parity)", () => {
    const parsed = GitHubInstallationRepositoriesPayloadV1.parse({
      action: "removed",
      installation: { id: 1 },
      sender: account(),
      repository_selection: "all", // GitHub sends this; not modelled → dropped
    });
    expect("repository_selection" in parsed).toBe(false);
  });
});

describe("ReconcileInstallationResultV1 (extra=forbid → strict)", () => {
  const VALID = {
    action: "created",
    installation_id: "00000000-0000-0000-0000-000000000001",
    user_id: "00000000-0000-0000-0000-000000000002",
  };

  it("accepts a valid payload and applies the schema_version default (1)", () => {
    const parsed = ReconcileInstallationResultV1.parse(VALID);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.action).toBe("created");
    expect(parsed.user_id).toBe("00000000-0000-0000-0000-000000000002");
  });

  it("accepts a null user_id (uuid | None)", () => {
    expect(ReconcileInstallationResultV1.safeParse({ ...VALID, user_id: null }).success).toBe(true);
  });

  it("REQUIRES user_id to be present (faithful to the Python no-default field)", () => {
    const withoutUserId = { action: VALID.action, installation_id: VALID.installation_id };
    expect(ReconcileInstallationResultV1.safeParse(withoutUserId).success).toBe(false);
  });

  it("accepts the result-only 'updated' action (absent from the INPUT enum)", () => {
    expect(ReconcileInstallationResultV1.safeParse({ ...VALID, action: "updated" }).success).toBe(
      true,
    );
  });

  it("rejects an unknown key (extra=forbid ↔ .strict())", () => {
    expect(ReconcileInstallationResultV1.safeParse({ ...VALID, bogus: 1 }).success).toBe(false);
  });

  it("rejects a non-uuid installation_id", () => {
    expect(
      ReconcileInstallationResultV1.safeParse({ ...VALID, installation_id: "not-a-uuid" }).success,
    ).toBe(false);
  });
});

describe("ReconcileRepositoriesResultV1 (extra=forbid → strict)", () => {
  it("accepts a valid payload and applies the schema_version default (1)", () => {
    const parsed = ReconcileRepositoriesResultV1.parse({ added: 3, removed: 1 });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.added).toBe(3);
    expect(parsed.removed).toBe(1);
  });

  it("REQUIRES added + removed (no defaults — faithful to the Python)", () => {
    expect(ReconcileRepositoriesResultV1.safeParse({ added: 1 }).success).toBe(false);
    expect(ReconcileRepositoriesResultV1.safeParse({ removed: 1 }).success).toBe(false);
  });

  it("rejects an unknown key (extra=forbid ↔ .strict())", () => {
    expect(
      ReconcileRepositoriesResultV1.safeParse({ added: 0, removed: 0, bogus: true }).success,
    ).toBe(false);
  });
});

describe("RepairResultV1 (extra=forbid → strict)", () => {
  it("accepts an empty payload and applies ALL defaults", () => {
    const parsed = RepairResultV1.parse({});
    expect(parsed.schema_version).toBe(1);
    expect(parsed.newly_created).toBe(0);
    expect(parsed.refreshed).toBe(0);
    expect(parsed.blocked).toBe(false);
    expect(parsed.blocked_reason).toBe(null);
  });

  it("accepts a blocked terminal-failure result", () => {
    const parsed = RepairResultV1.parse({ blocked: true, blocked_reason: "installation_not_found" });
    expect(parsed.blocked).toBe(true);
    expect(parsed.blocked_reason).toBe("installation_not_found");
  });

  it("rejects an unknown key (extra=forbid ↔ .strict())", () => {
    expect(RepairResultV1.safeParse({ bogus: 1 }).success).toBe(false);
  });

  it("rejects a non-1 schema_version literal", () => {
    expect(RepairResultV1.safeParse({ schema_version: 2 }).success).toBe(false);
  });
});
