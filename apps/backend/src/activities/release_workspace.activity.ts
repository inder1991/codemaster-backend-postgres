/**
 * `releaseWorkspace` activity — idempotent + globally-callable cleanup. Legal entry states:
 * `ALLOCATED`, `RELEASE_REQUESTED`, `FAILED_CLEANUP`, `ORPHANED`. Called by the workflow body
 * (happy path), the janitor (orphan reap + FAILED_CLEANUP retry), and operator tools.
 *
 * ## Steps
 *
 *   1. `getById(workspace_id)`. Missing → idempotent no-op (return).
 *   2. `RELEASED` → idempotent no-op (terminal; return).
 *   3. `ALLOCATED` / `ORPHANED` → hop through `RELEASE_REQUESTED` first. The migration
 *      `ck_workspace_leases_release_requested` CHECK requires `release_requested_at IS NOT NULL`
 *      whenever state ∈ {RELEASE_REQUESTED, RELEASED, FAILED_CLEANUP}; ALLOCATED/ORPHANED have no
 *      such timestamp, so the final RELEASED/FAILED_CLEANUP flip MUST be preceded by the
 *      RELEASE_REQUESTED hop that stamps it.
 *   4. Compute + validate the workspace path. On {@link WorkspaceSecurityViolation}: transition to
 *      FAILED_CLEANUP and RE-RAISE (spec §6.2 — the ONLY cleanup failure that fails the workflow).
 *   5. `rm -rf` the directory (if it still exists). On an I/O error: transition to FAILED_CLEANUP and
 *      raise (the workflow body's outer try/except absorbs — cleanup-success-independence, spec §6.1).
 *   6. Transition to RELEASED.
 *
 * Each state transition runs in its OWN one-shot transaction so the `rm -rf` I/O between transitions
 * never holds a lease row lock (long filesystem work on a held lock would block the janitor's orphan
 * sweep + concurrent visibility queries). {@link transitionLease} emits the `WORKSPACE_<state>` audit
 * event in the SAME transaction as the state flip.
 *
 * ## Path-validation tolerance (the release-specific divergence from allocate)
 *
 * At release time the directory may LEGITIMATELY be gone already (idempotent retry after a crash
 * between `rm` and the DB flip). So validation tolerates a missing leaf — unlike the allocate-time
 * resolve, which requires the dir to exist. But it STILL detects a hostile-symlink / path-traversal
 * escape by resolving the deepest-existing ancestor (following symlinks) and lexically collapsing the
 * rest, then asserting containment under the resolved root.
 *
 * ## Pod identity / root / pool — same env + ADR-0062 seams as the allocate activity.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { LeaseRepo } from "#backend/workspace/lease_repo.js";
import { WorkspaceSecurityViolation } from "#backend/workspace/errors.js";
import { transitionLease } from "#backend/workspace/transition.js";

import { tenantKysely } from "#platform/db/database.js";
import { type Clock, WallClock } from "#platform/clock.js";

import type { ReleaseWorkspaceInput } from "#contracts/release_workspace_input.v1.js";

import { type Kysely, sql, type Transaction } from "kysely";

/** Default workspace root when `CODEMASTER_WORKSPACE_ROOT` is unset (same value as the allocate activity). */
const DEFAULT_WORKSPACE_ROOT = "/var/lib/codemaster/workspaces";

/** Max length of the `last_cleanup_error` column write (`reason[:1024]` bound). */
const MAX_CLEANUP_ERROR_LEN = 1024;

/**
 * Injected collaborators. All OPTIONAL — production resolves the `db` from `CODEMASTER_PG_CORE_DSN`
 * (the ADR-0062 shared pool) + the root from env; tests inject a disposable-PG `db`, a {@link FakeClock},
 * and a tmpdir `workspaceRoot`.
 */
export type ReleaseWorkspaceDeps = {
  /** Kysely over the shared ADR-0062 pool. When omitted, built from `CODEMASTER_PG_CORE_DSN`. */
  db?: Kysely<unknown>;
  /** Time seam; default {@link WallClock}. Forwarded to {@link transitionLease} + the FAILED_CLEANUP stamps. */
  clock?: Clock;
  /** Workspace root; default from `CODEMASTER_WORKSPACE_ROOT` env. */
  workspaceRoot?: string;
};

/** The workspace root from `CODEMASTER_WORKSPACE_ROOT`, else {@link DEFAULT_WORKSPACE_ROOT}. */
function workspaceRootFromEnv(): string {
  const root = process.env.CODEMASTER_WORKSPACE_ROOT;
  return root !== undefined && root !== "" ? root : DEFAULT_WORKSPACE_ROOT;
}

/** Resolve the Kysely handle: the injected one, else built from `CODEMASTER_PG_CORE_DSN`. */
function resolveDb(deps: ReleaseWorkspaceDeps): Kysely<unknown> {
  if (deps.db !== undefined) {
    return deps.db;
  }
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set and no db injected; cannot release a workspace lease",
    );
  }
  return tenantKysely<unknown>(dsn);
}

/**
 * `realpath` the deepest EXISTING ancestor of `candidate` (following symlinks), then lexically rejoin
 * the trailing components that do not yet (or no longer) exist. Resolves as much of the path as exists,
 * collapses the rest lexically.
 *
 * This is the release-time path resolver: it tolerates a missing leaf (the dir may already be gone)
 * while still following symlinks on the existing prefix so a hostile symlink swap on an ancestor
 * (`installations/<iid> → /etc`) is detected by the containment check the caller performs.
 */
async function resolveNonStrict(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  const parts = absolute.split(path.sep);
  // Walk from the full path down to the root, finding the deepest prefix that realpath can resolve.
  for (let depth = parts.length; depth >= 1; depth--) {
    const prefix = parts.slice(0, depth).join(path.sep) || path.sep;
    try {
      const realPrefix = await fs.realpath(prefix);
      const remainder = parts.slice(depth);
      return remainder.length === 0 ? realPrefix : path.join(realPrefix, ...remainder);
    } catch {
      // This prefix does not exist (or is a dangling symlink) — try a shorter one.
      continue;
    }
  }
  // No prefix resolved (not even the filesystem root) — fall back to the lexical absolute path.
  return absolute;
}

/**
 * Validate `candidate` is contained under `workspaceRoot`, TOLERATING a missing leaf. Returns the
 * resolved (or lexically-collapsed) path on success.
 *
 * @throws {WorkspaceSecurityViolation} `candidate` escapes the resolved root (hostile symlink /
 *         path traversal).
 */
async function validateCleanupPath(workspaceRoot: string, candidate: string): Promise<string> {
  // The root itself must resolve (it exists at preflight); a non-existent root is itself a violation.
  let rootResolved: string;
  try {
    rootResolved = await fs.realpath(workspaceRoot);
  } catch (e) {
    throw new WorkspaceSecurityViolation(
      `path ${JSON.stringify(candidate)} escapes root ${JSON.stringify(workspaceRoot)}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  const resolved = await resolveNonStrict(candidate);
  const rel = path.relative(rootResolved, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new WorkspaceSecurityViolation(
      `path ${JSON.stringify(candidate)} escapes root ${JSON.stringify(workspaceRoot)}`,
    );
  }
  return resolved;
}

/**
 * Open a one-shot transaction and run {@link transitionLease}. Each transition gets its own txn so
 * the `rm -rf` I/O between transitions never holds a row lock.
 */
async function runTransition(
  db: Kysely<unknown>,
  args: {
    workspaceId: string;
    fromState: string;
    toState: string;
    reason: string | null;
    clock: Clock;
  },
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await transitionLease({
      tx,
      workspaceId: args.workspaceId,
      fromState: args.fromState,
      toState: args.toState,
      activity: "release_workspace_activity",
      reason: args.reason,
      clock: args.clock,
    });
  });
}

/**
 * Transition to FAILED_CLEANUP + bump the janitor backoff metadata, in ONE transaction.
 * {@link transitionLease} stamps the state + `cleanup_failed_at` (the biconditional CHECK), and the
 * follow-up UPDATE bumps `cleanup_attempts`, stamps `last_cleanup_attempt_at`, and writes the bounded
 * `last_cleanup_error` so the next reap pass sees the right backoff index. Both updates share one
 * COMMIT so the row never appears with a stamped state but a stale attempt counter.
 */
async function transitionToFailedCleanup(
  db: Kysely<unknown>,
  args: { workspaceId: string; fromState: string; reason: string; clock: Clock },
): Promise<void> {
  await db.transaction().execute(async (tx: Transaction<unknown>) => {
    await transitionLease({
      tx,
      workspaceId: args.workspaceId,
      fromState: args.fromState,
      toState: "FAILED_CLEANUP",
      activity: "release_workspace_activity",
      reason: args.reason,
      clock: args.clock,
    });
    // tenant:exempt reason=PK-update-by-workspace_id follow_up=PERMANENT-EXEMPTION-workspace-lease-pk
    await sql`
      UPDATE core.workspace_leases
         SET cleanup_attempts = cleanup_attempts + 1,
             last_cleanup_attempt_at = ${args.clock.now()},
             last_cleanup_error = ${args.reason.slice(0, MAX_CLEANUP_ERROR_LEN)}
       WHERE workspace_id = ${args.workspaceId}
    `.execute(tx);
  });
}

/**
 * Release a workspace. Returns `void`.
 *
 * @throws {WorkspaceSecurityViolation} path validation rejected the cleanup path. The lease is left in
 *         FAILED_CLEANUP; the workflow body MUST re-raise this (spec §6.2).
 * @throws {Error} `rm -rf` failed transiently. The lease is left in FAILED_CLEANUP; the workflow body
 *         absorbs (spec §6.1 cleanup-success-independence).
 * @throws {StateDrift} a concurrent transition moved the row out of the expected pre-state.
 */
export async function releaseWorkspace(
  req: ReleaseWorkspaceInput,
  deps: ReleaseWorkspaceDeps = {},
): Promise<void> {
  const clock: Clock = deps.clock ?? new WallClock();
  const workspaceRoot = deps.workspaceRoot ?? workspaceRootFromEnv();
  const db = resolveDb(deps);
  const workspaceId = req.workspace_id;

  // 1. Look up the lease (no txn — a plain read).
  const repo = new LeaseRepo({ db });
  const row = await repo.getById(workspaceId);
  if (row === undefined) {
    // No lease — fully idempotent (already gone). No handle cache to invalidate in this port.
    return;
  }

  let currentState = row.state;
  if (currentState === "RELEASED") {
    // 2. Idempotent no-op — RELEASED is terminal.
    return;
  }

  // 3. ALLOCATED / ORPHANED entries need a RELEASE_REQUESTED hop first so the biconditional CHECK
  // observes a populated release_requested_at when the final flip lands.
  if (currentState === "ALLOCATED" || currentState === "ORPHANED") {
    await runTransition(db, {
      workspaceId,
      fromState: currentState,
      toState: "RELEASE_REQUESTED",
      reason: "release_workspace_activity entry",
      clock,
    });
    currentState = "RELEASE_REQUESTED";
  }

  // currentState is now RELEASE_REQUESTED or FAILED_CLEANUP — both carry release_requested_at NOT NULL.

  // 4. Compute + validate the workspace path. On violation: FAILED_CLEANUP + re-raise.
  const installationId = row.installation_id;
  const runId = row.run_id;
  const candidate = path.join(workspaceRoot, "installations", installationId, "runs", runId);

  let resolved: string;
  try {
    resolved = await validateCleanupPath(workspaceRoot, candidate);
  } catch (e) {
    if (e instanceof WorkspaceSecurityViolation) {
      await transitionToFailedCleanup(db, {
        workspaceId,
        fromState: currentState,
        reason: "security_violation",
        clock,
      });
    }
    throw e;
  }

  // 5. rm -rf (if the directory still exists). Idempotent on a missing dir (`force: true`). On an I/O
  // error: FAILED_CLEANUP + raise (the workflow body absorbs).
  try {
    await fs.rm(resolved, { recursive: true, force: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await transitionToFailedCleanup(db, {
      workspaceId,
      fromState: currentState,
      reason: `rm failed: ${message}`,
      clock,
    });
    throw e;
  }

  // 6. Mark RELEASED (emits WORKSPACE_RELEASED in the same txn).
  await runTransition(db, {
    workspaceId,
    fromState: currentState,
    toState: "RELEASED",
    reason: null,
    clock,
  });
}
