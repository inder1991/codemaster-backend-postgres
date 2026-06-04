# ruff: noqa: PLC0415, ASYNC240
"""chunk_and_redact_activity — Sprint 9 / S9.4.3 (deferred → 2026-05-09 NOW.8).

Composite activity: ChunkerRegistry.select_for(path) per file +
inline redaction. Returns tuple[DiffChunkV1, ...] ready for
bedrock_review_chunk to consume.

The chunker registry is constructed at worker startup
(`_wire_chunker_registry` in worker/main.py); this activity reads
it via the `_get_chunker_registry()` accessor for testability
(unit tests monkeypatch the accessor).

Redaction is inlined rather than delegated to the existing
RedactChunksActivity to avoid Temporal-round-trip overhead per
chunk; the same PII + secret detectors are used.

M-A2 — per-iteration body release for memory-safety. For 100-file
PRs this caps activity heap at O(largest_file_size) instead of
O(sum_of_all_files).
"""

from __future__ import annotations

from pathlib import Path

from temporalio import activity

from contracts.diff_chunking.v1 import DiffChunkV1


class WorkspacePathOutsideRootError(ValueError):
    """Raised when a file path resolves outside the workspace root."""


def _get_chunker_registry():
    from codemaster.worker.main import _chunker_registry

    if _chunker_registry is None:
        raise RuntimeError(
            "_chunker_registry is None; _wire_chunker_registry() not called. "
            "Activity invoked outside the worker bootstrap path."
        )
    return _chunker_registry


def _redact_chunks_inline(chunks):
    """Apply existing PII + secret redactors to chunks. Lazy import +
    inlined so we don't pay the Temporal-activity overhead per chunk."""
    from codemaster.activities.redact_chunks import _do_redact
    from codemaster.security.pattern_secret_detector import PatternSecretDetector
    from codemaster.security.regex_pii_redactor import RegexPiiRedactor

    return _do_redact(
        tuple(chunks),
        pii=RegexPiiRedactor(),
        secrets=PatternSecretDetector(),
    )


@activity.defn(name="chunk_and_redact_activity")
async def chunk_and_redact_activity(
    workspace_path: str,
    files: tuple[str, ...],
    changed_line_ranges: dict[str, tuple[tuple[int, int], ...]],
) -> tuple[DiffChunkV1, ...]:
    """Chunk each file via the registry-selected chunker; redact in
    place; return the merged tuple."""
    workspace = Path(workspace_path).resolve()
    registry = _get_chunker_registry()

    all_chunks: list[DiffChunkV1] = []
    for rel_path in files:
        target = (workspace / rel_path).resolve()

        # Path-traversal defense.
        try:
            target.relative_to(workspace)
        except ValueError as e:
            raise WorkspacePathOutsideRootError(
                f"file {rel_path!r} resolves outside workspace_root={workspace!r}"
            ) from e

        if not target.is_file():
            continue  # skip deleted / missing files

        # M-A2 — release body bytes before next iteration.
        body = target.read_bytes()
        try:
            ranges = changed_line_ranges.get(rel_path, ())
            chunker = registry.select_for(path=rel_path)
            file_chunks = await chunker.chunk(
                path=rel_path,
                body=body,
                hunk_ranges=ranges,
            )
            all_chunks.extend(file_chunks)
        finally:
            del body

    redacted = _redact_chunks_inline(all_chunks)
    return tuple(redacted)
