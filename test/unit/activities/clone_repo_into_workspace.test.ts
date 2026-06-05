/**
 * Unit coverage of `cloneRepoIntoWorkspace` (1:1 with the frozen Python
 * `clone_repo_into_workspace_activity`). Drives the StubCloner (writes a known marker into
 * `<workspace>/repo`) and exercises:
 *
 *   - happy path: returns ClonedRepoV1 with the right workspace_path / repo_path / head_sha /
 *     byte_size (> 0, the marker file the stub wrote).
 *   - head_sha shorter than MIN_HEAD_SHA_LEN → CloneFailedError("missing head_sha"), cloner NOT run.
 *   - cloner throwing a generic Error → wrapped in CloneFailedError.
 *   - cloner throwing a CloneFailedError → re-thrown unchanged.
 *   - oversized tree → WorkspaceTooLargeError (byteSizeOfDir mocked over the cap, mirroring the
 *     Python `monkeypatch.setattr(_byte_size_of_dir, lambda _p: 1024)` idiom).
 *   - injected no-op lease/heartbeat doubles do not affect the output; an injected assertLease/heartbeat
 *     is observed at the right phases, and a throwing assertLease surfaces (the StateDrift path).
 *   - the REAL production defaults are de-stubbed (no no-op survives on the shipped path):
 *     `defaultAssertLeaseAllocated` throws when `CODEMASTER_PG_CORE_DSN` is unset (its DB round-trip is
 *     exercised against a disposable PG in the integration test), and `defaultHeartbeat` is the
 *     Temporal-context forwarder. Tests inject no-op doubles since there is no DB / Temporal context here.
 *
 * Workspaces are created under os.tmpdir and removed after each test.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cloneRepoIntoWorkspace,
  defaultAssertLeaseAllocated,
  defaultHeartbeat,
  MIN_HEAD_SHA_LEN,
  StubCloner,
} from "#backend/activities/clone_repo_into_workspace.activity.js";
import { type GitCloner } from "#backend/integrations/git/cloner.js";
import { CloneFailedError, WorkspaceTooLargeError } from "#backend/integrations/git/errors.js";

import { CloneRepoIntoWorkspaceInput } from "#contracts/clone_repo_into_workspace_input.v1.js";

const UUID = "12345678-1234-5678-1234-567812345678";
const HEAD_SHA = "abcdef0123456789abcdef0123456789abcdef01"; // 40 hex chars

const createdWorkspaces: Array<string> = [];

async function makeWorkspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "cm-clone-act-"));
  createdWorkspaces.push(ws);
  return ws;
}

function input(workspace: string, overrides: Partial<{ head_sha: string }> = {}): CloneRepoIntoWorkspaceInput {
  return CloneRepoIntoWorkspaceInput.parse({
    handle: {
      workspace_id: UUID,
      installation_id: UUID,
      run_id: UUID,
      derived_path: workspace,
      state: "ALLOCATED",
    },
    repo_url: "https://github.com/acme/widget",
    head_sha: overrides.head_sha ?? HEAD_SHA,
    changed_paths: ["src/foo.ts"],
    pr_number: 42,
  });
}

// Injected no-op doubles for the lease-assertion + heartbeat seams. The PRODUCTION defaults are REAL
// (a DB round-trip + a Temporal-context heartbeat); neither composes in a unit context, so every unit
// call injects these explicit no-op doubles. `deps` threads the doubles into the required `cloner`.
const noopAssertLeaseDouble = async (id: string): Promise<void> => {
  void id;
};
const noopHeartbeatDouble = (payload: unknown): void => {
  void payload;
};
function deps(cloner: GitCloner, overrides: Partial<{ assertLeaseAllocated: (id: string) => Promise<void> }> = {}) {
  return {
    cloner,
    assertLeaseAllocated: overrides.assertLeaseAllocated ?? noopAssertLeaseDouble,
    heartbeat: noopHeartbeatDouble,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (createdWorkspaces.length > 0) {
    const ws = createdWorkspaces.pop();
    if (ws !== undefined) {
      await fs.rm(ws, { recursive: true, force: true });
    }
  }
});

describe("cloneRepoIntoWorkspace — happy path", () => {
  it("returns a ClonedRepoV1 with the right workspace_path / repo_path / head_sha / byte_size", async () => {
    const ws = await makeWorkspace();
    const cloner = new StubCloner({ markerBody: "twelve-bytes" }); // 12 bytes

    const result = await cloneRepoIntoWorkspace(input(ws), deps(cloner));

    expect(result.schema_version).toBe(2);
    expect(result.workspace_path).toBe(ws);
    expect(result.repo_path).toBe(`${ws}/repo`);
    expect(result.head_sha).toBe(HEAD_SHA);
    // The stub wrote a 12-byte marker into <ws>/repo; byteSizeOfDir sums it.
    expect(result.byte_size).toBe(12);
  });

  it("injected no-op lease/heartbeat doubles do not affect the output", async () => {
    const ws = await makeWorkspace();
    const cloner = new StubCloner({ markerBody: "x" });

    // No-op doubles injected for both seams (the production defaults are REAL and need DB/Temporal).
    const result = await cloneRepoIntoWorkspace(input(ws), deps(cloner));

    expect(result.workspace_path).toBe(ws);
    expect(result.byte_size).toBe(1);
  });

  it("the de-stubbed production defaults are real (no no-op survives the shipped path)", async () => {
    // `defaultHeartbeat` is the Temporal-context forwarder (callable; only valid inside a worker).
    expect(typeof defaultHeartbeat).toBe("function");

    // `defaultAssertLeaseAllocated` performs a DB round-trip on the shared pool; with no
    // CODEMASTER_PG_CORE_DSN configured it FAILS LOUD rather than silently no-op'ing. (The DB happy
    // path is exercised against a disposable PG in clone_asserts_lease.integration.test.ts.)
    const prior = process.env.CODEMASTER_PG_CORE_DSN;
    delete process.env.CODEMASTER_PG_CORE_DSN;
    try {
      await expect(defaultAssertLeaseAllocated(UUID)).rejects.toThrow(/CODEMASTER_PG_CORE_DSN is not set/);
    } finally {
      if (prior !== undefined) process.env.CODEMASTER_PG_CORE_DSN = prior;
    }
  });

  it("invokes the injected lease assertion + heartbeat at the expected phases", async () => {
    const ws = await makeWorkspace();
    const cloner = new StubCloner({ markerBody: "x" });
    const assertLeaseAllocated = vi.fn(async (id: string): Promise<void> => {
      void id;
    });
    const heartbeat = vi.fn((payload: unknown): void => {
      void payload;
    });

    await cloneRepoIntoWorkspace(input(ws), { cloner, assertLeaseAllocated, heartbeat });

    expect(assertLeaseAllocated).toHaveBeenCalledWith(UUID);
    expect(heartbeat.mock.calls.map((c) => (c[0] as { phase: string }).phase)).toEqual([
      "state_assertion_done",
      "clone_started",
      "clone_completed",
      "size_checked",
    ]);
  });
});

describe("cloneRepoIntoWorkspace — error paths", () => {
  it("head_sha shorter than MIN_HEAD_SHA_LEN → CloneFailedError('missing head_sha'), cloner not run", async () => {
    const ws = await makeWorkspace();
    const clone = vi.fn(async () => {});
    const cloner: GitCloner = { clone };

    await expect(cloneRepoIntoWorkspace(input(ws, { head_sha: "abc" }), deps(cloner))).rejects.toMatchObject({
      name: "CloneFailedError",
      reason: "missing head_sha",
    });
    expect(clone).not.toHaveBeenCalled();
    // Sanity: the threshold is the git short-SHA width.
    expect(MIN_HEAD_SHA_LEN).toBe(7);
  });

  it("a generic Error from cloner.clone is wrapped in CloneFailedError", async () => {
    const ws = await makeWorkspace();
    const cloner: GitCloner = {
      clone: async () => {
        throw new Error("network partition");
      },
    };

    const err = await cloneRepoIntoWorkspace(input(ws), deps(cloner)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloneFailedError);
    expect((err as CloneFailedError).reason).toBe("network partition");
    expect((err as CloneFailedError).repo).toBe("https://github.com/acme/widget");
    expect((err as CloneFailedError).headSha).toBe(HEAD_SHA);
  });

  it("an existing CloneFailedError from cloner.clone is re-thrown unchanged", async () => {
    const ws = await makeWorkspace();
    const original = new CloneFailedError({ repo: "https://github.com/acme/widget", headSha: HEAD_SHA, reason: "auth" });
    const cloner: GitCloner = {
      clone: async () => {
        throw original;
      },
    };

    const err = await cloneRepoIntoWorkspace(input(ws), deps(cloner)).catch((e: unknown) => e);
    expect(err).toBe(original); // same instance — not re-wrapped
    expect((err as CloneFailedError).reason).toBe("auth");
  });

  it("a throwing assertLeaseAllocated surfaces (the StateDrift path), cloner not run", async () => {
    const ws = await makeWorkspace();
    const clone = vi.fn(async () => {});
    const cloner: GitCloner = { clone };
    const assertLeaseAllocated = async (): Promise<void> => {
      throw new Error("StateDrift: lease no longer ALLOCATED");
    };

    await expect(
      cloneRepoIntoWorkspace(input(ws), deps(cloner, { assertLeaseAllocated })),
    ).rejects.toThrow("StateDrift");
    expect(clone).not.toHaveBeenCalled();
  });
});

describe("cloneRepoIntoWorkspace — oversized tree", () => {
  it("byte_size over MAX_WORKSPACE_BYTES → WorkspaceTooLargeError", async () => {
    // Mirror the Python monkeypatch of `_byte_size_of_dir`: stub the byte-size walk to report a value
    // over the 200 MiB cap WITHOUT writing 200 MiB to disk.
    const byteSizeMod = await import("#backend/integrations/git/byte_size.js");
    vi.spyOn(byteSizeMod, "byteSizeOfDir").mockResolvedValue(200 * 1024 * 1024 + 1);

    const ws = await makeWorkspace();
    const cloner = new StubCloner({ markerBody: "x" });

    const err = await cloneRepoIntoWorkspace(input(ws), deps(cloner)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceTooLargeError);
    expect((err as WorkspaceTooLargeError).byteSize).toBe(200 * 1024 * 1024 + 1);
    expect((err as WorkspaceTooLargeError).repo).toBe("https://github.com/acme/widget");
  });
});
