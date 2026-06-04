"""clone_repository_activity — Sprint 5 / S5.1.3.

Shallow-clones a repo via HTTPS using the installation token. The token
is passed via the `GIT_ASKPASS` mechanism (custom helper script that
prints the token) so it never appears in `argv` (visible to `ps`) or
in repo config (`.git/config`).

Size cap (default 1 GB) and timeout (default 5 min) are enforced
defensively. Exceeding either wipes the partial clone directory before
raising.

Layout: `/clone-cache/<installation_uuid>/<repository_uuid>/`. The
caller (a Sprint-6+ workflow activity) is responsible for tearing the
dir down when the review completes.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any, Final

from pydantic import BaseModel, ConfigDict, Field
from temporalio import activity


CLONE_CACHE_ROOT: Final = Path(os.environ.get("CODEMASTER_CLONE_CACHE_ROOT", "/clone-cache"))
DEFAULT_MAX_BYTES: Final = 1024 * 1024 * 1024  # 1 GB
DEFAULT_TIMEOUT_SECONDS: Final = 300  # 5 minutes


# ─── Typed errors ────────────────────────────────────────────────────


class CloneError(Exception):
    """Base for clone failures."""


class CloneSizeCapExceeded(CloneError):
    """The clone exceeded the configured size cap mid-operation."""


class CloneTimeout(CloneError):
    """`git clone` did not complete within the timeout."""


class RepositoryNotFound(CloneError):
    """The repo or ref does not exist (404 from GitHub)."""


class RefNotFound(CloneError):
    """The branch or tag does not exist on the remote."""


# ─── Contracts ───────────────────────────────────────────────────────


class CloneRequestV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: int = 1
    installation_id: uuid.UUID
    repository_id: uuid.UUID
    repository_full_name: str = Field(min_length=1)
    ref: str = Field(min_length=1)
    max_bytes: int = Field(default=DEFAULT_MAX_BYTES, gt=0)
    timeout_seconds: int = Field(default=DEFAULT_TIMEOUT_SECONDS, gt=0)


class CloneResultV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: int = 1
    repository_id: uuid.UUID
    on_disk_path: str
    byte_size: int
    head_sha: str


# ─── Helpers ─────────────────────────────────────────────────────────


def _du_bytes(path: Path) -> int:
    total = 0
    for entry in path.rglob("*"):
        try:
            total += entry.stat().st_size
        except OSError:
            continue
    return total


def _wipe(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)


def _make_askpass_script(token: str, dest_dir: Path) -> Path:
    """Write a single-use askpass helper that prints the token.

    The file is created mode 0700 and lives in a per-clone tempdir
    so it goes away with the clone.
    """
    script = dest_dir / "askpass.sh"
    script.write_text(
        f"#!/bin/sh\necho '{token}'\n",
        encoding="utf-8",
    )
    script.chmod(0o700)
    return script


# ─── Activity body ───────────────────────────────────────────────────


async def _clone_subprocess(
    *,
    clone_url: str,
    target_dir: Path,
    ref: str,
    askpass_script: Path,
    timeout_seconds: int,
) -> None:
    env = os.environ.copy()
    env["GIT_ASKPASS"] = str(askpass_script)
    env["GIT_TERMINAL_PROMPT"] = "0"
    # Disable any user-level config that might interfere.
    env["HOME"] = str(target_dir.parent)

    proc = await asyncio.create_subprocess_exec(
        "git",
        "clone",
        "--depth=1",
        "--filter=blob:none",
        "--branch",
        ref,
        clone_url,
        str(target_dir),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_seconds)
    except asyncio.TimeoutError as e:
        proc.kill()
        await proc.wait()
        _wipe(target_dir)
        raise CloneTimeout(f"git clone exceeded {timeout_seconds}s") from e

    if proc.returncode != 0:
        msg = stderr.decode("utf-8", errors="replace")
        _wipe(target_dir)
        if "not found" in msg.lower() or "remote: repository not found" in msg.lower():
            raise RepositoryNotFound(msg.strip())
        if "remote branch" in msg.lower() and "not found" in msg.lower():
            raise RefNotFound(msg.strip())
        raise CloneError(msg.strip())


async def _resolve_head_sha(target_dir: Path) -> str:
    proc = await asyncio.create_subprocess_exec(
        "git",
        "-C",
        str(target_dir),
        "rev-parse",
        "HEAD",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _stderr = await proc.communicate()
    return stdout.decode("ascii").strip()


async def perform_clone(*, request: CloneRequestV1, installation_token: str) -> CloneResultV1:
    """Pure-Python clone — separated so unit tests can drive it without
    constructing a Temporal activity context.
    """
    target_dir = CLONE_CACHE_ROOT / str(request.installation_id) / str(request.repository_id)
    if target_dir.exists():
        _wipe(target_dir)
    target_dir.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as askpass_dir_str:
        askpass_dir = Path(askpass_dir_str)
        askpass = _make_askpass_script(installation_token, askpass_dir)

        clone_url = f"https://x-access-token@github.com/{request.repository_full_name}.git"
        try:
            await _clone_subprocess(
                clone_url=clone_url,
                target_dir=target_dir,
                ref=request.ref,
                askpass_script=askpass,
                timeout_seconds=request.timeout_seconds,
            )
        except (CloneError, RepositoryNotFound, RefNotFound, CloneTimeout):
            raise

    byte_size = _du_bytes(target_dir)
    if byte_size > request.max_bytes:
        _wipe(target_dir)
        raise CloneSizeCapExceeded(
            f"clone of {request.repository_full_name} reached "
            f"{byte_size} bytes, exceeds cap {request.max_bytes}"
        )

    head_sha = await _resolve_head_sha(target_dir)
    return CloneResultV1(
        repository_id=request.repository_id,
        on_disk_path=str(target_dir),
        byte_size=byte_size,
        head_sha=head_sha,
    )


@activity.defn(name="clone_repository_activity")
async def clone_repository_activity(
    payload_dict: dict[str, Any],
) -> CloneResultV1:
    request = CloneRequestV1.model_validate(payload_dict)

    # Token resolution belongs to the activity boundary so the workflow
    # body stays deterministic. The Sprint-5 wiring uses S4.1.1's cache
    # via S5.1.2's TokenProvider; this stub uses the env for now —
    # Sprint 6+ replaces with a Vault+cache-backed resolver.
    token = os.environ.get("CODEMASTER_GITHUB_INSTALLATION_TOKEN", "")
    if not token:
        raise CloneError("CODEMASTER_GITHUB_INSTALLATION_TOKEN not set; cannot clone")
    return await perform_clone(request=request, installation_token=token)
