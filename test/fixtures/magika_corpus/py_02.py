"""Workflow-sandbox-safe input dataclasses for record_review_lifecycle activities.

Split out from :mod:`codemaster.activities.record_review_lifecycle` so the
``ReviewPullRequestWorkflow`` body can import the Pydantic inputs without
pulling in the activity module's transitive deps (SQLAlchemy, OTel
meter initialization, etc.) — which would trip the Temporal workflow
sandbox's determinism guards (e.g. ``os.putenv`` blocked at workflow
load time).

The activities themselves continue to live in
:mod:`codemaster.activities.record_review_lifecycle` and re-import these
classes for type signatures. The workflow body imports ONLY from this
module.

The minimal imports here are deliberate: ``uuid``, ``typing.Any``,
``pydantic`` (already in the workflow sandbox's known-safe set since
contracts use it). Anything beyond that risks re-introducing the
sandbox-blocking import chain.
"""

from __future__ import annotations

import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class RecordReviewLifecycleEventInput(BaseModel):
    """Input for ``record_review_lifecycle_event_activity``.

    BF-3 Phase B (2026-05-17): ``installation_id`` is a required field so
    the activity's call to :func:`emit_workflow_event` can stamp tenant
    attribution on every emitted ``audit.workflow_events`` row. The
    workflow body has ``installation_id`` in its
    ``ReviewPullRequestPayloadV1`` envelope (``ExecutionContext``) with
    zero extra cost — Pattern B-contract is preferable to Pattern
    C-DB-lookup because the activity contract is the authoritative seam
    per CLAUDE.md's "Data contracts mandatory" rule, and it avoids tying
    the BF-3 fix to a DB round-trip on the activity hot path. See
    ``docs/superpowers/plans/2026-05-17-bf3-phase-b-emit-workflow-event-installation-id.md``
    (Wave 5).

    ``schema_version`` bumped 1 → 2 on this shape change. The Wave-4
    pre-Phase-B shape (no ``installation_id``) is implicit v1.
    """

    __contract_internal__ = True
    model_config = ConfigDict(extra="ignore")

    schema_version: Literal[2] = 2
    installation_id: uuid.UUID
    run_id: uuid.UUID
    review_id: uuid.UUID
    provider: str = Field(default="github", min_length=1)
    event_type: str
    payload: dict[str, Any] = Field(default_factory=dict)


class FinalizeReviewRunInput(BaseModel):
    """Input for ``finalize_review_run_activity``."""

    __contract_internal__ = True
    model_config = ConfigDict(extra="ignore")

    run_id: uuid.UUID
    review_id: uuid.UUID
    attempt: int = Field(default=1, ge=1)
    duration_ms: int | None = Field(default=None, ge=0)
    worker_id: str | None = None


class RecordRunFailedInput(BaseModel):
    """Input for ``record_run_failed_activity`` (BF-5).

    Carries the run identity + a human-readable failure reason captured
    at the workflow body's outermost try/except. The reason flows into
    ``transition_run(..., reason=...)`` and lands on the emitted
    ``lifecycle_transition`` event's payload — operators reading
    ``audit.workflow_events`` see the exception class + first line of
    the message that caused the FAILED transition.

    ``review_id`` is denormalised here (mirroring ``FinalizeReviewRunInput``)
    so consumers / analytics joins downstream of the activity don't need
    to re-derive it from the run row.
    """

    __contract_internal__ = True
    model_config = ConfigDict(extra="ignore")

    run_id: uuid.UUID
    review_id: uuid.UUID
    # Truncated + sanitised at the workflow body (one line, <=200 chars)
    # so an unbounded exception message can't blow up the
    # lifecycle_transition payload size.
    reason: str = Field(min_length=1, max_length=500)
    attempt: int = Field(default=1, ge=1)


class RecordRunCancelledInput(BaseModel):
    """Input for ``record_run_cancelled_activity`` (BF-13).

    Carries the run identity + a human-readable cancellation reason
    captured at the workflow body's outermost
    ``except asyncio.CancelledError`` clause. The reason flows into
    ``transition_run(..., reason=...)`` and lands on the emitted
    ``lifecycle_transition`` event's payload so operators reading
    ``audit.workflow_events`` can distinguish operator-initiated
    Temporal cancellation from supersede-driven cancellation (which
    goes through the dedicated ``supersede_run`` primitive and stamps
    ``superseded_by_run_id``).

    ``review_id`` is denormalised here (mirroring
    :class:`RecordRunFailedInput`) so consumers / analytics joins
    downstream of the activity don't need to re-derive it from the run
    row.
    """

    __contract_internal__ = True
    model_config = ConfigDict(extra="ignore")

    run_id: uuid.UUID
    review_id: uuid.UUID
    # Free-text cancellation reason (e.g. ``"temporal_cancellation"``).
    # Bounded so an unbounded caller can't balloon the
    # lifecycle_transition event payload size.
    reason: str = Field(min_length=1, max_length=500)
    attempt: int = Field(default=1, ge=1)


__all__ = [
    "FinalizeReviewRunInput",
    "RecordReviewLifecycleEventInput",
    "RecordRunCancelledInput",
    "RecordRunFailedInput",
]
