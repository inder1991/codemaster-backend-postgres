/**
 * Unit coverage of the standalone `clone_repository_activity` port — the clone primitive the
 * refresh_semantic_docs workflow proxies as Step 1.
 *
 * The frozen Python (vendor/codemaster-py/codemaster/activities/clone_repository.py) SEPARATES a
 * pure `perform_clone(...)` from the `@activity.defn clone_repository_activity(...)` so the
 * orchestration (cache-dir layout, size cap, askpass, timeout) is unit-testable WITHOUT a Temporal
 * activity context or a live git clone. This port keeps that separation:
 *
 *   - `performClone(req, deps)` — the PURE orchestration core. Driven here with a STUB `GitCloner`
 *     (writes a known on-disk footprint into the cache workspace, like the review-pipeline
 *     `StubCloner`) so the cache-dir layout + size-cap + wipe behaviour are observable WITHOUT a
 *     real git round-trip (NO network, NO token).
 *   - `cloneRepositoryActivity(input, deps)` — resolves the repo `full_name` (installation-scoped)
 *     + the numeric GitHub installation id from Postgres, mints the install token via the injected
 *     `TokenProvider`, then calls `performClone`. Driven here with a STUB repo-resolver + STUB
 *     token-provider so the resolution + token-threading is observable WITHOUT a DB or GitHub.
 *
 * Cache workspaces are created under os.tmpdir (CODEMASTER_CLONE_CACHE_ROOT override) and removed
 * after each test.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CacheGitCloner,
  cloneRepositoryActivity,
  CloneSizeCapExceeded,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_SECONDS,
  performClone,
  type RepoResolution,
} from "#backend/activities/clone_repository.activity.js";
import { GitCloneTimeoutError } from "#backend/integrations/git/errors.js";

import { CloneRepositoryInputV1 } from "#contracts/clone_repository.v1.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const REPOSITORY_ID = "22222222-2222-4222-8222-222222222222";
const HEAD_SHA = "abcdef0123456789abcdef0123456789abcdef01"; // 40 hex chars
const FULL_NAME = "acme/widget";
const GITHUB_INSTALLATION_ID = 4815162342;
const INSTALL_TOKEN = "ghs_faketoken1234567890";

let cacheRoot: string;
const createdRoots: Array<string> = [];

beforeEach(async () => {
  cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cm-clone-cache-"));
  createdRoots.push(cacheRoot);
  process.env["CODEMASTER_CLONE_CACHE_ROOT"] = cacheRoot;
});

afterEach(async () => {
  delete process.env["CODEMASTER_CLONE_CACHE_ROOT"];
  for (const root of createdRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * STUB `CacheGitCloner` — writes a marker file of controllable size into the cache workspace so the
 * post-clone byte-size walk observes a real, deterministic footprint. Records every clone call so the
 * test can assert the target dir, repo full_name, head_sha and install token were threaded through.
 */
class RecordingCloner implements CacheGitCloner {
  public calls: Array<{
    targetDir: string;
    repoFullName: string;
    headSha: string;
    installationToken: string;
  }> = [];
  private readonly bodyBytes: number;

  public constructor({ bodyBytes = 16 }: { bodyBytes?: number } = {}) {
    this.bodyBytes = bodyBytes;
  }

  public async clone(args: {
    targetDir: string;
    repoFullName: string;
    headSha: string;
    installationToken: string;
    timeoutSeconds: number;
  }): Promise<void> {
    this.calls.push({
      targetDir: args.targetDir,
      repoFullName: args.repoFullName,
      headSha: args.headSha,
      installationToken: args.installationToken,
    });
    // Land a real on-disk footprint so byteSizeOfDir sees it.
    const repoDir = path.join(args.targetDir, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, "MARKER.bin"), Buffer.alloc(this.bodyBytes, 0x61));
  }
}

function performReq(overrides: Partial<{ maxBytes: number; timeoutSeconds: number }> = {}) {
  return {
    installationId: INSTALLATION_ID,
    repositoryId: REPOSITORY_ID,
    repoFullName: FULL_NAME,
    headSha: HEAD_SHA,
    installationToken: INSTALL_TOKEN,
    ...overrides,
  };
}

describe("performClone (pure orchestration core)", () => {
  it("lays out /<cacheRoot>/<installation_id>/<repository_id>/repo and returns the REPO ROOT", async () => {
    const cloner = new RecordingCloner();
    const out = await performClone(performReq(), { cloner });

    // The RETURNED path is the repo-root working tree (<targetDir>/repo), NOT the bare targetDir — so the
    // refresh activity walks the real repo root. (Regression, adversarial-review CRITICAL: returning
    // targetDir surfaced every doc with a `repo/` prefix → isInScope dropped them all → silent no-op.)
    const targetDir = path.join(cacheRoot, INSTALLATION_ID, REPOSITORY_ID);
    expect(out).toBe(path.join(targetDir, "repo"));
    // The cloner is invoked with the PARENT targetDir (where it lands the `repo/` subtree).
    expect(cloner.calls[0]!.targetDir).toBe(targetDir);
    // The cloned footprint sits DIRECTLY under the returned path (no `repo/` prefix → docs at the root).
    const st = await fs.stat(path.join(out, "MARKER.bin"));
    expect(st.size).toBe(16);
  });

  it("threads the repo full_name + head_sha + install token into the cloner", async () => {
    const cloner = new RecordingCloner();
    await performClone(performReq(), { cloner });

    expect(cloner.calls).toHaveLength(1);
    const call = cloner.calls[0]!;
    expect(call.repoFullName).toBe(FULL_NAME);
    expect(call.headSha).toBe(HEAD_SHA);
    expect(call.installationToken).toBe(INSTALL_TOKEN);
    expect(call.targetDir).toBe(path.join(cacheRoot, INSTALLATION_ID, REPOSITORY_ID));
  });

  it("wipes a pre-existing target dir before cloning (no stale bytes survive)", async () => {
    const target = path.join(cacheRoot, INSTALLATION_ID, REPOSITORY_ID);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "STALE.txt"), "leftover from a prior run");

    const cloner = new RecordingCloner();
    await performClone(performReq(), { cloner });

    // The stale file is gone; only the fresh clone footprint remains.
    await expect(fs.stat(path.join(target, "STALE.txt"))).rejects.toThrow();
    await expect(fs.stat(path.join(target, "repo", "MARKER.bin"))).resolves.toBeDefined();
  });

  it("size-cap exceeded → wipes the partial clone AND throws CloneSizeCapExceeded", async () => {
    const cloner = new RecordingCloner({ bodyBytes: 4096 });
    const target = path.join(cacheRoot, INSTALLATION_ID, REPOSITORY_ID);

    await expect(performClone(performReq({ maxBytes: 64 }), { cloner })).rejects.toBeInstanceOf(
      CloneSizeCapExceeded,
    );
    // The partial clone was wiped (the safety-net invariant).
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("propagates a clone TIMEOUT (GitCloneTimeoutError) from the cloner", async () => {
    const timeoutCloner: CacheGitCloner = {
      async clone() {
        throw new GitCloneTimeoutError("git clone exceeded timeout 60s");
      },
    };
    await expect(performClone(performReq(), { cloner: timeoutCloner })).rejects.toBeInstanceOf(
      GitCloneTimeoutError,
    );
  });

  it("defaults maxBytes/timeoutSeconds to the module constants when omitted", async () => {
    expect(DEFAULT_MAX_BYTES).toBe(1024 * 1024 * 1024); // 1 GiB
    expect(DEFAULT_TIMEOUT_SECONDS).toBe(300); // 5 min

    let observedTimeout = -1;
    const cloner: CacheGitCloner = {
      async clone(args) {
        observedTimeout = args.timeoutSeconds;
      },
    };
    await performClone(performReq(), { cloner });
    expect(observedTimeout).toBe(DEFAULT_TIMEOUT_SECONDS);
  });
});

describe("cloneRepositoryActivity (resolution + token + orchestration)", () => {
  function input(): CloneRepositoryInputV1 {
    return CloneRepositoryInputV1.parse({
      schema_version: 1,
      installation_id: INSTALLATION_ID,
      repository_id: REPOSITORY_ID,
      head_sha: HEAD_SHA,
    });
  }

  it("resolves full_name (installation-scoped) + numeric id, mints token, clones to the cache layout", async () => {
    const cloner = new RecordingCloner();
    const resolverCalls: Array<{ installationId: string; repositoryId: string }> = [];
    const tokenCalls: Array<number> = [];

    const out = await cloneRepositoryActivity(input(), {
      cloner,
      resolveRepo: async (args): Promise<RepoResolution> => {
        resolverCalls.push(args);
        return { fullName: FULL_NAME, githubInstallationId: GITHUB_INSTALLATION_ID };
      },
      getToken: async (numericId): Promise<string> => {
        tokenCalls.push(numericId);
        return INSTALL_TOKEN;
      },
    });

    expect(out).toBe(path.join(cacheRoot, INSTALLATION_ID, REPOSITORY_ID, "repo")); // the repo root
    // Resolver was called with BOTH ids (installation-scoped lookup).
    expect(resolverCalls).toEqual([
      { installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID },
    ]);
    // Token was minted for the RESOLVED numeric id (not the UUID).
    expect(tokenCalls).toEqual([GITHUB_INSTALLATION_ID]);
    // The resolved full_name + minted token reached the cloner.
    expect(cloner.calls[0]!.repoFullName).toBe(FULL_NAME);
    expect(cloner.calls[0]!.installationToken).toBe(INSTALL_TOKEN);
  });
});
