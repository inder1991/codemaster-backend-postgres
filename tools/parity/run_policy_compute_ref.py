"""Long-lived parity driver for the frozen Python compute_policy_rules activity chain.

Dedicated to the A-1 → A-2 → A-3 chain wrapped by `compute_policy_rules_activity` (do NOT fold into
run_policy_ref.py — that driver only exposes A-2 `extract_rules`). This driver materializes a FIXTURE
workspace into a temp dir, runs the REAL frozen `ComputePolicyRulesActivity.compute_policy_rules`
coroutine over it (the source-of-truth chain, NOT a re-implementation), and emits the resulting
`ComputedPolicyRulesV1` via `model_dump(mode="json")` so the TS port compares the envelope byte-for-byte.

Running the activity coroutine (rather than calling the three helpers directly) guarantees the driver
exercises the EXACT short-circuit + dedup/sort + discover + flatMap-extract + per-path-resolve chain the
production activity runs — no driver-vs-activity drift.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs under
the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` / `import contracts`
resolve the source-of-truth.

Op kind:

    {"id": "...", "op": "compute_policy_rules",
     "files": [{"path": "CLAUDE.md", "content": "..."}, ...],   # workspace files to materialize
     "symlinks": [{"path": "link.md", "target": "/abs/or/rel"}, ...],  # optional symlink-escape fixtures
     "changed_paths": ["a/b.py", ...],
     "custom_patterns": ["docs/conventions/*.md", ...],
     "knowledge_enabled": true}
        Materializes the fixture workspace under a fresh temp dir, builds ComputePolicyRulesInputV1 with
        workspace_path = <temp dir>, runs the activity, and returns:
            {"id": "...", "ok": true, "result": <ComputedPolicyRulesV1.model_dump(mode="json")>,
             "workspace": "<abs temp dir>"}
        The temp dir is NOT deleted between requests so the TS side can run its port over the SAME
        on-disk workspace; the TS test owns cleanup of the dirs it receives.

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from codemaster.activities.compute_policy_rules import ComputePolicyRulesActivity
from contracts.policy_compute.v1 import ComputePolicyRulesInputV1


def _materialize_workspace(req: dict[str, Any]) -> Path:
    """Write the fixture files (+ optional symlinks) into a fresh temp dir; return its realpath."""
    workspace = Path(tempfile.mkdtemp(prefix="policy_compute_parity_")).resolve()
    for entry in req.get("files", []):
        rel = entry["path"]
        target = workspace / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(entry["content"].encode("utf-8"))
    for link in req.get("symlinks", []):
        link_path = workspace / link["path"]
        link_path.parent.mkdir(parents=True, exist_ok=True)
        # target may be absolute (escape fixture) or workspace-relative.
        raw_target = link["target"]
        target = raw_target if os.path.isabs(raw_target) else str(workspace / raw_target)
        os.symlink(target, link_path)
    return workspace


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen compute_policy_rules activity and return its encoded result."""
    op = req["op"]
    if op == "compute_policy_rules":
        workspace = _materialize_workspace(req)
        payload = {
            "workspace_path": str(workspace),
            "custom_patterns": list(req.get("custom_patterns", [])),
            "knowledge_enabled": req.get("knowledge_enabled", True),
            "changed_paths": list(req.get("changed_paths", [])),
        }
        # Validate exactly as the activity would, then run the activity coroutine over the typed input.
        ComputePolicyRulesInputV1.model_validate(payload)
        activity = ComputePolicyRulesActivity()
        result = asyncio.run(activity.compute_policy_rules(payload))
        return {
            "id": req["id"],
            "ok": True,
            "result": result.model_dump(mode="json"),
            "workspace": str(workspace),
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
