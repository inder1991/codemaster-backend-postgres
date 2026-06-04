"""Long-lived parity driver for the frozen GitHub-webhook HMAC-SHA256 signature verification.

Dedicated to the `verify_github_signature` seam (do NOT fold into run_python_ref.py — that runner
canonicalizes pure-function results, whereas this driver speaks base64-binary for body/secret and a
raw header string, and returns the frozen function's bare bool verbatim so the TS port can be proven
to agree on every matrix case). One interpreter, many requests: read JSONL on stdin and emit one JSON
line per request on stdout. Runs under the frozen submodule's venv with cwd at vendor/codemaster-py so
`import codemaster` resolves the source-of-truth.

Kept distinct from run_crypto_ref.py (the ADR-0033 AES-GCM field-encryption seam) and from any
JWT/GitHub-app-crypto driver — those drive different frozen primitives. This driver drives ONLY
`codemaster.api.github_webhook.verify_github_signature` + reports `GITHUB_SIGNATURE_PREFIX`.

`body` and `secret` cross the wire as base64 (binary-safe — webhook bodies and secrets are arbitrary
bytes). `header` crosses as a string or null (it IS a string on the Python signature, including the
`sha256=` prefix; null models the absent-header case).

Two op kinds:

    {"id": "...", "op": "verify", "body": "<b64>", "secret": "<b64>", "header": "<str>"|null}
        Decodes body/secret from base64, passes header through (None when null), calls the frozen
        `verify_github_signature(body=..., header=..., secret=...)`.
        Response: {"id": "...", "ok": true, "valid": <bool>}

    {"id": "...", "op": "prefix"}
        Reports the frozen `GITHUB_SIGNATURE_PREFIX` so the TS side can assert its constant matches.
        Response: {"id": "...", "ok": true, "prefix": "sha256="}

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one
bad request never tears down the long-lived process.

NOTE on the Python signature: `verify_github_signature(*, body: bytes, header: str, secret: bytes)`
annotates `header` as `str`, but the body's first guard `if not header or not header.startswith(...)`
short-circuits on a falsy header (None / "") and returns False without touching `.startswith` on a
non-str — so passing None for the absent-header case is exercised exactly as the FastAPI caller's
`x_hub_signature_256: str | None` path would after its own None check. This driver passes None through
so the TS `header: string | null` contract is proven against the same behavior.
"""

from __future__ import annotations

import base64
import json
import sys
from typing import Any

from codemaster.api.github_webhook import (
    GITHUB_SIGNATURE_PREFIX,
    verify_github_signature,
)


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen webhook primitive and return its encoded result."""
    op = req["op"]
    if op == "verify":
        body = base64.b64decode(req["body"])
        secret = base64.b64decode(req["secret"])
        header = req["header"]  # str or None — passed through verbatim
        valid = verify_github_signature(body=body, header=header, secret=secret)
        return {"id": req["id"], "ok": True, "valid": valid}
    if op == "prefix":
        return {"id": req["id"], "ok": True, "prefix": GITHUB_SIGNATURE_PREFIX}
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
