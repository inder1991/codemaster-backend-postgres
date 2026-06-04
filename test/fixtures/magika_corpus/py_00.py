"""Shared workspace-clone helpers — Phase 6 Task 18.

Houses the cross-cutting symbols the workspace-aware clone activity
(:mod:`codemaster.activities._workspace_clone`) and its tests need:

* :class:`GitCloner` — narrow Protocol for the git driver. Production
  is :class:`codemaster.integrations.git.cloner.GitSubprocessCloner`;
  tests inject stubs.
* :data:`MAX_WORKSPACE_BYTES` — per-workspace size cap (200 MiB). The
  clone activity enforces this after the cloner returns; oversized
  workspaces raise :class:`WorkspaceTooLargeError`.
* :class:`CloneFailedError` — raised when the underlying git clone
  fails for any reason (auth, missing ref, network, timeout).
* :class:`WorkspaceTooLargeError` — raised when the cloned tree
  exceeds :data:`MAX_WORKSPACE_BYTES`.
* :func:`_byte_size_of_dir` — sum-of-regular-file-sizes helper used
  by the clone activity to measure the post-clone tree against the
  cap.

These symbols previously lived in
``codemaster/activities/clone_repo_for_review.py`` alongside the
legacy ``CloneActivity`` class. Phase 6 Task 18 deletes the legacy
module after the workspace-aware activity (Phase 6 spec §7.3) and
the worker bootstrap (Task 16) migrate to the workspace-lifecycle
subsystem. The 5 symbols above are still needed by the replacement
activity, so they relocate here rather than die with the legacy
module.

The Protocol shape is preserved verbatim from the legacy module so
existing :class:`GitSubprocessCloner` impls satisfy it without
modification.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final, Protocol

MAX_WORKSPACE_BYTES: Final = 200 * 1024 * 1024  # 200 MiB


class CloneFailedError(Exception):
    """Raised when the underlying git clone fails for any reason."""

    def __init__(self, *, repo: str, head_sha: str, reason: str) -> None:
        super().__init__(f"clone failed for {repo}@{head_sha[:8]}: {reason}")
        self.repo: Final = repo
        self.head_sha: Final = head_sha
        self.reason: Final = reason


class WorkspaceTooLargeError(Exception):
    """Raised when the cloned workspace exceeds MAX_WORKSPACE_BYTES."""

    def __init__(self, *, repo: str, head_sha: str, byte_size: int) -> None:
        super().__init__(
            f"workspace for {repo}@{head_sha[:8]} is "
            f"{byte_size} bytes; cap is {MAX_WORKSPACE_BYTES}"
        )
        self.repo: Final = repo
        self.head_sha: Final = head_sha
        self.byte_size: Final = byte_size


class GitCloner(Protocol):
    """Performs the actual git clone. Production: subprocess-git.

    ``pr_number`` (S19.SMOKE.3) — when supplied, the cloner uses
    ``pull/<pr_number>/head`` for the fetch step. This is the single
    path that handles both same-repo and cross-fork PRs (GitHub
    mirrors fork commits into the base repo's pull refs). When None,
    the fetch falls back to a direct ``head_sha`` ref.
    """

    async def clone(
        self,
        *,
        workspace: Path,
        repo_url: str,
        head_sha: str,
        paths: tuple[str, ...],
        pr_number: int | None = None,
    ) -> None: ...


def _byte_size_of_dir(path: Path) -> int:
    """Sum of regular-file sizes under ``path``.

    Symlinks are skipped (they don't carry their own bytes). Files
    that ``stat()`` cannot read (race against deletion, permission
    denied) are skipped silently — the workspace-size cap is a
    safety net, not a precise accounting tool.
    """
    total = 0
    for p in path.rglob("*"):
        if p.is_file() and not p.is_symlink():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return total


__all__ = [
    "MAX_WORKSPACE_BYTES",
    "CloneFailedError",
    "GitCloner",
    "WorkspaceTooLargeError",
    "_byte_size_of_dir",
]
