"""Long-lived parity driver for the frozen Python `load_repo_config` config-loader.

Dedicated to the load-repo-config entry point (do NOT fold into run_python_ref.py — the generic runner
takes a flat kwargs dict, whereas `load_repo_config` takes a `Path` workspace, writes/omits a fixture
`.codemaster.yaml` on disk, and returns a constructed `CodemasterConfigV1` whose fail-open branch depends
on the on-disk file state — file-present-and-valid vs file-present-and-malformed vs file-absent).

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs under
the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` / `import contracts`
resolve the source-of-truth.

Op kind:

    {"id": "...", "op": "load_repo_config",
     "yaml": "<utf8 .codemaster.yaml body>"   # OPTIONAL — when ABSENT, NO file is written (missing-file
                                               #   fail-open branch). When present (even ""), the file is
                                               #   written with exactly this body.
    }
        Writes the `yaml` body (if the key is present) into `<tmp>/.codemaster.yaml`, runs
        `load_repo_config(Path(<tmp>))`, and returns:
            {"id": "...", "ok": true, "result": <CodemasterConfigV1.model_dump(mode="json")>}

CodemasterConfigV1 is pure-structural (bool / int / str / nested-model — NO bare float per the contract's
own note), so the dumped config canonicalizes whole on both sides; no per-field stripping is needed.

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one bad
request never tears down the long-lived process.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any

from codemaster.policy.config_loader import load_repo_config

_CONFIG_FILENAME = ".codemaster.yaml"


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen `load_repo_config` and return its encoded result."""
    op = req["op"]
    if op == "load_repo_config":
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            # KEY-PRESENCE, not truthiness: an empty-string body ("") IS written (empty-file branch);
            # an ABSENT "yaml" key writes NOTHING (missing-file branch). Mirrors the TS oracle.
            if "yaml" in req:
                (workspace / _CONFIG_FILENAME).write_text(req["yaml"], encoding="utf-8")
            cfg = load_repo_config(workspace)
        return {
            "id": req["id"],
            "ok": True,
            "result": cfg.model_dump(mode="json"),
        }
    raise ValueError(f"unknown op: {op!r}")


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        try:
            resp = _handle(req)
        except Exception as exc:  # report, never crash the long-lived process
            resp = {"id": req.get("id"), "ok": False, "err": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
