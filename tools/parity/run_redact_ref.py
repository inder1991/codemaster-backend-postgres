"""Long-lived parity driver for the frozen Python redact subsystem (detectors + redactor).

Dedicated to the redact seam (do NOT fold into run_python_ref.py — that runner canonicalizes
results and rejects bare floats, whereas this driver returns raw `model_dump(mode="json")` dicts
verbatim so the TS side compares the redactor's byte-output and the findings' offsets directly).
One interpreter, many requests: read JSONL on stdin and emit one JSON line per request on stdout.
Runs under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster`
resolves the source-of-truth.

Three op kinds:

    {"id": "...", "op": "detect_secrets", "text": "..."}
        Constructs the frozen PatternSecretDetector() and calls `.detect(text)`. Response:
            {"id": "...", "ok": true, "findings": [<SecretFindingV1.model_dump(mode="json")>, ...]}
        Each finding carries kind / snippet_redacted / start_offset / end_offset / confidence /
        schema_version.

    {"id": "...", "op": "detect_pii", "text": "..."}
        Constructs the frozen RegexPiiRedactor() and calls `.redact(text)` → (rewritten, findings).
        Response:
            {"id": "...", "ok": true, "rewritten": "...",
             "findings": [<PiiFindingV1.model_dump(mode="json")>, ...]}

    {"id": "...", "op": "redact", "text": "...", "findings": [{"start_offset": S, "end_offset": E, ...}]}
        Reconstructs a SecretFindingV1 from each dict (filling the non-offset required fields with
        valid placeholders so the contract validates — only the offsets drive redact_text) and calls
        the frozen `redact_text(text, findings)`. Response:
            {"id": "...", "ok": true, "redacted_text": "...", "spans_redacted": N}

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one
bad request never tears down the long-lived process.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from codemaster.security.output_redaction import redact_text
from codemaster.security.pattern_secret_detector import PatternSecretDetector
from codemaster.security.regex_pii_redactor import RegexPiiRedactor
from contracts.secret_detection.v1 import SecretFindingV1


def _reconstruct_secret_finding(raw: dict[str, Any]) -> SecretFindingV1:
    """Reconstruct a SecretFindingV1 from a wire dict — only the offsets drive redact_text.

    The non-offset required fields (kind / snippet_redacted / confidence) are filled from the dict
    when present, else valid placeholders, so the frozen contract validates without the caller having
    to supply them. redact_text consumes ``start_offset`` / ``end_offset`` exclusively.
    """
    return SecretFindingV1(
        kind=raw.get("kind", "secret"),
        snippet_redacted=raw.get("snippet_redacted", "…"),
        start_offset=raw["start_offset"],
        end_offset=raw["end_offset"],
        confidence=raw.get("confidence", 1.0),
    )


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the matching frozen primitive and return its encoded result."""
    op = req["op"]
    if op == "detect_secrets":
        findings = PatternSecretDetector().detect(req["text"])
        return {
            "id": req["id"],
            "ok": True,
            "findings": [f.model_dump(mode="json") for f in findings],
        }
    if op == "detect_pii":
        rewritten, findings = RegexPiiRedactor().redact(req["text"])
        return {
            "id": req["id"],
            "ok": True,
            "rewritten": rewritten,
            "findings": [f.model_dump(mode="json") for f in findings],
        }
    if op == "redact":
        findings = [_reconstruct_secret_finding(raw) for raw in req["findings"]]
        result = redact_text(req["text"], findings)
        return {
            "id": req["id"],
            "ok": True,
            "redacted_text": result.redacted_text,
            "spans_redacted": result.spans_redacted,
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
