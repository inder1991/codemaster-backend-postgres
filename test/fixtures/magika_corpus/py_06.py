"""capture_diff_snapshot_activity — Sprint 6 / S6.1.6, wired Sprint 14 / S14.F.

Idempotent: if a row already exists for
`(installation_id, repository_id, base_sha, head_sha)` we return its
existing diff_snapshot_id without fetching the diff or re-archiving
the blob.

Otherwise:
1. Fetch the diff via the S5.1.2 GitHub API client (the caller injects
   the configured `GitHubApiClient`).
2. Archive the diff bytes via `BlobStorePort.put` (S3.1.9 / S5.1.7).
3. Insert the row pointing at the new blob.

Sprint 6 shipped the contract + ``perform_capture()`` (the pure-Python
work). The Temporal activity boundary
(``capture_diff_snapshot_activity``) was a stub that raised
``NotImplementedError``. Sprint 14 / S14.F replaces the stub with real
wiring: ``configure(...)`` is called once at worker startup with the
GitHub API client, the BlobStorePort, and the session factory; the
activity body validates the payload, delegates to ``perform_capture``,
and returns its result. Calling the activity before ``configure(...)``
raises ``RuntimeError`` (fail-closed).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from temporalio import activity

from codemaster.adapters.blobstore_port import BlobRef, BlobStorePort
from codemaster.audit.emit import bind_audit_context, emit_audit_event
from codemaster.infra.clock import WallClock


class DiffSnapshotRequestV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: int = 1
    installation_id: uuid.UUID
    repository_id: uuid.UUID
    repository_full_name: str = Field(min_length=1)
    base_sha: str = Field(min_length=1)
    head_sha: str = Field(min_length=1)
    pr_number: int = Field(gt=0)


class DiffSnapshotResultV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: int = 1
    diff_snapshot_id: uuid.UUID
    diff_blob_ref: BlobRef
    byte_size: int
    deduped: bool


class _DiffFetcher(Protocol):
    async def get_pull_request_diff(
        self,
        *,
        installation_id: int,
        owner: str,
        repo: str,
        pr_number: int,
    ) -> bytes: ...


async def perform_capture(
    *,
    request: DiffSnapshotRequestV1,
    github_installation_id: int,
    github_client: _DiffFetcher,
    blob_store: BlobStorePort,
    session_factory: Any,
) -> DiffSnapshotResultV1:
    """Pure-Python capture; separated so unit tests can drive it."""
    # Defensive guard: the worker bootstrap (S15.X-capture-diff-worker-wiring)
    # rejects missing/zero CODEMASTER_GITHUB_INSTALLATION_ID at boot, but
    # `perform_capture` is also a public boundary used by tests + future
    # direct callers. Architecture-review B3: tenancy-write integrity must
    # hold even if the boot-time check is somehow bypassed.
    if github_installation_id <= 0:
        raise ValueError(
            f"github_installation_id must be >= 1, got {github_installation_id} "
            "(0 was the sentinel value the pre-architecture-review DoR "
            "incorrectly proposed; production callers carry a real id)"
        )

    clock = WallClock()
    now = clock.now()

    async with session_factory() as session:
        async with session.begin():
            existing = await session.execute(
                text(
                    "SELECT diff_snapshot_id, diff_blob_id, byte_size "
                    "FROM core.diff_snapshots "
                    "WHERE installation_id = :iid "
                    " AND repository_id = :rid "
                    " AND base_sha = :base "
                    " AND head_sha = :head "
                    "LIMIT 1"
                ),
                {
                    "iid": request.installation_id,
                    "rid": request.repository_id,
                    "base": request.base_sha,
                    "head": request.head_sha,
                },
            )
            existing_row = existing.one_or_none()
            if existing_row is not None:
                return DiffSnapshotResultV1(
                    diff_snapshot_id=existing_row.diff_snapshot_id,
                    diff_blob_ref=BlobRef(
                        installation_id=str(request.installation_id),
                        key=f"diffs/{existing_row.diff_blob_id}",
                        byte_size=int(existing_row.byte_size),
                        content_type="text/x-diff",
                        created_at=now,
                    ),
                    byte_size=int(existing_row.byte_size),
                    deduped=True,
                )

    # Not deduped — fetch + archive + insert.
    owner, _, repo = request.repository_full_name.partition("/")
    diff_bytes = await github_client.get_pull_request_diff(
        installation_id=github_installation_id,
        owner=owner,
        repo=repo,
        pr_number=request.pr_number,
    )

    diff_blob_id = uuid.uuid4()
    blob_ref = await blob_store.put(
        installation_id=str(request.installation_id),
        key=f"diffs/{diff_blob_id}",
        body=diff_bytes,
        content_type="text/x-diff",
    )

    diff_snapshot_id = uuid.uuid4()
    async with session_factory() as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO core.diff_snapshots "
                    "(diff_snapshot_id, installation_id, repository_id, "
                    " base_sha, head_sha, diff_blob_id, byte_size, created_at) "
                    "VALUES (:sid, :iid, :rid, :base, :head, :bid, :sz, :now)"
                ),
                {
                    "sid": diff_snapshot_id,
                    "iid": request.installation_id,
                    "rid": request.repository_id,
                    "base": request.base_sha,
                    "head": request.head_sha,
                    "bid": diff_blob_id,
                    "sz": len(diff_bytes),
                    "now": now,
                },
            )
            bind_audit_context(session, installation_id=request.installation_id)
            await emit_audit_event(
                session=session,
                actor_kind="system",
                actor_id=None,
                action="diff_snapshot.captured",
                target_kind="diff_snapshot",
                target_id=str(diff_snapshot_id),
                before=None,
                after={
                    "repository_id": str(request.repository_id),
                    "base_sha": request.base_sha,
                    "head_sha": request.head_sha,
                    "byte_size": len(diff_bytes),
                },
                clock=clock,
            )

    return DiffSnapshotResultV1(
        diff_snapshot_id=diff_snapshot_id,
        diff_blob_ref=blob_ref,
        byte_size=len(diff_bytes),
        deduped=False,
    )


# === Worker-startup wiring (S14.F) ===


@dataclass(frozen=True, slots=True)
class _Configured:
    github_client: _DiffFetcher
    github_installation_id: int
    blob_store: BlobStorePort
    session_factory: Any


_CONFIGURED: _Configured | None = None


def configure(
    *,
    github_client: _DiffFetcher,
    github_installation_id: int,
    blob_store: BlobStorePort,
    session_factory: Any,
) -> None:
    """Wire the activity at worker startup.

    Must be called once per worker process before the Temporal worker
    schedules ``capture_diff_snapshot_activity``. Calling the activity
    without prior configuration raises ``RuntimeError`` (fail-closed).

    Args:
        github_client: Configured ``GitHubApiClient`` from S5.1.2.
        github_installation_id: Numeric GitHub installation ID used for
            App-token minting in the diff fetch. (The repository UUID
            travels in the payload; this is the GitHub-side identifier
            the API client requires.)
        blob_store: BlobStorePort implementation (production: S3-backed
            Crunchy / Vault-managed; tests: in-memory adapter).
        session_factory: Async session factory bound to the ``core``
            DB pool. Production passes
            ``codemaster.domain.session.async_session_factory("core")``.
    """
    global _CONFIGURED  # noqa: PLW0603 — module-level worker-startup wiring
    _CONFIGURED = _Configured(
        github_client=github_client,
        github_installation_id=github_installation_id,
        blob_store=blob_store,
        session_factory=session_factory,
    )


def _require_configured() -> _Configured:
    if _CONFIGURED is None:
        raise RuntimeError(
            "capture_diff_snapshot_activity not configured; call "
            "codemaster.activities.capture_diff_snapshot.configure(...) "
            "at worker startup"
        )
    return _CONFIGURED


def _reset_for_testing() -> None:
    global _CONFIGURED  # noqa: PLW0603
    _CONFIGURED = None


@activity.defn(name="capture_diff_snapshot_activity")
async def capture_diff_snapshot_activity(
    payload_dict: dict[str, Any],
) -> DiffSnapshotResultV1:
    """Temporal-defn boundary. Validates the payload, delegates to
    :func:`perform_capture` with the worker-startup-injected clients,
    returns the snapshot result.

    Pre-condition: :func:`configure` has been called at worker startup.
    Calling without prior configuration raises ``RuntimeError`` so the
    Temporal retry loop surfaces the misconfiguration loudly.
    """
    cfg = _require_configured()
    request = DiffSnapshotRequestV1.model_validate(payload_dict)
    return await perform_capture(
        request=request,
        github_installation_id=cfg.github_installation_id,
        github_client=cfg.github_client,
        blob_store=cfg.blob_store,
        session_factory=cfg.session_factory,
    )
