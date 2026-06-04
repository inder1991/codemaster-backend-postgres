"""Long-lived parity driver for the frozen Python `_do_aggregate` aggregation pipeline.

Dedicated to the aggregate-findings entry point (do NOT fold into run_python_ref.py — that generic
runner canonicalizes results and REJECTS bare floats, but aggregated findings carry a `confidence`
float that must survive verbatim, and `_do_aggregate` takes a constructed tuple of `ReviewFindingV1`
Pydantic instances + a forced-skip embedder, not a flat kwargs dict). This driver reconstructs the
findings from their wire dicts, drives the frozen `_do_aggregate` with a FAILING embedder (so the
semantic stage takes the deterministic fail-open skip path — matching the TS no-embedder seam), and
emits the resulting `AggregatedFindingsV1` via `model_dump(mode="json")` so the TS port can diff the
envelope (findings list + ORDER + dedupe_stats) byte-for-byte (confidence float stripped from the
canonical compare on the TS side, asserted structurally).

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` /
`import contracts` resolve the source-of-truth.

Op kind:

    {"id": "...", "op": "do_aggregate",
     "findings": [<ReviewFindingV1 wire dict>, ...],
     "policy_revision": <int>}
        Constructs each ReviewFindingV1(**dict), runs _do_aggregate(findings, embedder=<failing>,
        policy_revision=...), and returns:
            {"id": "...", "ok": true, "result": <AggregatedFindingsV1.model_dump(mode="json")>}

The embedder is a stub whose `.embed` always raises `EmbeddingsError`, forcing
`aggregate_semantic`'s fail-open branch. Combined with its `len(findings) < 2` early return, the
frozen Python's `semantic_skipped` flag is then byte-identical to the TS no-embedder seam for every
input (False when fewer than 2 findings reach the stage, True otherwise).

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one
bad request never tears down the long-lived process.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from codemaster.adapters.embeddings_port import EmbeddingsError
from codemaster.review.aggregate_activity import _do_aggregate
from contracts.review_findings.v1 import ReviewFindingV1


class _FailingEmbedder:
    """Embedder stub whose every call raises `EmbeddingsError` — forces `aggregate_semantic`'s
    fail-open skip branch, matching the TS port's no-embedder seam exactly."""

    async def embed(self, req: Any) -> Any:  # noqa: ANN401 — stub mirrors the Port signature
        raise EmbeddingsError("parity driver: no embedder (forced skip path)")


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen `_do_aggregate` and return its encoded result."""
    op = req["op"]
    if op == "do_aggregate":
        findings = tuple(ReviewFindingV1(**d) for d in req["findings"])
        result = asyncio.run(
            _do_aggregate(
                findings,
                embedder=_FailingEmbedder(),  # type: ignore[arg-type]
                policy_revision=req["policy_revision"],
            )
        )
        return {
            "id": req["id"],
            "ok": True,
            "result": result.model_dump(mode="json"),
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
