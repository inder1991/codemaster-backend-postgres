"""Long-lived parity driver for the frozen Python file router.

Dedicated to the `codemaster.files.router.decide_route` entry point (do NOT fold into
run_python_ref.py — that generic runner calls `fn(**kwargs)` and `json.dumps`-encodes the result, but
`decide_route` requires a constructed `FileClassificationV1` Pydantic instance as its single
positional argument AND returns a `frozenset[RoutingBucket]`, which is not JSON-serializable). This
driver reconstructs the model from the wire dict, calls the frozen `decide_route`, and emits the
returned frozenset as a SORTED list of bucket strings so the TS port compares byte-for-byte under a
stable, set-order-independent encoding.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` /
`import contracts` resolve the source-of-truth.

Op kind:

    {"id": "...", "op": "decide_route", "classification": {<FileClassificationV1 fields>}}
        Constructs FileClassificationV1(**classification) and calls decide_route(c). Response:
            {"id": "...", "ok": true, "buckets": [<sorted bucket strings>]}

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one
bad request never tears down the long-lived process.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from codemaster.files.router import decide_route
from contracts.file_classification.v1 import FileClassificationV1


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen decide_route and return its encoded result."""
    op = req["op"]
    if op == "decide_route":
        c = FileClassificationV1(**req["classification"])
        decision = decide_route(c)
        # frozenset has no order; encode as a sorted list so the wire form is deterministic and the
        # TS port (which sorts its ReadonlySet members the same way) compares byte-for-byte.
        return {"id": req["id"], "ok": True, "buckets": sorted(decision)}
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
