"""discover_repo_docs — Sprint 10 / S10.2.1 (extended Sprint 25 / A-1).

This module hosts two related-but-distinct workspace walks:

  * ``discover_repo_docs(workspace)`` — Sprint 10 / S10.2.1.
    Returns ``DiscoveredRepoDocsV1`` for the KNOWLEDGE retrieval
    pipeline (README.md root-only, CLAUDE.md any-depth, docs/**/*.md).
    The downstream ``RefreshRepoDocsWorkflow`` (S10.2.4) uses
    ``content_sha256`` to short-circuit re-embedding when bytes
    are unchanged.

  * ``discover_guideline_files(workspace, custom_patterns)`` —
    Sprint 25 / A-1 (per R-J closure 2026-05-20: extends THIS
    module rather than introducing a new ``codemaster/policy/
    discovery.py``). Returns ``DiscoveredGuidelineFilesV1`` for
    the POLICY pipeline — files like CLAUDE.md, AGENTS.md,
    .cursorrules, STANDARDS.md, etc. Output feeds A-2's rule
    extractor; never persisted (per R-H closure, Subsystem A
    runs in-memory at review time).

The two walks share helpers (``_EXCLUDED_DIRS``,
``_resolves_inside``, ``_hash_bytes``) but use independent
pattern matchers (``_is_in_scope`` for knowledge,
``_matches_guideline_pattern`` for policy). A file may appear
in BOTH result sets by design (e.g., README.md is both a
knowledge doc and a candidate policy doc); downstream consumers
handle their own concerns.

Pure helpers today (no Temporal activity wrapper).
"""

from __future__ import annotations

import fnmatch
import hashlib
import logging
import os
import re
from pathlib import Path
from typing import Final

# R-36 + R-51 (multi-lens audit 2026-05-22) — top-level imports
# hoisted from previously-lazy activity-body sites. Activity bodies
# have no sandbox justification for lazy imports.
from codemaster.observability.semantic_docs_metrics import (
    record_guideline_files_cap_hit,
    record_knowledge_docs_cap_hit,
)
from contracts.guideline_files.v1 import (
    DEFAULT_GUIDELINE_PATTERNS,
    MAX_GUIDELINE_BYTES,
    MAX_GUIDELINE_FILES_PER_REPO,
    DiscoveredGuidelineFilesV1,
    GuidelineFileV1,
    MalformedPatternError,
)
from contracts.repo_docs.v1 import (
    MAX_DOC_BYTES,
    MAX_DOCS_PER_REPO,
    DiscoveredRepoDocsV1,
    RepoDocV1,
)

_LOG = logging.getLogger("codemaster.activities.discover_repo_docs")


# Top-level directories whose subtrees are ignored — noise + vendor
# code that would dilute the team's own knowledge base.
_EXCLUDED_DIRS: Final[frozenset[str]] = frozenset(
    {".git", "node_modules", "vendor", ".venv", "__pycache__"}
)


def _is_in_scope(rel_path: str) -> bool:
    """Return True iff rel_path matches one of the locked patterns.

    Patterns:
      * ``README.md`` (root only — no nested READMEs)
      * ``CLAUDE.md`` at any depth
      * ``docs/**/*.md`` (recursive)
      * ``docs/adr/*.md`` and ``docs/decisions/*.md`` are subsumed
        by ``docs/**/*.md`` but enumerated explicitly in the
        contract for clarity.
    """
    if rel_path == "README.md":
        return True
    if rel_path == "CLAUDE.md" or rel_path.endswith("/CLAUDE.md"):
        return True
    if rel_path.startswith("docs/") and rel_path.endswith(".md"):
        return True
    return False


def _resolves_inside(workspace_resolved: Path, candidate: Path) -> bool:
    """True iff ``candidate.resolve()`` is the workspace itself or
    a descendant. Symlinks pointing outside the workspace are
    skipped — we don't embed `/etc/some.md` even if a malicious
    repo planted a symlink to it."""
    try:
        target = candidate.resolve()
    except OSError:
        return False
    try:
        target.relative_to(workspace_resolved)
        return True
    except ValueError:
        return False


def _hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def discover_repo_docs(*, workspace: Path) -> DiscoveredRepoDocsV1:
    """Walk ``workspace`` and emit one ``RepoDocV1`` per in-scope
    markdown file.

    Results are sorted by ``relative_path`` for determinism so
    re-runs of the activity produce byte-identical envelopes when
    the underlying files haven't changed.
    """
    workspace_resolved = workspace.resolve()
    candidates: list[tuple[str, Path]] = []

    for root, dirnames, filenames in os.walk(workspace, followlinks=False):
        # Prune excluded directories in-place so os.walk skips them.
        dirnames[:] = [d for d in dirnames if d not in _EXCLUDED_DIRS]

        root_path = Path(root)
        for fname in filenames:
            if not fname.endswith(".md"):
                continue
            file_path = root_path / fname
            try:
                rel_path = file_path.relative_to(workspace).as_posix()
            except ValueError:
                continue
            if not _is_in_scope(rel_path):
                continue
            candidates.append((rel_path, file_path))

    candidates.sort(key=lambda x: x[0])

    docs: list[RepoDocV1] = []
    cap_hit = False

    for rel_path, file_path in candidates:
        if len(docs) >= MAX_DOCS_PER_REPO:
            cap_hit = True
            _LOG.info(
                "discover_repo_docs: per-repo cap hit, skipping remaining",
                extra={"cap": MAX_DOCS_PER_REPO, "skipped_path": rel_path},
            )
            break

        # Reject symlinks whose target resolves outside the workspace.
        if file_path.is_symlink() and not _resolves_inside(workspace_resolved, file_path):
            _LOG.warning(
                "discover_repo_docs: symlink escapes workspace; skipping",
                extra={"path": rel_path},
            )
            continue

        try:
            data = file_path.read_bytes()
        except OSError as e:
            _LOG.warning(
                "discover_repo_docs: read failed; skipping",
                extra={"path": rel_path, "error": str(e)},
            )
            continue

        if len(data) > MAX_DOC_BYTES:
            _LOG.info(
                "discover_repo_docs: oversize doc skipped",
                extra={"path": rel_path, "byte_size": len(data)},
            )
            continue

        docs.append(
            RepoDocV1(
                relative_path=rel_path,
                byte_size=len(data),
                content_sha256=_hash_bytes(data),
            )
        )

    return DiscoveredRepoDocsV1(docs=tuple(docs), docs_cap_hit=cap_hit)


# ─── Sprint 25 / A-1: policy-file discovery ────────────────────────


def _validate_custom_patterns(patterns: tuple[str, ...]) -> None:
    """Reject patterns with ``..`` segments or absolute paths.

    Defensive — A-7's ``.codemaster.yaml`` validator should reject
    these upstream. ``discover_guideline_files`` enforces here as a
    defense-in-depth boundary.
    """
    for pattern in patterns:
        if not pattern:
            raise MalformedPatternError("empty pattern not allowed")
        if pattern.startswith("/"):
            raise MalformedPatternError(f"absolute pattern not allowed: {pattern!r}")
        if ".." in pattern.split("/"):
            raise MalformedPatternError(f"pattern with '..' segment not allowed: {pattern!r}")


# R-48 (multi-lens audit 2026-05-22) — pre-compile fnmatch
# patterns to a regex at first use. ``fnmatch.translate`` builds a
# new regex each call; for the typical 15-pattern set x 500 files
# per repo x 30K refreshes/day = ~225M translate calls/day across
# the fleet. Module-level cache amortizes the cost.
_FNMATCH_REGEX_CACHE: dict[str, re.Pattern[str]] = {}


def _fnmatch_re(pattern: str) -> re.Pattern[str]:
    cached = _FNMATCH_REGEX_CACHE.get(pattern)
    if cached is None:
        cached = re.compile(fnmatch.translate(pattern))
        _FNMATCH_REGEX_CACHE[pattern] = cached
    return cached


def _matches_guideline_pattern(rel_path: str, patterns: tuple[str, ...]) -> str | None:
    """Return the first matching pattern, or ``None``.

    Match semantics (POSIX, case-sensitive):
      * Patterns containing ``/`` match against the full POSIX
        relative path via ``fnmatchcase`` (e.g.
        ``docs/conventions/*.md``).
      * Patterns without ``/`` match against the basename only
        (e.g. ``CLAUDE.md`` matches any ``CLAUDE.md`` at any depth).

    First match wins so the result is deterministic regardless of
    how many patterns the file overlaps.
    """
    basename = rel_path.rsplit("/", 1)[-1] if "/" in rel_path else rel_path
    for pattern in patterns:
        if "/" in pattern:
            if _fnmatch_re(pattern).match(rel_path) is not None:
                return pattern
        else:
            # Basename-pattern: case-sensitive exact match (no glob
            # in basename patterns today; if a future pattern uses
            # wildcards in the basename we fall back to fnmatchcase).
            if pattern == basename:
                return pattern
            if any(c in pattern for c in "*?["):
                if _fnmatch_re(pattern).match(basename) is not None:
                    return pattern
    return None


def _derive_scope_dir(rel_path: str) -> str:
    """Return the parent directory the file's rules apply to.

    Empty string for repo-root files; POSIX path (no trailing
    separator) for nested files.
    """
    if "/" not in rel_path:
        return ""
    return rel_path.rsplit("/", 1)[0]


def discover_guideline_files(
    *,
    workspace: Path,
    custom_patterns: tuple[str, ...] = (),
) -> DiscoveredGuidelineFilesV1:
    """Walk ``workspace`` and emit one ``GuidelineFileV1`` per
    in-scope policy file.

    Pattern set: ``DEFAULT_GUIDELINE_PATTERNS`` (15 patterns)
    extended additively by ``custom_patterns`` (per A-7's
    ``.codemaster.yaml::knowledge.file_patterns``).

    Per R-J closure (2026-05-20): this function is the
    policy-side counterpart to ``discover_repo_docs``. Both walks
    may yield overlapping results (e.g., ``README.md`` appears in
    both); downstream consumers handle their own concerns.

    Results sorted by ``relative_path`` for determinism; re-runs
    on an unchanged workspace produce byte-identical envelopes.

    Raises:
        MalformedPatternError: if ``custom_patterns`` contains a
        pattern with ``..`` segments or absolute paths.
    """
    _validate_custom_patterns(custom_patterns)
    # Defaults FIRST so the source_pattern recorded is the default
    # when a custom pattern would otherwise duplicate it.
    all_patterns = DEFAULT_GUIDELINE_PATTERNS + tuple(custom_patterns)

    workspace_resolved = workspace.resolve()
    candidates: list[tuple[str, Path, str]] = []  # (rel_path, abs_path, pattern)

    for root, dirnames, filenames in os.walk(workspace, followlinks=False):
        # Prune excluded directories in-place so os.walk skips them.
        dirnames[:] = [d for d in dirnames if d not in _EXCLUDED_DIRS]

        root_path = Path(root)
        for fname in filenames:
            file_path = root_path / fname
            try:
                rel_path = file_path.relative_to(workspace).as_posix()
            except ValueError:
                continue
            pattern = _matches_guideline_pattern(rel_path, all_patterns)
            if pattern is None:
                continue
            candidates.append((rel_path, file_path, pattern))

    candidates.sort(key=lambda x: x[0])

    files: list[GuidelineFileV1] = []
    cap_hit = False
    oversize_count = 0

    for rel_path, file_path, pattern in candidates:
        if len(files) >= MAX_GUIDELINE_FILES_PER_REPO:
            cap_hit = True
            _LOG.info(
                "discover_guideline_files: per-repo cap hit, skipping remaining",
                extra={"cap": MAX_GUIDELINE_FILES_PER_REPO, "skipped_path": rel_path},
            )
            # R-34 (multi-lens audit 2026-05-22) — parity with
            # discover_knowledge_docs's cap-hit emit. Pre-fix this
            # log-only path left the cap structurally invisible to
            # operator dashboards.
            record_guideline_files_cap_hit()
            break

        # Reject symlinks whose target resolves outside the workspace.
        if file_path.is_symlink() and not _resolves_inside(workspace_resolved, file_path):
            _LOG.warning(
                "discover_guideline_files: symlink escapes workspace; skipping",
                extra={"path": rel_path},
            )
            continue

        try:
            data = file_path.read_bytes()
        except OSError as e:
            _LOG.warning(
                "discover_guideline_files: read failed; skipping",
                extra={"path": rel_path, "error": str(e)},
            )
            continue

        if len(data) > MAX_GUIDELINE_BYTES:
            oversize_count += 1
            _LOG.info(
                "discover_guideline_files: oversize policy file skipped",
                extra={
                    "path": rel_path,
                    "byte_size": len(data),
                    "cap": MAX_GUIDELINE_BYTES,
                },
            )
            continue

        if len(data) == 0:
            # Empty policy files carry no rules; A-2 would extract
            # nothing — skip with INFO log. (GuidelineFileV1.body
            # has min_length=1 so we'd fail validation anyway.)
            _LOG.info(
                "discover_guideline_files: empty file skipped",
                extra={"path": rel_path},
            )
            continue

        try:
            body = data.decode("utf-8")
        except UnicodeDecodeError:
            _LOG.warning(
                "discover_guideline_files: non-utf8 file skipped",
                extra={"path": rel_path},
            )
            continue

        files.append(
            GuidelineFileV1(
                relative_path=rel_path,
                scope_dir=_derive_scope_dir(rel_path),
                source_pattern=pattern,
                body=body,
                content_sha256=_hash_bytes(data),
            )
        )

    return DiscoveredGuidelineFilesV1(
        files=tuple(files),
        files_cap_hit=cap_hit,
        oversize_files_count=oversize_count,
    )


# ─── Sprint 26 / B-3: knowledge-doc discovery ─────────────────────


def discover_knowledge_docs(
    *,
    workspace: Path,
    custom_knowledge_paths: tuple[str, ...] = (),
) -> DiscoveredRepoDocsV1:
    """Walk ``workspace`` and emit one ``RepoDocV1`` per in-scope
    knowledge document (ADRs, RFCs, architecture docs, runbooks).

    Carves out the knowledge side of ``discover_repo_docs`` per
    program plan §B-3:
      * Reuses ``discover_repo_docs``'s underlying walk + scope rules
        (README, CLAUDE.md, docs/**/*.md).
      * Filters OUT any file matching Subsystem A's guideline
        patterns (``DEFAULT_GUIDELINE_PATTERNS``) — those are
        owned by ``discover_guideline_files``; guideline wins
        per the program plan's explicit dispatch precedence.
      * Filters IN any file whose ``doc_kind`` heuristic (per
        B-1's ``codemaster/policy/doc_kind_heuristic.py``) is
        non-OTHER (ADR / RFC / architecture / runbook), OR any
        file whose path matches a ``custom_knowledge_paths``
        pattern (from ``.codemaster.yaml::knowledge.custom_knowledge_paths``).

    The exclusion-first / inclusion-second order is important: a
    file matching BOTH guideline + knowledge patterns is owned by
    Subsystem A (guidelines win). Without this, a customer who
    extends knowledge.file_patterns to include ``ARCHITECTURE.md``
    would see it double-indexed into both subsystems.

    Pure function: no I/O beyond the walk + reads from
    ``discover_repo_docs``; no logging, no DB.

    Args:
        workspace: cloned repo root.
        custom_knowledge_paths: additive patterns from A-7's
            ``.codemaster.yaml::knowledge.custom_knowledge_paths``.
            Empty by default.

    Returns:
        ``DiscoveredRepoDocsV1`` envelope (reuses Sprint 10 contract)
        with knowledge docs only.

    Raises:
        ``MalformedPatternError`` if any custom_knowledge_paths
        pattern contains ``..`` or is absolute (defensive — A-7
        validates upstream).
    """
    # Lazy-imported to avoid circular dep with policy/doc_kind.
    from codemaster.policy.doc_kind_heuristic import (  # noqa: PLC0415
        derive_doc_kind,
    )
    from contracts.knowledge_chunks.v1 import KnowledgeDocKind  # noqa: PLC0415

    _validate_custom_patterns(custom_knowledge_paths)

    # Step 1: candidate set = all .md files Sprint-10's
    # discover_repo_docs walks.
    all_docs = discover_repo_docs(workspace=workspace)

    # Step 2: filter out guideline patterns + filter in knowledge
    # patterns (heuristic OR custom).
    knowledge: list[RepoDocV1] = []
    for doc in all_docs.docs:
        # Exclude if matched by any guideline pattern (Subsystem A
        # owns those).
        if _matches_guideline_pattern(doc.relative_path, DEFAULT_GUIDELINE_PATTERNS):
            continue
        # Include if doc_kind heuristic classifies as non-OTHER.
        kind = derive_doc_kind(doc.relative_path)
        if kind != KnowledgeDocKind.OTHER:
            knowledge.append(doc)
            continue
        # Otherwise: include only if matches a custom knowledge path.
        if custom_knowledge_paths and _matches_guideline_pattern(
            doc.relative_path, custom_knowledge_paths
        ):
            knowledge.append(doc)

    # R-51 nit (Sprint 26 cluster, multi-lens audit 2026-05-22) —
    # hoisted the lazy import; record_knowledge_docs_cap_hit
    # internally handles the OTel-missing case via the shared
    # _otel.get_meter helper, so we don't need a try/import-guard
    # at this caller.
    if all_docs.docs_cap_hit:
        record_knowledge_docs_cap_hit()

    return DiscoveredRepoDocsV1(
        docs=tuple(knowledge),
        docs_cap_hit=all_docs.docs_cap_hit,
    )
