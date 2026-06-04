"""Long-lived parity driver for the frozen Python `_parse_with_skip_malformed` review-response parser.

Dedicated to the review-chunk parser (do NOT fold into run_python_ref.py — that generic runner
canonicalizes results and REJECTS bare floats, but parsed `ReviewFindingV1` instances carry a
`confidence` FLOAT that must survive verbatim, and `_parse_with_skip_malformed` takes a list of raw
tool_use block dicts + an `allowed_evidence_ids` frozenset/None, not a flat kwargs dict). This driver
drives the frozen parser over the SAME (blocks, allowed_evidence_ids) the TS port runs, and emits the
parsed `(findings, intents)` tuples via `model_dump(mode="json")` so the TS port can diff them
byte-for-byte (confidence float stripped from the canonical compare on the TS side, asserted
structurally — the established bare-float handling).

The parser is the deterministic inv-14/15 enforcement seam: per-block skip-malformed loop + the
scope-authority drop (`activity_may_emit_scope("bedrock_review_chunk", ...)`) + the evidence-refs
subset enforcement. The frozen parser emits OTel counters on drops; those are observability, not
behavior — the byte-significant return value is the kept-findings tuple + intents tuple, which is what
this driver dumps + the TS port diffs.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` /
`import contracts` resolve the source-of-truth.

Op kind:

    {"id": "...", "op": "parse",
     "blocks": [<tool_use block dict>, ...],
     "allowed_evidence_ids": <null | [<ev_id str>, ...]>}
        null            → allowed_evidence_ids=None (evidence validation disabled)
        []              → allowed_evidence_ids=frozenset() (no refs allowed)
        ["ev_...", ...] → allowed_evidence_ids=frozenset(...) (subset check)
      Returns:
        {"id": "...", "ok": true,
         "result": {"findings": [<ReviewFindingV1.model_dump(mode="json")>, ...],
                    "intents":  [<ArbitrationIntentV1.model_dump(mode="json")>, ...]}}

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one
bad request never tears down the long-lived process.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from codemaster.review.activities import _parse_with_skip_malformed


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen `_parse_with_skip_malformed` and return its encoded result."""
    op = req["op"]
    if op == "parse":
        raw_allowed = req.get("allowed_evidence_ids")
        allowed = None if raw_allowed is None else frozenset(raw_allowed)
        findings, intents = _parse_with_skip_malformed(
            req["blocks"], allowed_evidence_ids=allowed
        )
        return {
            "id": req["id"],
            "ok": True,
            "result": {
                "findings": [f.model_dump(mode="json") for f in findings],
                "intents": [i.model_dump(mode="json") for i in intents],
            },
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
