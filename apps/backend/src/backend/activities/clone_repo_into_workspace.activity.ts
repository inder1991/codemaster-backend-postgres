/**
 * `cloneRepoIntoWorkspace` activity — 1:1 port (part 2 of 2) of the frozen Python
 * `@activity.defn clone_repo_into_workspace`
 * (vendor/codemaster-py/codemaster/activities/_workspace_clone.py, lines 133-262).
 *
 * Workspace-aware clone step of the core loop: clones git directly into the
 * {@link CloneRepoIntoWorkspaceInput}'s `handle.derived_path`, enforces the 200 MiB
 * workspace-size cap, and returns a {@link ClonedRepoV1} envelope. The GitCloner seam +
 * `CloneFailedError` / `WorkspaceTooLargeError` taxonomy + `byteSizeOfDir` walk are the part-1
 * imports under `#backend/integrations/git/`.
 *
 * ## Deferred lease/heartbeat seam (the load-bearing divergence from the Python)
 *
 * The Python activity steps 1+2 open a DB transaction to (a) assert the lease row is still
 * `ALLOCATED` via a no-op `transition_lease(from=ALLOCATED, to=ALLOCATED)` (raising `StateDrift`
 * if the row moved) and (b) `LeaseRepo.touch_heartbeat(...)` to bump the janitor's orphan timer.
 * It also calls `activity.heartbeat({...})` four times to surface in-flight progress within the
 * Temporal heartbeat window.
 *
 * THIS slice has NO DB (the lease/heartbeat machinery is DEFERRED). Per the established TS activity
 * pattern (explicit collaborator arg, NOT Python module-level `configure()` globals), both halves
 * are modeled as INJECTED collaborators with NO-OP defaults:
 *
 *   - `assertLeaseAllocated?`: defaults to a no-op. The production impl (when the lease subsystem
 *     lands) performs the DB state-assertion and throws on drift — i.e. the StateDrift error path.
 *     Tracked: FOLLOW-UP-workspace-lease-lifecycle.
 *   - `heartbeat?`: defaults to a no-op. The production impl forwards to Temporal's
 *     `activity.heartbeat(...)`. Tracked: FOLLOW-UP-clone-activity-heartbeats.
 *
 * The observable output ({@link ClonedRepoV1}) does NOT depend on either collaborator, so the
 * no-op defaults make the lease/heartbeat machinery deferrable WITHOUT changing the parity surface.
 * The heartbeat call sites are preserved at the same four phase boundaries as the Python so the
 * production impl drops in with identical granularity.
 *
 * ## Error-wrapping rule (parity-significant)
 *
 *   - `head_sha` falsy OR shorter than {@link MIN_HEAD_SHA_LEN} (=7) →
 *     `CloneFailedError(reason="missing head_sha")`, BEFORE the cloner is invoked.
 *   - `cloner.clone(...)` throwing a NON-`CloneFailedError` → wrapped in
 *     `CloneFailedError(reason=String(e))`; an existing `CloneFailedError` re-throws unchanged.
 *   - `byteSizeOfDir(workspace) > MAX_WORKSPACE_BYTES` → `WorkspaceTooLargeError`.
 */

import { byteSizeOfDir } from "#backend/integrations/git/byte_size.js";
import { type GitCloner, REPO_SUBDIR_NAME } from "#backend/integrations/git/cloner.js";
import {
  CloneFailedError,
  MAX_WORKSPACE_BYTES,
  WorkspaceTooLargeError,
} from "#backend/integrations/git/errors.js";

import { ClonedRepoV1 } from "#contracts/cloned_repo.v1.js";
import type { CloneRepoIntoWorkspaceInput } from "#contracts/clone_repo_into_workspace_input.v1.js";

/**
 * Minimum-acceptable length for a head SHA — git's standard short-SHA width. Anything shorter is
 * treated as a missing/typoed SHA and raises {@link CloneFailedError} BEFORE the cloner is invoked.
 * Mirrors the frozen Python `_MIN_HEAD_SHA_LEN = 7`.
 */
export const MIN_HEAD_SHA_LEN = 7;

/**
 * Injected collaborators. Both are OPTIONAL with NO-OP defaults so the deferred lease/heartbeat
 * machinery does not change the observable output (see the module docstring).
 */
export type CloneRepoIntoWorkspaceDeps = {
  /** The git-driver seam (part-1 {@link GitCloner}). Production: subprocess-git; tests: a stub. */
  cloner: GitCloner;
  /**
   * Lease-state assertion + heartbeat-bump, deferred. Default: no-op. The production impl asserts
   * the lease row is still `ALLOCATED` and THROWS on drift (the StateDrift error path).
   * Tracked: FOLLOW-UP-workspace-lease-lifecycle.
   */
  assertLeaseAllocated?: (workspaceId: string) => Promise<void>;
  /**
   * Temporal in-flight progress heartbeat, deferred. Default: no-op. The production impl forwards
   * the phase payload to `activity.heartbeat(...)`. Tracked: FOLLOW-UP-clone-activity-heartbeats.
   */
  heartbeat?: (payload: unknown) => void;
};

// No-op defaults. The signatures match {@link CloneRepoIntoWorkspaceDeps} structurally; an impl may
// omit unused trailing parameters (the established repo idiom for no-op collaborators).
const noopAssertLease = async (): Promise<void> => {};
const noopHeartbeat = (): void => {};

/**
 * Clone into an EXISTING workspace. 1:1 with the frozen Python activity body.
 *
 * Steps:
 *   1. + 2. Assert lease state `ALLOCATED` + bump heartbeat (DEFERRED — injected no-op seam).
 *   3. + 4. `head_sha` precondition then git clone into `handle.derived_path` (no workflow subdir —
 *      the path is already workflow-scoped).
 *   5. Enforce {@link MAX_WORKSPACE_BYTES} (200 MiB).
 *   6. Return {@link ClonedRepoV1}.
 */
export async function cloneRepoIntoWorkspace(
  req: CloneRepoIntoWorkspaceInput,
  deps: CloneRepoIntoWorkspaceDeps,
): Promise<ClonedRepoV1> {
  const { cloner } = deps;
  const assertLeaseAllocated = deps.assertLeaseAllocated ?? noopAssertLease;
  const heartbeat = deps.heartbeat ?? noopHeartbeat;

  const workspaceId = req.handle.workspace_id;
  const workspacePath = req.handle.derived_path;

  // 1. + 2. State assertion + heartbeat bump (DEFERRED). The production impl throws StateDrift if
  // the lease row moved off ALLOCATED. The no-op default makes this deferrable without affecting
  // the observable output. Mirrors the Python transaction + `activity.heartbeat({phase:
  // "state_assertion_done"})`.
  await assertLeaseAllocated(workspaceId);
  heartbeat({ phase: "state_assertion_done" });

  // 3. + 4. Git clone into the existing workspace path.
  if (!req.head_sha || req.head_sha.length < MIN_HEAD_SHA_LEN) {
    throw new CloneFailedError({
      repo: req.repo_url,
      headSha: req.head_sha || "",
      reason: "missing head_sha",
    });
  }

  // Heartbeat BEFORE the clone shell-out so a stalled subprocess is detectable within the heartbeat
  // window (DEFERRED no-op). Mirrors the Python `activity.heartbeat({phase: "clone_started"})`.
  heartbeat({ phase: "clone_started" });
  try {
    await cloner.clone({
      workspace: workspacePath,
      repoUrl: req.repo_url,
      headSha: req.head_sha,
      paths: req.changed_paths,
      prNumber: req.pr_number,
    });
  } catch (e) {
    // Re-raise an existing CloneFailedError unchanged; wrap anything else.
    if (e instanceof CloneFailedError) {
      throw e;
    }
    throw new CloneFailedError({
      repo: req.repo_url,
      headSha: req.head_sha,
      reason: e instanceof Error ? e.message : String(e),
    });
  }
  // Heartbeat AFTER the clone returns (DEFERRED no-op).
  heartbeat({ phase: "clone_completed" });

  const byteSize = await byteSizeOfDir(workspacePath);
  if (byteSize > MAX_WORKSPACE_BYTES) {
    throw new WorkspaceTooLargeError({
      repo: req.repo_url,
      headSha: req.head_sha,
      byteSize,
    });
  }
  // Final heartbeat after the size check (DEFERRED no-op).
  heartbeat({ phase: "size_checked", byte_size: byteSize });

  // Construct via the Zod contract so schema_version (=2) + head_sha/byte_size constraints are
  // applied exactly as the Python Pydantic construction would. `repo_path` is `<workspace>/repo`.
  return ClonedRepoV1.parse({
    workspace_path: workspacePath,
    repo_path: `${workspacePath}/${REPO_SUBDIR_NAME}`,
    head_sha: req.head_sha,
    byte_size: byteSize,
  });
}

/**
 * Test/verifier {@link GitCloner} stub. Writes a known marker file into `<workspace>/repo` so the
 * activity's byte-size walk observes a real, deterministic on-disk footprint. The marker body length
 * is the controllable byte budget the oversized-tree test drives. Mirrors the role of the Python
 * test cloner stub: it makes the post-clone workspace observable without a real git round-trip.
 */
export class StubCloner implements GitCloner {
  private readonly markerBody: string;

  public constructor({ markerBody = "stub-clone\n" }: { markerBody?: string } = {}) {
    this.markerBody = markerBody;
  }

  public async clone({
    workspace,
  }: {
    workspace: string;
    repoUrl: string;
    headSha: string;
    paths: ReadonlyArray<string>;
    prNumber?: number | null;
  }): Promise<void> {
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    const repoDir = path.join(workspace, REPO_SUBDIR_NAME);
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, "MARKER.txt"), this.markerBody, { encoding: "utf8" });
  }
}
