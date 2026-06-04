"""Long-lived parity driver for the frozen Python `_do_classify` classify-files orchestration.

Dedicated to the classify-files entry point (do NOT fold into run_python_ref.py — the generic runner
takes a flat kwargs dict and canonicalizes a single result, whereas `_do_classify` takes a `Path`
workspace + a tuple of relative paths + an injected `FileClassifierPort`, writes fixture files to disk,
and returns a constructed `FileRoutingV1` of nested `FileClassificationV1` instances).

The magika ML is OUT OF SCOPE here (separately covered by run_magika_ref.py / test:magika). This driver
injects a STUB classifier whose `classify` looks up a CALLER-SUPPLIED map `{relative_path -> wire dict}`
so BOTH the Python and TS sides classify identically and the routing/failure-isolation orchestration is
byte-verifiable WITHOUT the ~150s ONNX model load. The classify-FAILURE case is driven by a caller-
supplied `classify_fail` set: the stub raises `RuntimeError` for those paths (mirroring the Python
`except Exception` isolation branch). The read-FAILURE case is driven by simply NOT writing a fixture
file for a path (so `Path.read_bytes` raises `FileNotFoundError`, an `OSError` subclass).

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` / `import
contracts` resolve the source-of-truth.

Op kind:

    {"id": "...", "op": "do_classify",
     "files": ["a.md", "b.py", ...],                       # the INPUT-ORDER tuple
     "fixtures": {"a.md": "<utf8 file body>", ...},        # paths to write to the temp workspace
     "classifications": {"a.md": <FileClassificationV1 wire dict>, ...},  # stub lookup map
     "classify_fail": ["bad.py", ...]}                     # paths the stub raises for
        Writes each fixtures entry into a fresh temp dir, runs `_do_classify(workspace=<tmp>,
        files=tuple(files), classifier=<stub>)`, and returns:
            {"id": "...", "ok": true, "result": <FileRoutingV1.model_dump(mode="json")>}

A path may be in `files` but NOT in `fixtures` → read failure (FileNotFoundError) → classifier_failures.
A path may be in `classify_fail` → stub raises → classifier_failures. Both are absent from all buckets
and from `classifications`.

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one bad
request never tears down the long-lived process.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

from codemaster.activities.classify_files import _do_classify
from contracts.file_classification.v1 import FileClassificationV1


class _MapStubClassifier:
    """Deterministic stub mirroring `FileClassifierPort`. Looks up the caller-supplied `{path -> wire
    dict}` map and reconstructs the `FileClassificationV1`; raises for any path in `fail` (mirroring the
    frozen Python `except Exception` isolation branch). NO magika — the ML is out of scope here."""

    def __init__(
        self,
        *,
        classifications: dict[str, dict[str, Any]],
        fail: set[str],
    ) -> None:
        self._classifications = classifications
        self._fail = fail

    async def classify(self, *, path: str, body: bytes) -> FileClassificationV1:
        if path in self._fail:
            raise RuntimeError(f"parity stub: forced classify failure for {path!r}")
        return FileClassificationV1(**self._classifications[path])


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen `_do_classify` and return its encoded result."""
    op = req["op"]
    if op == "do_classify":
        files: list[str] = req["files"]
        fixtures: dict[str, str] = req.get("fixtures", {})
        classifications: dict[str, dict[str, Any]] = req.get("classifications", {})
        classify_fail: set[str] = set(req.get("classify_fail", []))

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            for rel, body in fixtures.items():
                abs_path = workspace / rel
                abs_path.parent.mkdir(parents=True, exist_ok=True)
                abs_path.write_text(body, encoding="utf-8")

            stub = _MapStubClassifier(classifications=classifications, fail=classify_fail)
            result = asyncio.run(
                _do_classify(
                    workspace=workspace,
                    files=tuple(files),
                    classifier=stub,  # type: ignore[arg-type]
                )
            )
        return {
            "id": req["id"],
            "ok": True,
            "result": result.model_dump(mode="json"),
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
