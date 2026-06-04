"""citation_validate_activity — activity-context wrapper around
CitationValidator.validate().

The validator's _repo_path_exists() helper calls pathlib.Path.resolve /
.exists / .is_file, which are restricted inside the Temporal workflow
sandbox (preserves replay determinism). Wrapping the call in an
activity moves the filesystem-touching work to the activity-task-queue
context, where those APIs are unrestricted.

The activity is intentionally thin — it constructs a CitationValidator
per call and forwards to its validate() method. No persistent state.

Timeout sizing (H2 architect-review note):
  start_to_close_timeout = 30s (set at the workflow body's
  execute_activity call site, not here). Sized for the M-A3 cap of
  300 findings x ~4 syscalls per repo_path source (.resolve x2 +
  .exists + .is_file). On a healthy filesystem this completes in
  <2s; the 30s budget absorbs cold-cache and kind-cluster IO
  contention. Revisit if the M-A3 cap raises beyond 300 OR workspace
  storage moves to NFS / network-mount in production.

DO NOT move CitationValidator's logic back into the workflow body
without re-instating an activity boundary somewhere — the validator's
filesystem calls would trip the sandbox again.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from temporalio import activity

from codemaster.review.citation_validator import CitationValidator
from contracts.citation_validation.v1 import CitationValidationResultV1
from contracts.policy_citation.v1 import PolicyCitationContextV1
from contracts.review_findings.v1 import ReviewFindingV1


class CitationValidateActivity:
    """Bound-method holder for ``citation_validate_activity``."""

    @activity.defn(name="citation_validate_activity")
    async def citation_validate(
        self,
        workspace_path: str,
        findings: tuple[ReviewFindingV1, ...],
        knowledge_chunk_ids: frozenset[str] | None,
        policy_citation: PolicyCitationContextV1 | dict[str, Any] | None = None,
    ) -> CitationValidationResultV1:
        """Validate citations on each finding.

        Temporal activities cannot have keyword-only arguments — args
        are positional. The orchestrator's ``execute_activity`` call
        site passes them by position via ``args=[...]``.

        Sprint 25 / A-5-wire-a — optional 4th positional
        ``policy_citation`` defaults to ``None`` (skip-mode) so
        Sprint-10..S24 callers (3-arg invocations) keep their
        behaviour. Accepts both a typed contract instance AND a
        dict (Temporal's default JSON converter delivers the wire
        form as a dict; re-validate to the typed instance on
        receipt).
        """
        ctx: PolicyCitationContextV1 | None
        if isinstance(policy_citation, dict):
            ctx = PolicyCitationContextV1.model_validate(policy_citation)
        else:
            ctx = policy_citation
        validator = CitationValidator(
            workspace=Path(workspace_path),
            knowledge_chunk_ids=knowledge_chunk_ids,
            policy_citation=ctx,
        )
        return await validator.validate(findings)


__all__ = ["CitationValidateActivity"]
