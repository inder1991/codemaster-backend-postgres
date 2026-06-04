"""clone_repo_into_workspace_activity — Phase 6 spec §7.3.

Workspace-aware replacement for the legacy ``clone_repo_for_review``
activity (deleted in Phase 6 Task 18). Clones git directly into the
:class:`WorkspaceHandle`'s ``derived_path``. Asserts lease state
``ALLOCATED`` before doing any work; raises :class:`StateDrift` if
the row has moved.

The 200 MiB workspace-size cap (``MAX_WORKSPACE_BYTES``) and the
``CloneFailedError`` / ``WorkspaceTooLargeError`` taxonomy live in
:mod:`codemaster.activities._clone_common` (relocated from the
legacy module in Phase 6 Task 18 so the symbols outlive their
original home).

WorkspaceHandle is a Pydantic v2 :class:`~pydantic.BaseModel` (Phase 6
Task 17 converted it from a stdlib frozen ``@dataclass`` to make the
handle JSON-serializable through Temporal's default payload converter).
:class:`CloneRepoIntoWorkspaceInput` therefore embeds it as a regular
Pydantic field — no ``arbitrary_types_allowed`` shim needed.

State-machine discipline
========================

Step 1 of the activity is a no-op transition_lease(from=ALLOCATED,
to=ALLOCATED). The function returns ``ALREADY_APPLIED`` (the UPDATE
branch is structurally impossible when current==to==from) and raises
:class:`StateDrift` if the row has moved. We then immediately
``LeaseRepo.touch_heartbeat`` so the janitor's orphan-check timer
advances. Both happen inside one transaction so the assertion + the
heartbeat-bump observe the same lock-acquired row state.

See ``docs/superpowers/specs/2026-05-14-workspace-lifecycle-design.md``
§7.3 (activity contract).
"""

from __future__ import annotations

from typing import Final, Literal

from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from temporalio import activity

from codemaster.activities._clone_common import (
    MAX_WORKSPACE_BYTES,
    CloneFailedError,
    GitCloner,
    WorkspaceTooLargeError,
    _byte_size_of_dir,
)
from codemaster.infra.clock import Clock
from codemaster.integrations.git.cloner import _REPO_SUBDIR
from codemaster.workspace._handle import WorkspaceHandle
from codemaster.workspace._lease_repo import LeaseRepo
from codemaster.workspace._transition import LeaseTransitionOutcome, transition_lease
from contracts.cloned_repo.v1 import ClonedRepoV1

# Minimum-acceptable length for a head SHA — git's standard short-SHA
# width. Anything shorter is treated as a missing/typoed SHA and raises
# ``CloneFailedError`` before the cloner is invoked. Preserved verbatim
# from the Sprint-9 ``_do_clone`` precondition that this activity
# replaces.
_MIN_HEAD_SHA_LEN: Final = 7


class CloneRepoIntoWorkspaceInput(BaseModel):
    """Typed envelope for :func:`clone_repo_into_workspace_activity`.

    Constructed by the workflow body and passed across the Temporal
    activity boundary. ``extra='forbid'`` rejects accidental field
    additions; ``schema_version`` is incremented on shape changes per
    the codemaster cross-process data-contract rule.

    :class:`WorkspaceHandle` is a Pydantic v2 :class:`~pydantic.BaseModel`
    (Phase 6 Task 17), so it embeds as a regular nested field — no
    ``arbitrary_types_allowed`` shim required. The handle's
    ``derived_path`` field serializes to ``str`` over the wire and
    reconstitutes as :class:`pathlib.Path` on the receiving side.
    """

    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1

    handle: WorkspaceHandle  # Phase 6 R2: workspace identity carries derived_path
    repo_url: str
    head_sha: str
    changed_paths: tuple[str, ...]
    pr_number: int | None = None


# Module-level dependency injection. The worker bootstrap (Task 16) calls
# configure() before registering activities.
_cloner: GitCloner | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None
_clock: Clock | None = None


def configure(
    *,
    cloner: GitCloner,
    session_factory: async_sessionmaker[AsyncSession],
    clock: Clock,
) -> None:
    """Inject module-level dependencies. Called by worker bootstrap (Task 16).

    Args:
        cloner: A :class:`GitCloner` Protocol implementation. Production
            wires a subprocess-git driver; tests inject a stub.
        session_factory: ``async_sessionmaker`` bound to the ``core`` DB
            pool. The activity opens its own short-lived session per
            invocation to keep the lease state-assertion + heartbeat
            bump inside an explicit transaction.
        clock: :class:`~codemaster.infra.clock.Clock` implementation —
            forwarded to :func:`transition_lease` so its event emit and
            timestamp stamping observe a consistent clock when tests
            inject a :class:`~codemaster.infra.clock.FakeClock`.
    """
    global _cloner, _session_factory, _clock  # noqa: PLW0603 — worker-startup wiring
    _cloner = cloner
    _session_factory = session_factory
    _clock = clock


def _require_configured() -> tuple[GitCloner, async_sessionmaker[AsyncSession], Clock]:
    if _cloner is None or _session_factory is None or _clock is None:
        raise RuntimeError(
            "clone_repo_into_workspace_activity not configured; "
            "worker bootstrap must call configure() before activity registration"
        )
    return _cloner, _session_factory, _clock


@activity.defn(name="clone_repo_into_workspace")
async def clone_repo_into_workspace_activity(
    req: CloneRepoIntoWorkspaceInput,
) -> ClonedRepoV1:
    """Clone into an EXISTING workspace.

    Steps:

    1. Confirm lease state == 'ALLOCATED' via a no-op
       ``transition_lease(from=ALLOCATED, to=ALLOCATED)`` call.
       :class:`StateDrift` propagates to the caller. The only successful
       outcome for the no-op is ``ALREADY_APPLIED`` (the UPDATE branch
       is structurally impossible when current == to == from);
       :class:`LeaseTransitionOutcome.APPLIED` raises a defensive
       ``RuntimeError`` to surface table drift.
    2. Touch the lease's ``heartbeat_at`` so the janitor's orphan-check
       timer is bumped.
    3. Clone into ``req.handle.derived_path`` (no workflow subdir — the
       path is already workflow-scoped per AD-10 / §7.3).
    4. Enforce :data:`MAX_WORKSPACE_BYTES` (200 MiB).
    5. Return :class:`ClonedRepoV1`.

    Args:
        req: Typed envelope carrying the :class:`WorkspaceHandle`,
            ``repo_url``, ``head_sha``, ``changed_paths``, and optional
            ``pr_number`` (forwarded to the cloner so it can fetch via
            ``pull/<n>/head`` — cross-fork-safe).

    Raises:
        RuntimeError: ``configure(...)`` has not been called, OR the
            no-op transition returned ``APPLIED`` (programming error —
            ``LeaseTransitionOutcome`` table drift).
        StateDrift: The lease row is missing OR no longer ``ALLOCATED``
            (e.g. moved to ``RELEASE_REQUESTED`` by a concurrent
            cancellation flow).
        CloneFailedError: ``head_sha`` is too short OR the underlying
            git clone failed for any reason.
        WorkspaceTooLargeError: The cloned workspace exceeded
            :data:`MAX_WORKSPACE_BYTES`.
    """
    cloner, session_factory, clock = _require_configured()
    workspace_id = req.handle.workspace_id
    workspace_path = req.handle.derived_path

    # 1. + 2. State assertion + heartbeat bump in one transaction.
    async with session_factory() as session, session.begin():
        outcome = await transition_lease(
            session,
            workspace_id=workspace_id,
            from_state="ALLOCATED",
            to_state="ALLOCATED",
            activity="clone_repo_into_workspace_activity",
            reason="state-assertion noop",
            clock=clock,
        )
        # ALREADY_APPLIED is the only successful outcome for a noop
        # transition (state == 'ALLOCATED' == from_state == to_state).
        # APPLIED is structurally impossible here — transition_lease's
        # branch ordering returns ALREADY_APPLIED whenever current ==
        # to_state, before the UPDATE step. Defensive raise surfaces
        # drift in the LeaseTransitionOutcome table rather than
        # silently masking it.
        if outcome is not LeaseTransitionOutcome.ALREADY_APPLIED:
            raise RuntimeError(
                f"clone_repo_into_workspace_activity: unexpected "
                f"transition_lease outcome {outcome!r} on heartbeat noop "
                f"for workspace_id={workspace_id!r}"
            )
        repo = LeaseRepo(session)
        await repo.touch_heartbeat(workspace_id)
    # BF-11: heartbeat after the lease-state assertion + heartbeat-bump
    # transaction commits so a wedged ``FOR UPDATE`` on the lease row
    # is detectable within the workflow's ``heartbeat_timeout`` window
    # (30s) rather than the full 60-second ``start_to_close_timeout``.
    activity.heartbeat({"phase": "state_assertion_done"})

    # 3. + 4. Git clone into the existing workspace path.
    if not req.head_sha or len(req.head_sha) < _MIN_HEAD_SHA_LEN:
        raise CloneFailedError(
            repo=req.repo_url,
            head_sha=req.head_sha or "",
            reason="missing head_sha",
        )

    # BF-11: heartbeat BEFORE the clone shell-out so a stalled
    # subprocess (network partition, hung git fetch) is detectable
    # within the heartbeat window. The clone itself is a single async
    # call; restructuring it to emit periodic in-flight heartbeats
    # would require a Popen+poll loop in the cloner Protocol and is
    # tracked as a follow-up. The bracketing heartbeats here are the
    # minimum-acceptable granularity per BF-11.
    activity.heartbeat({"phase": "clone_started"})
    try:
        await cloner.clone(
            workspace=workspace_path,
            repo_url=req.repo_url,
            head_sha=req.head_sha,
            paths=req.changed_paths,
            pr_number=req.pr_number,
        )
    except Exception as e:
        if isinstance(e, CloneFailedError):
            raise
        raise CloneFailedError(
            repo=req.repo_url,
            head_sha=req.head_sha,
            reason=str(e),
        ) from e
    # BF-11: heartbeat AFTER the clone returns so the post-clone state
    # is the last observed progress marker before the size walk.
    activity.heartbeat({"phase": "clone_completed"})

    byte_size = _byte_size_of_dir(workspace_path)
    if byte_size > MAX_WORKSPACE_BYTES:
        raise WorkspaceTooLargeError(
            repo=req.repo_url,
            head_sha=req.head_sha,
            byte_size=byte_size,
        )
    # BF-11: final heartbeat after the size-check so the workspace
    # walk's completion is recorded before return. ``_byte_size_of_dir``
    # is rglob-based and could in principle stall on a slow FS.
    activity.heartbeat({"phase": "size_checked", "byte_size": byte_size})

    return ClonedRepoV1(
        workspace_path=str(workspace_path),
        repo_path=str(workspace_path / _REPO_SUBDIR),
        head_sha=req.head_sha,
        byte_size=byte_size,
    )


__all__ = [
    "CloneRepoIntoWorkspaceInput",
    "clone_repo_into_workspace_activity",
    "configure",
]
