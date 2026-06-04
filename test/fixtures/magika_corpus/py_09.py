"""classify_files — Sprint 9 / S9.4.2.

Walks the cloned workspace, runs the Sprint-7 ``MagikaFileClassifier``
on each changed file, and routes via ``decide_route`` (S7.1.3) into
the three buckets:

* ``review_files``  → markdown / configs / unknown text → LLM review.
* ``sandbox_files`` → JS/TS/Python/Go → static-analysis runners.
* ``skip_files``    → generated / binary / empty.

Per-file classifier failures are isolated — the offending file is
recorded in ``classifier_failures`` (and skipped from all three
buckets) but the activity still returns a useful routing for the
files that succeeded. The S9.4.4 workflow body emits a
degradation_note in the walkthrough when failures exceed 10%.
"""

from __future__ import annotations

import logging
from pathlib import Path

from temporalio import activity

from codemaster.files.classifier_port import FileClassifierPort
from codemaster.files.router import decide_route
from contracts.file_routing.v1 import FileRoutingV1


_LOG = logging.getLogger("codemaster.activities.classify_files")


async def _do_classify(
    *,
    workspace: Path,
    files: tuple[str, ...],
    classifier: FileClassifierPort,
) -> FileRoutingV1:
    """Pure async helper. Tests invoke directly."""
    review: list[str] = []
    sandbox: list[str] = []
    skip: list[str] = []
    classifications = []
    failures: list[str] = []

    for relative in files:
        absolute = workspace / relative
        try:
            body = absolute.read_bytes()
        except OSError as e:
            _LOG.warning(
                "classify_files: read failed for %s",
                relative,
                extra={"error": str(e)},
            )
            failures.append(relative)
            continue
        try:
            cls = await classifier.classify(path=relative, body=body)
        except Exception as e:  # pragma: no cover — defensive
            _LOG.warning(
                "classify_files: Magika failed for %s",
                relative,
                extra={"error": str(e)},
            )
            failures.append(relative)
            continue
        classifications.append(cls)
        decision = decide_route(cls)
        # Phase B (2026-05-16): decision is a frozenset; code files
        # appear in BOTH "review" and "sandbox". The orchestrator
        # enforces Tier-1 (sandbox) → Tier-2 (review) sequencing.
        if "skip" in decision:
            skip.append(relative)
        else:
            if "review" in decision:
                review.append(relative)
            if "sandbox" in decision:
                sandbox.append(relative)

    return FileRoutingV1(
        review_files=tuple(review),
        sandbox_files=tuple(sandbox),
        skip_files=tuple(skip),
        classifications=tuple(classifications),
        classifier_failures=tuple(failures),
    )


class ClassifyFilesActivity:
    """Bound-method holder for the classify_files activity."""

    def __init__(self, *, classifier: FileClassifierPort) -> None:
        self._classifier = classifier

    @activity.defn(name="classify_files")
    async def classify_files(
        self,
        workspace_path: str,
        files: tuple[str, ...],
    ) -> FileRoutingV1:
        return await _do_classify(
            workspace=Path(workspace_path),
            files=files,
            classifier=self._classifier,
        )
