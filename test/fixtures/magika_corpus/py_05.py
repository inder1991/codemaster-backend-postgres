"""release_workspace_activity — Phase 6 spec §7.4.

Idempotent + globally callable cleanup. Legal entry states:
``ALLOCATED``, ``RELEASE_REQUESTED``, ``FAILED_CLEANUP``, ``ORPHANED``.

Called by:

- Workflow body (happy path: ``ALLOCATED`` → ``RELEASE_REQUESTED`` →
  ``RELEASED``)
- Janitor (orphan reap: ``ORPHANED`` → ``RELEASE_REQUESTED`` →
  ``RELEASED``)
- Janitor (``FAILED_CLEANUP`` retry: re-enter from ``FAILED_CLEANUP``)
- Operator tools (any legal state)

Per spec §6.2:

- On :class:`WorkspaceSecurityViolation`: transition to
  ``FAILED_CLEANUP`` and re-raise. The workflow body MUST re-raise this
  exception — it is the only cleanup failure that fails the workflow.
- On transient I/O failure (``OSError`` from ``shutil.rmtree``):
  transition to ``FAILED_CLEANUP`` and raise. The workflow body's outer
  try/except absorbs (cleanup-success-independence, spec §6.1).

Returns ``None`` on success, on already-``RELEASED``, and on missing
lease (fully idempotent — already gone).

State-machine discipline
========================

The migration-0076 ``ck_workspace_leases_release_requested`` CHECK
requires ``release_requested_at IS NOT NULL`` whenever ``state`` is in
``('RELEASE_REQUESTED', 'RELEASED', 'FAILED_CLEANUP')``. So entries
from ``ALLOCATED`` and ``ORPHANED`` (which have no
``release_requested_at`` set) MUST first transition through
``RELEASE_REQUESTED`` before the final flip — otherwise the CHECK fires.

Path-validation tolerance
=========================

``WorkspaceManager._resolve_path`` uses ``strict=True`` because at
allocation/clone time the directory MUST exist. At release time the
directory may legitimately be gone already (idempotent retry after a
crash between rmtree and the DB flip). The local
:func:`_validate_cleanup_path` helper tolerates a missing leaf but
still detects hostile-symlink / path-traversal escapes by comparing the
resolved (or lexically-collapsed) path against the resolved root.

See ``docs/superpowers/specs/2026-05-14-workspace-lifecycle-design.md``
§7.4 (activity contract), §6 (cleanup-success-independence), §6.3
(idempotency).
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from temporalio import activity

from codemaster.infra.clock import Clock
from codemaster.workspace._errors import WorkspaceSecurityViolation
from codemaster.workspace._lease_repo import LeaseRepo
from codemaster.workspace._manager import WorkspaceManager
from codemaster.workspace._transition import transition_lease


class ReleaseWorkspaceInput(BaseModel):
    """Typed envelope for :func:`release_workspace_activity`.

    Constructed by the workflow body, janitor, or operator tools and
    passed across the Temporal activity boundary. ``extra='forbid'``
    rejects accidental field additions; ``schema_version`` is
    incremented on shape changes per the codemaster cross-process
    data-contract rule.
    """

    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1

    workspace_id: uuid.UUID


# Module-level dependency injection. The worker bootstrap (Task 16) calls
# configure() before registering activities.
_manager: WorkspaceManager | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None
_clock: Clock | None = None


def configure(
    *,
    manager: WorkspaceManager,
    session_factory: async_sessionmaker[AsyncSession],
    clock: Clock,
) -> None:
    """Inject module-level dependencies. Called by worker bootstrap (Task 16).

    Args:
        manager: Worker-process singleton :class:`WorkspaceManager`.
            Used for path resolution (``installation_root``,
            ``_root_resolved``) and for cache invalidation
            (``invalidate_handle``).
        session_factory: ``async_sessionmaker`` bound to the ``core`` DB
            pool. Each transition opens its own short-lived transaction
            so the state flip + event emit commit atomically without
            holding the row lock across the rmtree I/O.
        clock: :class:`~codemaster.infra.clock.Clock` implementation —
            forwarded to :func:`transition_lease` so its timestamp +
            event emit observe a consistent clock under tests with a
            :class:`~codemaster.infra.clock.FakeClock`.
    """
    global _manager, _session_factory, _clock  # noqa: PLW0603 — worker-startup wiring
    _manager = manager
    _session_factory = session_factory
    _clock = clock


def _require_configured() -> tuple[WorkspaceManager, async_sessionmaker[AsyncSession], Clock]:
    if _manager is None or _session_factory is None or _clock is None:
        raise RuntimeError(
            "release_workspace_activity not configured; "
            "worker bootstrap must call configure() before activity registration"
        )
    return _manager, _session_factory, _clock


def _validate_cleanup_path(workspace_root_resolved: Path, candidate: Path) -> Path:
    """Validate that ``candidate`` is contained under ``workspace_root_resolved``.

    Unlike :meth:`WorkspaceManager._resolve_path` (which uses
    ``strict=True`` for allocation-time validation), this helper
    tolerates a missing directory — the release activity must succeed
    even when the workspace was already cleaned (idempotency on retry).
    But it still detects path-traversal escapes (e.g., hostile symlink
    swap) by comparing the resolved path against the resolved root.

    Args:
        workspace_root_resolved: The canonicalized workspace root
            (i.e., :attr:`WorkspaceManager._root_resolved` after
            preflight, or the on-demand resolve fallback).
        candidate: The intended workspace directory path. May or may
            not exist on disk.

    Returns:
        The validated path (resolved if it exists, lexically-collapsed
        otherwise).

    Raises:
        WorkspaceSecurityViolation: ``candidate`` escapes
            ``workspace_root_resolved``.
    """
    try:
        resolved = candidate.resolve(strict=False)
        resolved.relative_to(workspace_root_resolved)
    except (ValueError, FileNotFoundError) as e:
        raise WorkspaceSecurityViolation(
            f"path {candidate!r} escapes root {workspace_root_resolved!r}"
        ) from e
    return resolved


async def _transition(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    workspace_id: uuid.UUID,
    from_state: str,
    to_state: str,
    reason: str | None,
    clock: Clock,
) -> None:
    """Open a one-shot transaction and run :func:`transition_lease`.

    Used internally to keep each state transition in its own
    transaction. The rmtree I/O happens between transitions and MUST
    NOT hold a DB row lock — long-running filesystem work on a held
    lease lock would block concurrent workflow visibility queries and
    the janitor's orphan sweep.
    """
    async with session_factory() as session, session.begin():
        await transition_lease(
            session,
            workspace_id=workspace_id,
            from_state=from_state,
            to_state=to_state,
            activity="release_workspace_activity",
            reason=reason,
            clock=clock,
        )


async def _transition_to_failed_cleanup(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    workspace_id: uuid.UUID,
    from_state: str,
    reason: str,
    clock: Clock,
) -> None:
    """Transition to FAILED_CLEANUP + bump the janitor backoff metadata.

    Per spec §10.1 the janitor's FAILED_CLEANUP retry advances through
    ``cfg.cleanup_backoff_schedule`` indexed by ``cleanup_attempts``.
    transition_lease handles the state + ``cleanup_failed_at`` per the
    migration-0076 CHECK; this wrapper additionally bumps
    ``cleanup_attempts``, stamps ``last_cleanup_attempt_at``, and writes
    ``last_cleanup_error`` so the next reap pass sees the right backoff
    index. Both updates happen in one transaction so the row never
    appears with a stamped state but stale attempt counter.
    """
    async with session_factory() as session, session.begin():
        await transition_lease(
            session,
            workspace_id=workspace_id,
            from_state=from_state,
            to_state="FAILED_CLEANUP",
            activity="release_workspace_activity",
            reason=reason,
            clock=clock,
        )
        await session.execute(
            text(
                "UPDATE core.workspace_leases "
                "SET cleanup_attempts = cleanup_attempts + 1, "
                "    last_cleanup_attempt_at = :now, "
                "    last_cleanup_error = :reason "
                "WHERE workspace_id = :workspace_id"
            ),
            {
                "now": clock.now(),
                "reason": reason[:1024],  # bound the column write
                "workspace_id": workspace_id,
            },
        )


@activity.defn(name="release_workspace_activity")
async def release_workspace_activity(req: ReleaseWorkspaceInput) -> None:
    """Release a workspace. See module docstring for the full contract.

    Steps:

    1. Look up the lease. Missing lease → idempotent no-op (invalidate
       handle cache, return).
    2. If state is already ``RELEASED``: idempotent no-op (return).
    3. If state is ``ALLOCATED`` or ``ORPHANED``: transition through
       ``RELEASE_REQUESTED`` first (required by the migration-0076
       CHECK; see module docstring).
    4. Compute + validate the workspace path. On
       :class:`WorkspaceSecurityViolation`: transition to
       ``FAILED_CLEANUP`` and re-raise.
    5. ``shutil.rmtree`` the directory (if it still exists). On
       ``OSError``: transition to ``FAILED_CLEANUP`` and raise.
    6. Transition to ``RELEASED``.
    7. Invalidate the manager's cached handle.

    Args:
        req: Typed envelope carrying the ``workspace_id`` to release.

    Raises:
        RuntimeError: ``configure(...)`` has not been called.
        WorkspaceSecurityViolation: path-validation rejected the
            candidate cleanup path. The lease is left in
            ``FAILED_CLEANUP``; the workflow body MUST re-raise this
            (spec §6.2).
        OSError: ``shutil.rmtree`` failed transiently. The lease is
            left in ``FAILED_CLEANUP``; the workflow body absorbs
            (spec §6.1 cleanup-success-independence).
        StateDrift: a concurrent transition moved the row out of the
            expected pre-state between the SELECT and the transition.
            Caller treats as transient and retries.
    """
    manager, session_factory, clock = _require_configured()
    workspace_id = req.workspace_id

    # 1. Look up the lease.
    async with session_factory() as session:
        repo = LeaseRepo(session)
        row = await repo.get_by_id(workspace_id)

    if row is None:
        # No lease — fully idempotent (already gone). Drop any stale
        # cache entry just in case a prior call seeded one.
        manager.invalidate_handle(workspace_id)
        return

    current_state: str = row["state"]
    if current_state == "RELEASED":
        # 2. Idempotent no-op — RELEASED is terminal.
        return

    # 3. ALLOCATED / ORPHANED entries need a RELEASE_REQUESTED hop first
    # so the migration-0076 ck_workspace_leases_release_requested CHECK
    # observes a populated release_requested_at when the final RELEASED
    # / FAILED_CLEANUP flip lands.
    if current_state in ("ALLOCATED", "ORPHANED"):
        await _transition(
            session_factory,
            workspace_id=workspace_id,
            from_state=current_state,
            to_state="RELEASE_REQUESTED",
            reason="release_workspace_activity entry",
            clock=clock,
        )
        current_state = "RELEASE_REQUESTED"

    # current_state is now one of: RELEASE_REQUESTED, FAILED_CLEANUP.
    # Both have release_requested_at IS NOT NULL (CHECK invariant), so
    # the transition to RELEASED / FAILED_CLEANUP that follows will
    # satisfy the schema.

    # 4. Compute + validate the workspace path. _root_resolved is
    # populated by preflight(); the lexical fallback covers tests that
    # construct a manager without calling preflight.
    installation_id: uuid.UUID = row["installation_id"]
    run_id: uuid.UUID = row["run_id"]
    root_resolved = (
        manager._root_resolved
        if manager._root_resolved is not None
        else manager._root.resolve(strict=False)
    )
    candidate = manager.installation_root(installation_id) / "runs" / str(run_id)

    try:
        resolved = _validate_cleanup_path(root_resolved, candidate)
    except WorkspaceSecurityViolation:
        await _transition_to_failed_cleanup(
            session_factory,
            workspace_id=workspace_id,
            from_state=current_state,
            reason="security_violation",
            clock=clock,
        )
        raise

    # 5. rmtree (if directory still exists). Idempotent on missing dir.
    if resolved.exists():
        try:
            shutil.rmtree(resolved)
        except OSError as e:
            await _transition_to_failed_cleanup(
                session_factory,
                workspace_id=workspace_id,
                from_state=current_state,
                reason=f"rmtree failed: {e!s}",
                clock=clock,
            )
            raise

    # 6. Mark RELEASED.
    await _transition(
        session_factory,
        workspace_id=workspace_id,
        from_state=current_state,
        to_state="RELEASED",
        reason=None,
        clock=clock,
    )

    # 7. Invalidate cached handle.
    manager.invalidate_handle(workspace_id)


__all__ = [
    "ReleaseWorkspaceInput",
    "configure",
    "release_workspace_activity",
]
