/**
 * `allocateWorkspace` activity — pure `mkdir` + DB lease INSERT + handle construction. Does NOT touch
 * git — that is the separate `cloneRepoIntoWorkspace` activity. Cheap enough to retry freely
 * (CLAUDE.md core-loop discipline).
 *
 * ## Steps
 *
 *   1. Build the on-disk path: `<root>/installations/<installation_id>/runs/<run_id>` and `mkdir -p`.
 *   2. Mint a candidate `workspace_id` (uuid4) and INSERT an ALLOCATED lease row via {@link LeaseRepo}
 *      inside ONE transaction. `ON CONFLICT (run_id) WHERE state IN ('ALLOCATED','RELEASE_REQUESTED')
 *      DO NOTHING` makes the INSERT a no-op under Temporal retry (the partial-unique index
 *      `ux_workspace_active_run`).
 *   3. `findActiveByRun(run_id)` resolves the CANONICAL row — covers both the fresh-insert path AND
 *      the reuse path (a prior retry's row). The canonical `workspace_id` may differ from the
 *      candidate when an earlier attempt already owns the active lease.
 *   4. Resolve the workspace path (`realpath`, after mkdir so it exists) + validate it is contained
 *      under the resolved root (rejecting a hostile symlink escape) and return a {@link WorkspaceHandle}.
 *
 * The `_meta/workspace.json` write is AD-13 diagnostic-only (no reconciliation logic reads it) and is
 * explicitly DROPPED — the observable contract (the lease row + the returned handle) does not depend on it.
 *
 * ## Pod identity + root + orphan grace
 *
 * Pod/worker identity + workspace root + orphan-grace timedelta are read from env (the K8s Downward
 * API surface: `POD_NAME` / `POD_NAMESPACE` / `NODE_NAME`, plus `WORKER_ID` and
 * `CODEMASTER_WORKSPACE_ROOT`) with sane non-empty defaults so the NOT-NULL lease columns are always
 * satisfied. `orphan_check_after = clock.now() + 30min` is inlined — the full config object is NOT ported.
 *
 * ## Transaction / pool discipline (ADR-0062)
 *
 * The activity opens ONE transaction over the shared ADR-0062 pool (`tenantKysely(dsn)` when no `db`
 * is injected). {@link LeaseRepo} takes the injected transaction; the activity owns the boundary so
 * the INSERT + the canonical SELECT commit together. The clock seam governs `orphan_check_after`
 * deterministically under a {@link FakeClock} in tests.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { LeaseRepo } from "#backend/workspace/lease_repo.js";
import { WorkspaceSecurityViolation } from "#backend/workspace/errors.js";

import { tenantKysely } from "#platform/db/database.js";
import { type Clock, WallClock } from "#platform/clock.js";
import { SystemRandom } from "#platform/randomness.js";

import { WorkspaceHandle } from "#contracts/workspace_handle.v1.js";
import type { AllocateWorkspaceInput } from "#contracts/allocate_workspace_input.v1.js";

import type { Kysely } from "kysely";

/** Default workspace root when `CODEMASTER_WORKSPACE_ROOT` is unset. Non-empty. */
const DEFAULT_WORKSPACE_ROOT = "/var/lib/codemaster/workspaces";

/** Orphan grace, inlined from `WorkspaceConfig.workspace_orphan_grace` default (30 minutes). */
const ORPHAN_GRACE_SECONDS = 30 * 60;

/** Module-shared CSPRNG seam — the sanctioned crypto-randomness entry point (clock/random gate). */
const RANDOM = new SystemRandom();

/**
 * Mint a random RFC4122 v4 UUID (canonical lowercase hyphenated) via the platform randomness seam
 * (122 random bits). Minted via `SystemRandom.tokenBytes` because the clock/random gate bans
 * `crypto.randomUUID` outside the seam file.
 */
function uuid4(): string {
  const b = Buffer.from(RANDOM.tokenBytes(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * K8s pod / worker identity for the lease row. Sourced from the Downward-API env vars at pod spec
 * time; defaults are non-empty so the NOT-NULL columns (`pod_name`/`pod_namespace`/`worker_id`) never
 * receive an empty/NULL value. `nodeName` is nullable (the column is) — `NODE_NAME` may be unset
 * briefly during scheduling, so an unset value is `null`, not a default string.
 */
export type PodIdentity = {
  podName: string;
  podNamespace: string;
  nodeName: string | null;
  workerId: string;
};

/** Read {@link PodIdentity} from the Downward-API env vars with non-empty defaults (static env access — no injection sink). */
function podIdentityFromEnv(): PodIdentity {
  const podName = process.env.POD_NAME;
  const podNamespace = process.env.POD_NAMESPACE;
  const nodeName = process.env.NODE_NAME;
  const workerId = process.env.WORKER_ID;
  return {
    podName: podName !== undefined && podName !== "" ? podName : "codemaster-worker",
    podNamespace: podNamespace !== undefined && podNamespace !== "" ? podNamespace : "codemaster",
    nodeName: nodeName !== undefined && nodeName !== "" ? nodeName : null,
    workerId: workerId !== undefined && workerId !== "" ? workerId : "worker-0",
  };
}

/** The workspace root from `CODEMASTER_WORKSPACE_ROOT`, else {@link DEFAULT_WORKSPACE_ROOT}. */
function workspaceRootFromEnv(): string {
  const root = process.env.CODEMASTER_WORKSPACE_ROOT;
  return root !== undefined && root !== "" ? root : DEFAULT_WORKSPACE_ROOT;
}

/**
 * Injected collaborators. All OPTIONAL — production resolves every one from env / the ADR-0062 shared
 * pool; tests inject a disposable-PG `db`, a {@link FakeClock}, a tmpdir `workspaceRoot`, and a fixed
 * identity so the lease row + the derived path are deterministic.
 */
export type AllocateWorkspaceDeps = {
  /** Kysely over the shared ADR-0062 pool. When omitted, built from `CODEMASTER_PG_CORE_DSN`. */
  db?: Kysely<unknown>;
  /** Time seam; default {@link WallClock}. Governs `orphan_check_after`. */
  clock?: Clock;
  /** Workspace root; default from `CODEMASTER_WORKSPACE_ROOT` env. */
  workspaceRoot?: string;
  /** Pod/worker identity for the lease row; default from the Downward-API env vars. */
  identity?: PodIdentity;
};

/**
 * Compute `<root>/installations/<installation_id>/runs/<run_id>` (the INTENDED, pre-validation path).
 */
export function deriveWorkspacePath(
  workspaceRoot: string,
  installationId: string,
  runId: string,
): string {
  return path.join(workspaceRoot, "installations", installationId, "runs", runId);
}

/**
 * Canonicalize + validate the (now-existing) workspace path is contained under the resolved root.
 * `realpath` follows symlinks, then we assert the resolved path is under the resolved root. A hostile
 * symlink escape (`runs/y → /etc`) resolves outside the root → {@link WorkspaceSecurityViolation}.
 * The directory MUST exist (the caller mkdir'd it) — a missing path is treated as a violation.
 */
async function resolveAndValidate(workspaceRoot: string, candidate: string): Promise<string> {
  let rootResolved: string;
  let resolved: string;
  try {
    rootResolved = await fs.realpath(workspaceRoot);
    resolved = await fs.realpath(candidate);
  } catch (e) {
    throw new WorkspaceSecurityViolation(
      `path ${JSON.stringify(candidate)} escapes root ${JSON.stringify(workspaceRoot)}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  const rel = path.relative(rootResolved, resolved);
  // `relative` returns a path starting with ".." (or an absolute path on a different volume) when
  // `resolved` is NOT under `rootResolved`; that lexical check is how this rejects an escaping path.
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new WorkspaceSecurityViolation(
      `path ${JSON.stringify(candidate)} escapes root ${JSON.stringify(workspaceRoot)}`,
    );
  }
  return resolved;
}

/** Resolve the Kysely handle: the injected one, else built from `CODEMASTER_PG_CORE_DSN`. */
function resolveDb(deps: AllocateWorkspaceDeps): Kysely<unknown> {
  if (deps.db !== undefined) {
    return deps.db;
  }
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set and no db injected; cannot allocate a workspace lease",
    );
  }
  return tenantKysely<unknown>(dsn);
}

/**
 * Allocate a fresh workspace for a review run. Returns the validated {@link WorkspaceHandle}.
 *
 * @throws {Error} the lease row vanished between INSERT and the canonical SELECT (a concurrent
 *                 transition moved it out of the active set; defensive — should be impossible).
 * @throws {WorkspaceSecurityViolation} the resolved workspace path escapes the resolved root.
 */
export async function allocateWorkspace(
  req: AllocateWorkspaceInput,
  deps: AllocateWorkspaceDeps = {},
): Promise<WorkspaceHandle> {
  const clock: Clock = deps.clock ?? new WallClock();
  const workspaceRoot = deps.workspaceRoot ?? workspaceRootFromEnv();
  const identity = deps.identity ?? podIdentityFromEnv();
  const db = resolveDb(deps);

  // 1. Build the on-disk path + mkdir -p (idempotent: exist_ok). `_meta/` subdir omitted (AD-13 drop).
  const workspacePath = deriveWorkspacePath(workspaceRoot, req.installation_id, req.run_id);
  await fs.mkdir(workspacePath, { recursive: true });

  // 2. + 3. INSERT the lease row (idempotent ON CONFLICT) + resolve the canonical row in ONE txn. The
  // candidate workspace_id may be discarded if an earlier retry already owns the active lease.
  const candidateWorkspaceId = uuid4();
  const orphanCheckAfter = new Date(clock.now().getTime() + ORPHAN_GRACE_SECONDS * 1000);

  const actualWorkspaceId = await db.transaction().execute(async (tx) => {
    const repo = new LeaseRepo({ db: tx });
    await repo.insert({
      workspaceId: candidateWorkspaceId,
      runId: req.run_id,
      reviewId: req.review_id,
      installationId: req.installation_id,
      podName: identity.podName,
      podNamespace: identity.podNamespace,
      nodeName: identity.nodeName,
      workerId: identity.workerId,
      orphanCheckAfter,
    });
    const canonical = await repo.findActiveByRun(req.run_id);
    if (canonical === undefined) {
      // The INSERT (or a pre-existing active row) guarantees findActiveByRun returns a row. Reaching
      // here means a concurrent transition moved the row out of the active set between INSERT and
      // SELECT — defensive, should be impossible.
      throw new Error(
        `allocateWorkspace: no active lease for run_id=${JSON.stringify(req.run_id)} after insert`,
      );
    }
    return canonical.workspace_id;
  });

  // 4. Resolve + validate the path (it exists now — we just mkdir'd it) and build the handle.
  const derivedPath = await resolveAndValidate(workspaceRoot, workspacePath);

  return WorkspaceHandle.parse({
    workspace_id: actualWorkspaceId,
    installation_id: req.installation_id,
    run_id: req.run_id,
    derived_path: derivedPath,
    state: "ALLOCATED",
  });
}
