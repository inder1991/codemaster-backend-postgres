"""Long-lived parity driver for the frozen Python policy rule_extractor.

Dedicated to the policy `extract_rules` entry point (do NOT fold into run_python_ref.py — that
generic runner calls `fn(**kwargs)`, but `extract_rules` requires a constructed `GuidelineFileV1`
Pydantic instance as its single positional argument, not a kwargs dict). This driver reconstructs
the model from the wire dict, calls the frozen `extract_rules`, and emits each ExtractedRuleV1 via
`model_dump(mode="json")` so the TS port compares the rule objects byte-for-byte.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` /
`import contracts` resolve the source-of-truth.

Op kind:

    {"id": "...", "op": "extract_rules", "guideline_file": {<GuidelineFileV1 fields>}}
        Constructs GuidelineFileV1(**guideline_file) and calls extract_rules(gf). Response:
            {"id": "...", "ok": true, "rules": [<ExtractedRuleV1.model_dump(mode="json")>, ...]}

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one
bad request never tears down the long-lived process.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from codemaster.policy.rule_extractor import extract_rules
from contracts.guideline_files.v1 import GuidelineFileV1


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen extract_rules and return its encoded result."""
    op = req["op"]
    if op == "extract_rules":
        gf = GuidelineFileV1(**req["guideline_file"])
        rules = extract_rules(gf)
        return {
            "id": req["id"],
            "ok": True,
            "rules": [r.model_dump(mode="json") for r in rules],
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
