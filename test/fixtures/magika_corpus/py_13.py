"""delete_review_placeholder — Phase 1 PR-1c.

Tears down the PR conversation-tab placeholder comment posted by
:mod:`codemaster.activities.post_review_placeholder` after the heavy
``post_review_results_activity`` has successfully landed the real
review. The placeholder vanishes from the PR conversation tab,
leaving the developer with just the real review.

Strategy
--------
1. List the PR's issue comments.
2. Filter for any comment whose body contains the placeholder marker
   (``<!-- codemaster:placeholder-marker:{pr_id} -->``).
3. DELETE each matching comment via
   ``DELETE /repos/{owner}/{repo}/issues/comments/{id}``.
4. Emit ``REVIEW_PLACEHOLDER_DELETED`` audit event for each deletion.

Best-effort
-----------
All GitHub I/O failures are logged at WARNING and swallowed. The
cleanup is a UX nicety; an orphaned placeholder is strictly worse than
no placeholder but better than a failed review pipeline. The
``GitHubNotFoundError`` case (404 on DELETE) is treated as a success —
the comment was already removed by an earlier retry or a human.

Idempotency
-----------
Stateless marker-based filtering: re-running the activity after a
successful delete sees zero matching comments and no-ops. The activity
swallows DELETE 404s for the same reason.

Sandbox-safety
--------------
No ``os.getenv`` at module import (the activity has no feature flag
of its own — it ships gated by the same feature flag as the
placeholder POST, but the cleanup is invoked unconditionally from the
workflow body; if no placeholder was posted, no marker matches and
the activity no-ops). See
:mod:`codemaster.activities.post_review_placeholder` for the
sandbox-safety precedent write-up.
"""

# audit:exempt reason=cleanup-best-effort-emits-its-own-audit-event-per-deletion

from __future__ import annotations

import logging
import uuid
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from temporalio import activity

from codemaster.infra.clock import Clock
from codemaster.ingest._workflow_events_repository import emit_workflow_event

_LOG = logging.getLogger("codemaster.activities.delete_review_placeholder")


def _marker_for(pr_id: uuid.UUID) -> str:
    """Mirror of ``post_review_placeholder._marker_for``.

    Duplicated here (rather than imported) so the cleanup activity
    does not pull a dependency on the placeholder module's import
    graph. The marker string is the contract between the two
    activities; if it drifts, the marker-distinctness test in
    ``tests/unit/activities/test_delete_review_placeholder.py``
    catches it.
    """
    return f"<!-- codemaster:placeholder-marker:{pr_id} -->"


# ─── input contract ─────────────────────────────────────────────────


class DeleteReviewPlaceholderInput(BaseModel):
    """Typed envelope for :func:`delete_review_placeholder_activity`."""

    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1

    pr_id: uuid.UUID
    run_id: uuid.UUID
    review_id: uuid.UUID
    installation_id: uuid.UUID
    owner: str
    repo_name: str
    pr_number: int


# ─── GhIssueCommentClient Protocol (minimal local view) ─────────────


class GhIssueCommentClient(Protocol):
    """Minimal Protocol for the issue-comment delete surface.

    Mirrored locally (not imported from the production client) so
    workflow-side imports do not transitively load GitHub HTTP types.
    """

    async def list_issue_comments(
        self,
        *,
        owner: str,
        repo: str,
        pr_number: int,
    ) -> list[dict[str, Any]]:
        """Return the first page of issue comments on the PR."""

    async def delete_issue_comment(
        self,
        *,
        owner: str,
        repo: str,
        comment_id: int,
    ) -> None:
        """DELETE /issues/comments/{id}. 404 raises GitHubNotFoundError."""


# ─── module-level dependency injection ──────────────────────────────


_gh_client: GhIssueCommentClient | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None
_clock: Clock | None = None


def configure(
    *,
    gh_client: GhIssueCommentClient,
    session_factory: async_sessionmaker[AsyncSession],
    clock: Clock,
) -> None:
    """Inject module-level dependencies. Called by worker bootstrap."""
    global _gh_client, _session_factory, _clock  # noqa: PLW0603 — worker-startup wiring
    _gh_client = gh_client
    _session_factory = session_factory
    _clock = clock


def _require_configured() -> tuple[GhIssueCommentClient, async_sessionmaker[AsyncSession], Clock]:
    if _gh_client is None or _session_factory is None or _clock is None:
        raise RuntimeError(
            "delete_review_placeholder_activity not configured; "
            "worker bootstrap must call configure() before activity registration"
        )
    return _gh_client, _session_factory, _clock


# ─── activity ───────────────────────────────────────────────────────


@activity.defn(name="delete_review_placeholder_activity")
async def delete_review_placeholder_activity(req: DeleteReviewPlaceholderInput) -> None:
    """Delete the placeholder PR conversation-tab comment (best-effort).

    Steps:

    1. Resolve injected deps. If unconfigured, log WARNING and return —
       the cleanup is a nicety, not a correctness primitive.
    2. List PR issue comments.
    3. For each comment whose body contains the placeholder marker:
       a. DELETE the comment.
       b. Emit ``REVIEW_PLACEHOLDER_DELETED`` audit event.
       Both 404 (already deleted) and other GitHub errors are
       swallowed and logged at WARNING.
    """
    try:
        gh_client, session_factory, clock = _require_configured()
    except RuntimeError as e:
        _LOG.warning("delete_review_placeholder.not_configured pr_id=%s error=%s", req.pr_id, e)
        return

    marker = _marker_for(req.pr_id)

    try:
        comments = await gh_client.list_issue_comments(
            owner=req.owner,
            repo=req.repo_name,
            pr_number=req.pr_number,
        )
    except Exception as e:
        _LOG.warning(
            "delete_review_placeholder.list_failed pr_id=%s pr_number=%d error=%s",
            req.pr_id,
            req.pr_number,
            e,
        )
        return

    # Defensive: a Temporal retry between POST and audit-emit can leave
    # multiple matching comments; delete every match to avoid orphans.
    matching_ids: list[int] = []
    for comment in comments:
        body = comment.get("body")
        cid = comment.get("id")
        if body and cid is not None and marker in body:
            matching_ids.append(int(cid))

    if not matching_ids:
        _LOG.debug(
            "delete_review_placeholder.no_marker_match pr_id=%s pr_number=%d",
            req.pr_id,
            req.pr_number,
        )
        return

    for comment_id in matching_ids:
        try:
            await gh_client.delete_issue_comment(
                owner=req.owner,
                repo=req.repo_name,
                comment_id=comment_id,
            )
        except Exception as e:
            # GitHubNotFoundError on 404 (comment already gone) is a
            # success from our perspective; other 4xx/5xx are logged
            # and we move on to the next matching id.
            _LOG.warning(
                "delete_review_placeholder.delete_failed pr_id=%s comment_id=%d error=%s",
                req.pr_id,
                comment_id,
                e,
            )
            continue

        try:
            async with session_factory() as session, session.begin():
                await emit_workflow_event(
                    session,
                    provider="github",
                    run_id=req.run_id,
                    review_id=req.review_id,
                    event_type="REVIEW_PLACEHOLDER_DELETED",
                    payload={
                        "pr_id": str(req.pr_id),
                        "pr_number": req.pr_number,
                        "github_comment_id": comment_id,
                    },
                    installation_id=req.installation_id,
                    clock=clock,
                )
        except Exception as e:
            _LOG.warning(
                "delete_review_placeholder.audit_emit_failed pr_id=%s comment_id=%d error=%s",
                req.pr_id,
                comment_id,
                e,
            )


__all__ = [
    "DeleteReviewPlaceholderInput",
    "GhIssueCommentClient",
    "configure",
    "delete_review_placeholder_activity",
]
