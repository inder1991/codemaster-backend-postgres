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
 * ## Lease state-assertion + heartbeat seam (REAL — de-stubbed, 1:1 with the Python)
 *
 * The Python activity steps 1+2 open a DB transaction to (a) assert the lease row is still
 * `ALLOCATED` via a no-op `transition_lease(from=ALLOCATED, to=ALLOCATED)` (raising `StateDrift`
 * if the row moved) and (b) `LeaseRepo.touch_heartbeat(...)` to bump the janitor's orphan timer.
 * It also calls `activity.heartbeat({...})` four times to surface in-flight progress within the
 * Temporal heartbeat window.
 *
 * Per the established TS activity pattern (explicit collaborator arg, NOT Python module-level
 * `configure()` globals), both halves are modeled as INJECTED collaborators — but their PRODUCTION
 * DEFAULTS are now the REAL impls (parts 1+2 of the workspace-lease subsystem have landed), matching
 * the LLM-client de-stub pattern: NO no-op survives on the shipped path.
 *
 *   - `assertLeaseAllocated`: the production default ({@link defaultAssertLeaseAllocated}) opens ONE
 *     transaction on the shared ADR-0062 pool (resolved from `CODEMASTER_PG_CORE_DSN`) and runs the
 *     no-op `transitionLease(ALLOCATED → ALLOCATED, activity="clone_repo_into_workspace_activity")`,
 *     asserting the outcome is `ALREADY_APPLIED` (an `APPLIED` outcome is structurally impossible for
 *     a same-state transition and surfaces as a `RuntimeError`; a `StateDrift` propagates when the
 *     row moved off `ALLOCATED`). It then bumps `LeaseRepo.touchHeartbeat(workspace_id)` in the SAME
 *     transaction (1:1 with the Python `async with session.begin(): …`).
 *   - `heartbeat`: the production default ({@link defaultHeartbeat}) forwards the phase payload to
 *     Temporal's `Context.current().heartbeat(...)` (real Temporal heartbeat; works inside the worker
 *     activity context). Tests inject a no-op double (there is no Temporal context under unit/integration).
 *
 * The observable output ({@link ClonedRepoV1}) does NOT depend on either collaborator. The four
 * heartbeat call sites sit at the same four phase boundaries as the Python so the granularity matches.
 *
 * ## Error-wrapping rule (parity-significant)
 *
 *   - `head_sha` falsy OR shorter than {@link MIN_HEAD_SHA_LEN} (=7) →
 *     `CloneFailedError(reason="missing head_sha")`, BEFORE the cloner is invoked.
 *   - `cloner.clone(...)` throwing a NON-`CloneFailedError` → wrapped in
 *     `CloneFailedError(reason=String(e))`; an existing `CloneFailedError` re-throws unchanged.
 *   - `byteSizeOfDir(workspace) > MAX_WORKSPACE_BYTES` → `WorkspaceTooLargeError`.
 */

import { Context } from "@temporalio/activity";

import { byteSizeOfDir } from "#backend/integrations/git/byte_size.js";
import { type GitCloner, REPO_SUBDIR_NAME } from "#backend/integrations/git/cloner.js";
import {
  CloneFailedError,
  MAX_WORKSPACE_BYTES,
  WorkspaceTooLargeError,
} from "#backend/integrations/git/errors.js";
import { LeaseRepo } from "#backend/workspace/lease_repo.js";
import { LeaseTransitionOutcome, transitionLease } from "#backend/workspace/transition.js";

import { tenantKysely } from "#platform/db/database.js";
import { type Clock, WallClock } from "#platform/clock.js";

import { ClonedRepoV1 } from "#contracts/cloned_repo.v1.js";
import type { CloneRepoIntoWorkspaceInput } from "#contracts/clone_repo_into_workspace_input.v1.js";

/**
 * Minimum-acceptable length for a head SHA — git's standard short-SHA width. Anything shorter is
 * treated as a missing/typoed SHA and raises {@link CloneFailedError} BEFORE the cloner is invoked.
 * Mirrors the frozen Python `_MIN_HEAD_SHA_LEN = 7`.
 */
export const MIN_HEAD_SHA_LEN = 7;

/**
 * Injected collaborators. `cloner` is required; the lease-assertion + heartbeat seams are OPTIONAL
 * with REAL production defaults (see {@link defaultAssertLeaseAllocated} / {@link defaultHeartbeat}).
 * The defaults are NOT no-ops — they are the de-stubbed lease-lifecycle impls. Tests inject no-op
 * doubles (there is no DB / Temporal activity context under unit/integration unless explicitly wired).
 */
export type CloneRepoIntoWorkspaceDeps = {
  /** The git-driver seam (part-1 {@link GitCloner}). Production: subprocess-git; tests: a stub. */
  cloner: GitCloner;
  /**
   * Lease-state assertion + heartbeat-bump. Production default: {@link defaultAssertLeaseAllocated}
   * (opens one txn on the shared ADR-0062 pool, asserts the lease is still `ALLOCATED`, bumps the
   * heartbeat). Throws {@link StateDrift} when the row moved off `ALLOCATED`. Tests inject a no-op.
   */
  assertLeaseAllocated?: (workspaceId: string) => Promise<void>;
  /**
   * Temporal in-flight progress heartbeat. Production default: {@link defaultHeartbeat} (forwards to
   * `Context.current().heartbeat(...)`). Tests inject a no-op (no Temporal context off-worker).
   */
  heartbeat?: (payload: unknown) => void;
};

/**
 * REAL production default for `assertLeaseAllocated` (1:1 with the Python steps 1+2, one transaction).
 *
 * Resolves the shared ADR-0062 Kysely from `CODEMASTER_PG_CORE_DSN` (the same DSN/pool seam the
 * allocate + release activities use), opens ONE transaction, and within it:
 *   1. runs the no-op `transitionLease(ALLOCATED → ALLOCATED, activity="clone_repo_into_workspace_activity")`,
 *      asserting the outcome is `ALREADY_APPLIED`. `APPLIED` is structurally impossible for a same-state
 *      transition (the primitive returns `ALREADY_APPLIED` whenever `current === toState`, before the
 *      UPDATE) — a defensive `RuntimeError` surfaces `LeaseTransitionOutcome`-table drift rather than
 *      masking it (1:1 with the Python defensive raise). A `StateDrift` propagates when the row is
 *      missing OR no longer `ALLOCATED` (e.g. a concurrent cancellation flipped it to RELEASE_REQUESTED).
 *   2. bumps `LeaseRepo.touchHeartbeat(workspace_id)` so the janitor's orphan timer is reset — in the
 *      SAME transaction, so the assertion + heartbeat commit atomically.
 *
 * The clone activity passes NO `expectedInstallationId` (the BF-9 Phase-B grace period — 1:1 with the
 * Python, which also passes none here; `transitionLease` logs the structured WARN + proceeds).
 *
 * @throws {Error}       `CODEMASTER_PG_CORE_DSN` unset, OR the transition returned a non-`ALREADY_APPLIED`
 *                       outcome (table drift).
 * @throws {StateDrift}  the lease row is missing or no longer `ALLOCATED`.
 */
export async function defaultAssertLeaseAllocated(
  workspaceId: string,
  clock: Clock = new WallClock(),
): Promise<void> {
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set and no assertLeaseAllocated injected; cannot assert the clone lease state",
    );
  }
  const db = tenantKysely<unknown>(dsn);
  await db.transaction().execute(async (tx) => {
    const outcome = await transitionLease({
      tx,
      workspaceId,
      fromState: "ALLOCATED",
      toState: "ALLOCATED",
      activity: "clone_repo_into_workspace_activity",
      reason: "state-assertion noop",
      clock,
    });
    if (outcome !== LeaseTransitionOutcome.ALREADY_APPLIED) {
      throw new Error(
        `clone_repo_into_workspace_activity: unexpected transitionLease outcome ${JSON.stringify(
          outcome,
        )} on heartbeat noop for workspace_id=${JSON.stringify(workspaceId)}`,
      );
    }
    await new LeaseRepo({ db: tx }).touchHeartbeat(workspaceId);
  });
}

/**
 * REAL production default for `heartbeat` — RUNTIME-AGNOSTIC (cutover fix, 2026-06-11): inside a
 * Temporal worker it forwards the phase payload to the activity heartbeat (1:1 with the Python
 * `activity.heartbeat({...})`); outside one (CODEMASTER_RUNTIME_MODE=postgres — the in-process
 * review path wires this REAL activity via runner/in_process_ports.ts buildClonerDeps) it is a
 * deliberate NO-OP: the review job's lease heartbeat (runOneJob's heartbeat loop) is that
 * runtime's liveness signal, and the phase payload has no consumer there. Pre-fix, the bare
 * Context.current() throw ("Activity context not initialized") dead-lettered every postgres-mode
 * review after 3 attempts — caught live by the postgres-mode live_cluster_smoke.
 */
export function defaultHeartbeat(payload: unknown): void {
  try {
    Context.current().heartbeat(payload);
  } catch {
    /* no Temporal activity context — the postgres runtime's job-lease heartbeat owns liveness */
  }
}

/**
 * Clone into an EXISTING workspace. 1:1 with the frozen Python activity body.
 *
 * Steps:
 *   1. + 2. Assert lease state `ALLOCATED` + bump heartbeat ({@link defaultAssertLeaseAllocated}).
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
  const assertLeaseAllocated = deps.assertLeaseAllocated ?? defaultAssertLeaseAllocated;
  const heartbeat = deps.heartbeat ?? defaultHeartbeat;

  const workspaceId = req.handle.workspace_id;
  const workspacePath = req.handle.derived_path;

  // 1. + 2. State assertion + heartbeat bump (REAL). The default opens one txn on the shared pool,
  // asserts the lease is still ALLOCATED (throws StateDrift if it moved), and bumps the lease
  // heartbeat. Mirrors the Python transaction + `activity.heartbeat({phase: "state_assertion_done"})`.
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
  // Per-review routing: the clone mints its installation token for the per-PR numeric id from the input
  // (replacing the removed CODEMASTER_GITHUB_INSTALLATION_ID env pin). FAIL-CLOSED on a null id — the clone
  // is the spine core loop, so a silent skip would produce an empty workspace + a false-clean review.
  const githubInstallationId = req.github_installation_id;
  if (githubInstallationId === null) {
    throw new CloneFailedError({
      repo: req.repo_url,
      headSha: req.head_sha,
      reason: "missing github_installation_id",
    });
  }

  // Heartbeat BEFORE the clone shell-out so a stalled subprocess is detectable within the heartbeat
  // window. Mirrors the Python `activity.heartbeat({phase: "clone_started"})`.
  heartbeat({ phase: "clone_started" });
  try {
    await cloner.clone({
      workspace: workspacePath,
      repoUrl: req.repo_url,
      headSha: req.head_sha,
      installationId: githubInstallationId,
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
  // Heartbeat AFTER the clone returns.
  heartbeat({ phase: "clone_completed" });

  const byteSize = await byteSizeOfDir(workspacePath);
  if (byteSize > MAX_WORKSPACE_BYTES) {
    throw new WorkspaceTooLargeError({
      repo: req.repo_url,
      headSha: req.head_sha,
      byteSize,
    });
  }
  // Final heartbeat after the size check.
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
    installationId: number;
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
