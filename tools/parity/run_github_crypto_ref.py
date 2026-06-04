"""Long-lived parity driver for the frozen GitHub-crypto seam (App JWT signing).

Dedicated to the github crypto seam (do NOT fold into run_python_ref.py — that runner canonicalizes
pure-function results and cannot pass a Clock object). This driver constructs a frozen `FakeClock`
from a caller-supplied unix-millisecond instant and drives the frozen `sign_app_jwt`, returning the
JWT string verbatim so the TS side can compare it BYTE-FOR-BYTE. RS256 (RSA-PKCS#1-v1.5 over SHA-256)
is deterministic, so the same (app_id, key, clock) yields a byte-identical JWT on both impls.

One interpreter, many requests: read JSONL on stdin and emit one JSON line per request on stdout.
Runs under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster`
resolves the source-of-truth.

One op kind:

    {"id": "...", "op": "sign_app_jwt", "app_id": "123456", "now_ms": 1780574400000,
     "private_key_pem": "-----BEGIN RSA PRIVATE KEY-----\\n..."}
        Builds FakeClock(now=datetime.fromtimestamp(now_ms/1000, tz=UTC)) and calls the frozen
        sign_app_jwt(app_id=..., private_key_pem=..., clock=clock). Response:
            {"id": "...", "ok": true, "jwt": "<header64>.<payload64>.<sig64>"}
        On a malformed PEM the frozen function raises GitHubPrivateKeyMalformed; the driver reports it
        as a value (ok: false, err_type: "GitHubPrivateKeyMalformed") so the TS test can assert that
        Python ALSO rejects the same bad key.

On any other exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so
one bad request never tears down the long-lived process.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from typing import Any

from codemaster.infra.clock import FakeClock
from codemaster.integrations.github.app_jwt import (
    GitHubPrivateKeyMalformed,
    sign_app_jwt,
)


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen primitive and return its encoded result."""
    op = req["op"]
    if op == "sign_app_jwt":
        # FakeClock built from the caller's exact unix-ms instant — tz-aware UTC so the frozen
        # FakeClock's tzinfo guard passes and `.timestamp()` is unambiguous.
        now = datetime.fromtimestamp(req["now_ms"] / 1000, tz=UTC)
        clock = FakeClock(now=now)
        try:
            jwt_str = sign_app_jwt(
                app_id=req["app_id"],
                private_key_pem=req["private_key_pem"],
                clock=clock,
            )
        except GitHubPrivateKeyMalformed as exc:
            # Reported as a VALUE (not a crash) so the TS test can assert Python rejects too.
            return {
                "id": req["id"],
                "ok": False,
                "err_type": "GitHubPrivateKeyMalformed",
                "err": str(exc),
            }
        return {"id": req["id"], "ok": True, "jwt": jwt_str}
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
