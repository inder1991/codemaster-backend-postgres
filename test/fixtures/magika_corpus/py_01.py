"""Input contract for emit_output_safety_audit_event_activity.

Carries an :class:`OutputSafetySanitizationEventV1` verbatim — the
activity projects it onto an ``audit.audit_events`` row. Mirrors the
shape of :class:`RecordReviewLifecycleEventInput` so the
contract-purity AST gate (ADR-0031) is satisfied uniformly across
emit activities.

Lives in a sibling module (not in the activity body) so the
:class:`ReviewPullRequestWorkflow` body can import the Pydantic input
without pulling in the activity module's transitive deps (SQLAlchemy,
encryption type-decorator initialization) which would trip the
Temporal workflow sandbox's determinism guards.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from contracts.review_chunk_response.sanitization_event_v1 import (
    OutputSafetySanitizationEventV1,
)


class EmitOutputSafetyAuditEventInput(BaseModel):
    """Input for ``emit_output_safety_audit_event_activity``.

    A thin envelope around :class:`OutputSafetySanitizationEventV1`.
    The activity derives a deterministic ``audit_event_id`` from
    ``event.request_id`` + ``event.detector_kinds`` + ``event.spans_redacted``
    + ``event.stage`` (see ``_derive_audit_event_id`` in
    :mod:`codemaster.activities.emit_output_safety_audit`); Temporal
    at-least-once retries land on the same id and the pre-INSERT SELECT
    short-circuits them.
    """

    __contract_internal__ = True
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: int = 1
    event: OutputSafetySanitizationEventV1


__all__ = ["EmitOutputSafetyAuditEventInput"]
