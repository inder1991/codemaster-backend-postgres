"""Dedicated parity driver for the output-safety subsystem (coerce_for_contract + OutputSafetyValidator).

Not the generic run_python_ref.py: coerce_for_contract takes a CONTRACT CLASS arg (resolved here from a
name) and OutputSafetyValidator is a class; both return shapes with bare floats (SecretFindingV1.confidence)
that the generic canonicalizer rejects. Returns raw model_dump dicts so the TS test compares field-by-field.

Run with cwd=vendor/codemaster-py so `import codemaster` / `import contracts` resolve the frozen source.
"""

from __future__ import annotations

import json
import sys

from codemaster.llm.contract_coercion import coerce_for_contract
from codemaster.security.output_safety import OutputSafetyValidator
from contracts.arbitration_intent.v1 import ArbitrationIntentV1
from contracts.review_chunk_response.v1 import ReviewChunkResponseV1
from contracts.review_findings.v1 import ReviewFindingV1
from contracts.walkthrough.v1 import WalkthroughV1

_CONTRACTS = {
    "WalkthroughV1": WalkthroughV1,
    "ReviewFindingV1": ReviewFindingV1,
    "ReviewChunkResponseV1": ReviewChunkResponseV1,
    "ArbitrationIntentV1": ArbitrationIntentV1,
}


def _noop(_event: object) -> None:
    """Silence the default truncation log so stdout stays pure JSONL."""


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        try:
            op = req["op"]
            if op == "coerce":
                schema = _CONTRACTS[req["contract"]]
                out = coerce_for_contract(req["payload"], schema, on_truncate=_noop)
                resp = {"id": req["id"], "ok": True, "coerced": out}
            elif op == "validate":
                decision = OutputSafetyValidator().validate(req["text"])
                resp = {"id": req["id"], "ok": True, "decision": decision.model_dump(mode="json")}
            elif op == "validate_finding":
                finding = ReviewFindingV1(**req["finding"])
                decision = OutputSafetyValidator().validate_finding(finding)
                resp = {"id": req["id"], "ok": True, "decision": decision.model_dump(mode="json")}
            else:
                resp = {"id": req["id"], "ok": False, "err": f"unknown op {op!r}"}
        except Exception as e:  # report, never crash the long-lived process
            resp = {"id": req["id"], "ok": False, "err": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
