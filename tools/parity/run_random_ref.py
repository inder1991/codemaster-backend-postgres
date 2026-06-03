"""Long-lived stateful randomness parity driver for the frozen Python source-of-truth.

Dedicated to the randomness seam (do NOT fold into run_python_ref.py — that runner
canonicalizes results and rejects bare floats, which is exactly what bit-exact float
parity needs to compare verbatim). One interpreter, many requests, read JSONL on stdin
and emit one JSON line per request on stdout. Runs under the frozen submodule's venv with
cwd at vendor/codemaster-py so `import codemaster` resolves the source-of-truth.

Two request kinds:

    {"id": "...", "kind": "seeded", "seed": N, "calls": [<call>, ...]}
        Runs ALL calls IN ORDER on ONE SeededRandom(seed=N) so the Mersenne-Twister
        stream advances identically to the TS side. Each <call> is one of:
            {"m": "random"}                  -> {"f": <IEEE-754 big-endian hex>}
            {"m": "randint", "a": A, "b": B} -> {"i": <int>}
            {"m": "uniform", "a": A, "b": B} -> {"f": <IEEE-754 big-endian hex>}
            {"m": "choice", "seq": [...]}    -> {"c": <element>}
            {"m": "shuffle", "seq": [...]}   -> {"s": <resulting list>}
            {"m": "token_bytes", "n": N}     -> {"b": <hex>}
        Response: {"id": "...", "ok": true, "out": [<encoded call result>, ...]}

    {"id": "...", "kind": "uuid7", "ms": M}
        Builds a FakeClock pinned to the Unix epoch + M milliseconds and mints one
        uuid7. Response: {"id": "...", "ok": true, "out": {"uuid": "<str(uuid)>"}}.

Floats are emitted as `struct.pack(">d", value).hex()` (the IEEE-754 big-endian byte
pattern) so the TS side can compare bit-for-bit via Buffer.writeDoubleBE — no decimal
rounding ambiguity ever enters the comparison.

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps
running, so one bad request never tears down the long-lived process.
"""

from __future__ import annotations

import json
import struct
import sys
from datetime import UTC, datetime, timedelta
from typing import Any

from codemaster.infra.clock import FakeClock
from codemaster.infra.randomness import SeededRandom, uuid7


def _float_hex(value: float) -> str:
    """Return the IEEE-754 big-endian byte pattern of `value` as hex (bit-exact wire form)."""
    return struct.pack(">d", value).hex()


def _run_call(rng: SeededRandom, call: dict[str, Any]) -> dict[str, Any]:
    """Run one method call against the live RNG and encode its result for the wire."""
    method = call["m"]
    if method == "random":
        return {"f": _float_hex(rng.random())}
    if method == "uniform":
        return {"f": _float_hex(rng.uniform(call["a"], call["b"]))}
    if method == "randint":
        return {"i": rng.randint(call["a"], call["b"])}
    if method == "choice":
        return {"c": rng.choice(call["seq"])}
    if method == "shuffle":
        seq = list(call["seq"])
        rng.shuffle(seq)
        return {"s": seq}
    if method == "token_bytes":
        return {"b": rng.token_bytes(call["n"]).hex()}
    raise ValueError(f"unknown method: {method!r}")


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the matching frozen primitive and return its encoded result."""
    kind = req["kind"]
    if kind == "seeded":
        rng = SeededRandom(seed=req["seed"])
        out = [_run_call(rng, call) for call in req["calls"]]
        return {"id": req["id"], "ok": True, "out": out}
    if kind == "uuid7":
        # int(now.timestamp() * 1000) == ms for an epoch-anchored instant, so the
        # 48-bit timestamp prefix is fully deterministic from the request's `ms`.
        clock = FakeClock(now=datetime(1970, 1, 1, tzinfo=UTC) + timedelta(milliseconds=req["ms"]))
        return {"id": req["id"], "ok": True, "out": {"uuid": str(uuid7(clock=clock))}}
    raise ValueError(f"unknown kind: {kind!r}")


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
