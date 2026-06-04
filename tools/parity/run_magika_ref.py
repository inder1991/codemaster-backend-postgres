"""Long-lived parity driver for the frozen Python magika file classifier (TOLERATED-DIVERGENCE axis).

Dedicated to the magika seam (do NOT fold into run_python_ref.py — magika classification is a Tier-B
IMPURE subsystem: it loads an ML model and is explicitly excluded from the pure-function Tier-A
runner). The TS agreement test (test/parity/magika_agreement.parity.test.ts) drives this process to
obtain the FROZEN Python magika label for each corpus file, then compares it against the npm magika
label the TS classifier emits. Acceptance is a LABEL-AGREEMENT RATE (>=95%), not byte-parity — see
ADR-0065.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` resolves the
source-of-truth and `from magika import Magika` loads the pinned Python magika (1.0.2).

Two ops:

    {"id": "...", "op": "label_path", "path": "<absolute-or-relative path>"}
        Reads the file bytes, derives the magika label EXACTLY as the frozen
        MagikaFileClassifier.classify does (empty -> "empty"; otherwise the lowercased model label via
        the same `_extract_magika_label` fallback chain). Response:
            {"id": "...", "ok": true, "label": "python", "byte_size": 1234}

    {"id": "...", "op": "label_bytes", "b64": "<base64 of the bytes>"}
        Same derivation, but the bytes arrive inline (lets the test feed synthetic buffers without a
        file). Response: {"id": "...", "ok": true, "label": "...", "byte_size": N}

The label derivation reuses the frozen `_extract_magika_label` helper so the Python reference is the
literal source-of-truth wrapper logic, not a re-implementation. On any exception the driver emits
{"id": "...", "ok": false, "err": "..."} and keeps running, so one bad request never tears down the
long-lived process. The Magika model is loaded ONCE at startup (expensive) and reused across requests.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path
from typing import Any

from codemaster.files.magika_classifier import _extract_magika_label


def _derive_label(magika: Any, body: bytes) -> str:
    """Mirror MagikaFileClassifier.classify's label derivation on raw bytes."""
    if not body:
        return "empty"
    result = magika.identify_bytes(body)
    return _extract_magika_label(result)


def _handle(magika: Any, req: dict[str, Any]) -> dict[str, Any]:
    op = req["op"]
    if op == "label_path":
        body = Path(req["path"]).read_bytes()
        return {
            "id": req["id"],
            "ok": True,
            "label": _derive_label(magika, body),
            "byte_size": len(body),
        }
    if op == "label_bytes":
        body = base64.b64decode(req["b64"])
        return {
            "id": req["id"],
            "ok": True,
            "label": _derive_label(magika, body),
            "byte_size": len(body),
        }
    raise ValueError(f"unknown op: {op!r}")


def main() -> int:
    # Load the model once. If magika can't load here, fail the whole process loudly so the TS side's
    # readiness probe (a single label_bytes round-trip) sees the dead pipe and SKIPS the suite rather
    # than hanging — consistent with the model-availability skip contract in the agreement test.
    from magika import Magika  # noqa: PLC0415 — deferred so an import error surfaces as a clean stderr line

    magika = Magika()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        try:
            resp = _handle(magika, req)
        except Exception as exc:  # report, never crash the long-lived process
            resp = {"id": req.get("id"), "ok": False, "err": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
