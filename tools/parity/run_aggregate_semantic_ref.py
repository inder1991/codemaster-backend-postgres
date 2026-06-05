"""Long-lived parity driver for the frozen Python `aggregate_semantic` (the semantic-merge stage).

Dedicated to the stage-2 semantic merge (separate from run_aggregate_ref.py, which drives the WHOLE
`_do_aggregate` chain with a FORCED-SKIP embedder). This driver drives `aggregate_semantic` DIRECTLY
with an EXPLICIT-VECTOR embedder so the TS port's real cosine-merge branch can be proven byte-equal
against the source-of-truth — the merge logic (cosine, 0.92 threshold, same-file guard, higher-confidence
absorb, body join, max severity/confidence) is exercised on both sides with IDENTICAL controlled vectors.

Why an explicit-vector embedder (not the Python `RecordingEmbeddingsClient`): that client derives each
vector from `abs(hash(text))` seeding a Mersenne-Twister RNG, which is NOT reproducible cross-language
(CPython string `hash()` is salted; MT's `uniform` stream is impractical to replicate in TS). So the test
supplies a `body -> vector` table; both the Python embedder here and the TS table-embedder look up the
exact vector per body. The cosine of any pair is then identical across runtimes, so the merge decisions
(merge / no-merge, absorb direction) are deterministic and parity-significant.

The embedder can also be told to FAIL (forcing the fail-open `semantic_skipped=True` branch) and to
return a WRONG vector count (the defensive shape-guard branch).

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` /
`import contracts` resolve the source-of-truth.

Op kind:

    {"id": "...", "op": "aggregate_semantic",
     "findings": [<ReviewFindingV1 wire dict>, ...],
     "vectors": {"<body text>": [<float>, ...], ...},   # explicit body->vector table
     "fail": <bool>,                                     # force EmbeddingsError fail-open (default false)
     "wrong_count": <bool>,                              # return one too few vectors (default false)
     "threshold": <float>}                               # optional; defaults to SEMANTIC_MERGE_THRESHOLD
        Runs aggregate_semantic(findings, embedder=<table>, threshold=...) and returns:
            {"id": "...", "ok": true,
             "result": {"findings": [<ReviewFindingV1.model_dump(mode="json")>, ...],
                        "semantic_skipped": <bool>}}

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from codemaster.adapters.embeddings_port import EmbeddingsError, EmbedResult
from codemaster.review.aggregation_semantic import (
    SEMANTIC_MERGE_THRESHOLD,
    aggregate_semantic,
)
from contracts.review_findings.v1 import ReviewFindingV1


class _TableEmbedder:
    """Embedder returning explicit per-body vectors from a table.

    Optionally raises `EmbeddingsError` (fail-open branch) or returns one fewer vector than inputs
    (the defensive vector-count-mismatch branch)."""

    def __init__(
        self,
        *,
        table: dict[str, list[float]],
        fail: bool = False,
        wrong_count: bool = False,
    ) -> None:
        self._table = table
        self._fail = fail
        self._wrong_count = wrong_count

    async def embed(self, req: Any) -> EmbedResult:  # noqa: ANN401 — mirrors the Port signature
        if self._fail:
            raise EmbeddingsError("parity driver: forced embedder failure (fail-open)")
        vectors = [self._table[text] for text in req.texts]
        if self._wrong_count and vectors:
            vectors = vectors[:-1]
        return EmbedResult(
            vectors=vectors,
            model_name=req.model_name,
            model_version="parity-v1",
            cache_hits=0,
        )


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    op = req["op"]
    if op == "aggregate_semantic":
        findings = tuple(ReviewFindingV1(**d) for d in req["findings"])
        table: dict[str, list[float]] = {
            k: [float(x) for x in v] for k, v in req.get("vectors", {}).items()
        }
        embedder = _TableEmbedder(
            table=table,
            fail=bool(req.get("fail", False)),
            wrong_count=bool(req.get("wrong_count", False)),
        )
        threshold = float(req.get("threshold", SEMANTIC_MERGE_THRESHOLD))
        out, semantic_skipped = asyncio.run(
            aggregate_semantic(
                findings,
                embedder=embedder,  # type: ignore[arg-type]
                threshold=threshold,
            )
        )
        return {
            "id": req["id"],
            "ok": True,
            "result": {
                "findings": [f.model_dump(mode="json") for f in out],
                "semantic_skipped": semantic_skipped,
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
