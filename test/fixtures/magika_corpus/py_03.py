"""allocate_workspace_activity — Phase 6 spec §7.2.

Pure mkdir + DB lease INSERT + _meta/workspace.json write. Does NOT
touch git. Cheap enough to retry freely.

Idempotency: the ``ux_workspace_active_run`` partial unique index makes
re-allocation for the same ``run_id`` a no-op INSERT; the activity then
looks up the canonical row via ``find_active_by_run`` and returns its
:class:`WorkspaceHandle` (Temporal-retry safety).

The :func:`configure` function injects module-level dependencies at
worker startup, matching the pattern used by
:mod:`codemaster.activities.record_review_lifecycle`. Pre-configure
activity calls raise ``RuntimeError`` (fail-closed).

See ``docs/superpowers/specs/2026-05-14-workspace-lifecycle-design.md``
§7.2 (activity contract), §5.4 (meta-file schema), AD-13 (meta is
diagnostic-only — no reconciliation logic reads it).
"""

from __future__ import annotations

import json
import uuid
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from temporalio import activity

from codemaster.infra.clock import Clock
from codemaster.workspace._handle import WorkspaceHandle
from codemaster.workspace._lease_repo import LeaseRepo
from codemaster.workspace._manager import WorkspaceManager

_META_SCHEMA_VERSION: Final = 1


class AllocateWorkspaceInput(BaseModel):
    """Typed envelope for :func:`allocate_workspace_activity`.

    Constructed by the workflow body and passed across the Temporal
    activity boundary. ``extra='forbid'`` rejects accidental field
    additions; ``schema_version`` is incremented on shape changes per
    the codemaster cross-process data-contract rule.
    """

    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1

    run_id: uuid.UUID
    review_id: uuid.UUID
    installation_id: uuid.UUID
    # Numeric GitHub-side repository id for the diagnostic
    # ``_meta/workspace.json`` payload (AD-13/§5.4: meta is
    # diagnostic-only). Optional because the workflow body's typed
    # payload (``ReviewPullRequestPayloadV1``) carries
    # ``repository_id: uuid.UUID`` (the internal FK), not the GitHub
    # numeric id — surfacing the numeric id onto the workflow payload
    # is a separate change tracked outside Phase 6. Tests pass an int
    # directly; the workflow body passes ``None`` until the payload
    # gains a ``github_repo_id`` field.
    repo_id: int | None = None
    workflow_id: str  # Temporal workflow ID


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
            Owns path resolution + pod identity metadata. The activity
            reads ``manager._pod_metadata`` and ``manager._worker_id``
            for the lease-row + meta-file fields.
        session_factory: ``async_sessionmaker`` bound to the ``core`` DB
            pool. The activity opens its own short-lived session per
            invocation to keep the LeaseRepo write inside an explicit
            transaction.
        clock: :class:`~codemaster.infra.clock.Clock` implementation —
            production wires :class:`~codemaster.infra.clock.WallClock`;
            tests inject a :class:`~codemaster.infra.clock.FakeClock`
            for deterministic ``orphan_check_after`` and meta-file
            ``created_at`` values.
    """
    global _manager, _session_factory, _clock  # noqa: PLW0603 — worker-startup wiring
    _manager = manager
    _session_factory = session_factory
    _clock = clock


def _require_configured() -> tuple[WorkspaceManager, async_sessionmaker[AsyncSession], Clock]:
    if _manager is None or _session_factory is None or _clock is None:
        raise RuntimeError(
            "allocate_workspace_activity not configured; "
            "worker bootstrap must call configure() before activity registration"
        )
    return _manager, _session_factory, _clock


@activity.defn(name="allocate_workspace_activity")
async def allocate_workspace_activity(req: AllocateWorkspaceInput) -> WorkspaceHandle:
    """Allocate a fresh workspace for a review run.

    See module docstring for the broader contract. Steps:

    1. mkdir the workspace directory + ``_meta/`` subdirectory.
    2. INSERT the lease row via :class:`LeaseRepo` (ON CONFLICT DO
       NOTHING handles Temporal-retry idempotency on the partial unique
       index).
    3. ``find_active_by_run`` to get the canonical row (covers both
       new-insert and existing-reuse paths).
    4. Write ``_meta/workspace.json`` (DIAGNOSTIC ONLY per AD-13/§5.4)
       — idempotent: if the file exists, leave it.
    5. Return a :class:`WorkspaceHandle` constructed via
       ``manager.get_handle(workspace_id)``.

    Raises:
        RuntimeError: ``configure(...)`` has not been called, OR the
            lease row vanished between INSERT and SELECT (concurrent
            transition_lease moved it out of the active set; defensive
            error — should be impossible in practice).
    """
    manager, session_factory, clock = _require_configured()

    # 1. Build the on-disk path. installation_root + runs/<run_id>.
    install_root = manager.installation_root(req.installation_id)
    workspace_path = install_root / "runs" / str(req.run_id)
    meta_path = workspace_path / "_meta"
    workspace_path.mkdir(parents=True, exist_ok=True)
    meta_path.mkdir(parents=True, exist_ok=True)

    # 2. INSERT the lease row + look up the canonical row in one txn.
    candidate_workspace_id = uuid.uuid4()
    async with session_factory() as session, session.begin():
        repo = LeaseRepo(session)
        await repo.insert(
            workspace_id=candidate_workspace_id,
            run_id=req.run_id,
            review_id=req.review_id,
            installation_id=req.installation_id,
            pod_name=manager._pod_metadata.pod_name,
            pod_namespace=manager._pod_metadata.pod_namespace,
            node_name=manager._pod_metadata.node_name,
            worker_id=manager._worker_id,
            orphan_check_after=clock.now() + manager._config.workspace_orphan_grace,
        )
        # The ON CONFLICT may have made the INSERT a no-op (existing
        # active lease for this run_id from a prior retry). Look up
        # the canonical row by run_id, which is the partial-unique
        # business key.
        canonical = await repo.find_active_by_run(req.run_id)
        if canonical is None:
            # Should be impossible — INSERT or pre-existing row guarantees
            # find_active_by_run returns a row. If we reach here, a
            # concurrent transition_lease moved the row out of the active
            # set between INSERT and SELECT. Defensive error.
            raise RuntimeError(
                f"allocate_workspace_activity: no active lease for run_id={req.run_id!r}"
            )
        actual_workspace_id: uuid.UUID = canonical["workspace_id"]

    # 3. Write _meta/workspace.json (idempotent: skip if exists per AD-13).
    meta_file = meta_path / "workspace.json"
    if not meta_file.exists():
        meta_payload = {
            "workspace_id": str(actual_workspace_id),
            "run_id": str(req.run_id),
            "review_id": str(req.review_id),
            "installation_id": str(req.installation_id),
            "repo_id": req.repo_id,
            "workflow_id": req.workflow_id,
            "pod_name": manager._pod_metadata.pod_name,
            "pod_uid": manager._pod_metadata.pod_uid,
            "worker_id": manager._worker_id,
            "created_at": clock.now().isoformat().replace("+00:00", "Z"),
            "schema_version": _META_SCHEMA_VERSION,
        }
        meta_file.write_text(json.dumps(meta_payload, indent=2))

    # 4. Construct the handle. manager.get_handle hits the DB + resolves the
    # path; we already know the row exists so it cannot return None.
    handle = await manager.get_handle(actual_workspace_id)
    if handle is None:
        raise RuntimeError(
            f"allocate_workspace_activity: manager.get_handle returned None for "
            f"workspace_id={actual_workspace_id!r} (just-inserted lease)"
        )
    return handle


__all__ = ["AllocateWorkspaceInput", "allocate_workspace_activity", "configure"]
