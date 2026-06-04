"""ADVERSARIAL PARITY DRIVER (scratch) — frozen Python `_do_post` over the shared disposable PG.

LENS-2: atomic claim + lost-claim age-gating + stale-write guard + IFF. Drives the FROZEN `_do_post`
against the SAME disposable Postgres the TS doPost uses, with a STUB GhReviewClient scripted IDENTICALLY
to the TS scratch driver. JSONL on stdin → one JSON line per op on stdout (long-lived; one process drives
all scenarios). Emits the returned PostedReviewV1.model_dump + the recorded client-call sequence; a
companion `read_row`/`seed`/`preseed`/`exec` op set lets the harness drive the SAME FK chain + on-disk
state on BOTH sides.

NOT part of the product. Removed after parity verification.
"""

from __future__ import annotations

import asyncio
import json
import sys
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from codemaster.activities.post_review_results import _do_post
from codemaster.integrations.github.api_client import GitHubUnprocessableError
from codemaster.integrations.github.review_client import CreatedReviewV1
from contracts.aggregated_findings.v1 import AggregatedFindingsV1
from contracts.posted_review.v1 import PostedReviewV1
from contracts.review_findings.v1 import ReviewFindingV1
from contracts.walkthrough.pr_meta_v1 import PrMetaV1
from contracts.walkthrough.v1 import WalkthroughV1

DSN = "postgresql+asyncpg://postgres:postgres@localhost:5434/codemaster"


class StubGhClient:
    """Stub matching the TS makeStub: sequential create_review outcomes; records call sequence."""

    def __init__(self, create_seq: list[Any]) -> None:
        self._create_seq = list(create_seq)
        self.calls: dict[str, list[Any]] = {"createReview": [], "updateReview": []}

    async def find_existing_review_by_marker(self, **_: object) -> int | None:
        return None

    async def create_review(self, *, comments: list[dict[str, object]], **_: object) -> CreatedReviewV1:
        self.calls["createReview"].append({"comments_len": len(comments)})
        if not self._create_seq:
            raise AssertionError("stub create_review called more times than scripted")
        nxt = self._create_seq.pop(0)
        if nxt == "422":
            raise GitHubUnprocessableError("simulated 422 inline-comment-position rejection")
        return CreatedReviewV1(
            review_id=int(nxt["reviewId"]),
            comment_ids=tuple(int(c) for c in nxt.get("commentIds", [])),
        )

    async def update_review(self, *, review_id: int, **_: object) -> None:
        self.calls["updateReview"].append({"review_id": review_id})


def _finding(d: dict[str, Any]) -> ReviewFindingV1:
    return ReviewFindingV1.model_validate(d)


def _build_kwargs(inp: dict[str, Any]) -> dict[str, Any]:
    pr_meta = PrMetaV1.model_validate(inp["pr_meta"])
    walkthrough = WalkthroughV1.model_validate(inp["walkthrough"])
    aggregated = AggregatedFindingsV1.model_validate(inp["aggregated"])
    clr: dict[str, list[list[int]]] = inp["changed_line_ranges"]
    changed_line_ranges = {
        path: tuple((int(lo), int(hi)) for lo, hi in pairs) for path, pairs in clr.items()
    }
    return {
        "walkthrough": walkthrough,
        "aggregated": aggregated,
        "pr_meta": pr_meta,
        "head_sha": inp["head_sha"],
        "walkthrough_md": inp["walkthrough_md"],
        "owner": inp["owner"],
        "repo_name": inp["repo_name"],
        "pr_number": int(inp["pr_number"]),
        "run_id": uuid.UUID(inp["run_id"]),
        "review_id": uuid.UUID(inp["review_id"]),
        "changed_line_ranges": changed_line_ranges,
    }


async def _op_seed(sm: async_sessionmaker, op: dict[str, Any]) -> dict[str, Any]:
    """Seed the FK chain: pull_request_reviews[current_run_id] -> review_runs (current + a 2nd stale run)."""
    review_id = op["review_id"]
    current_run_id = op["current_run_id"]
    stale_run_id = op["stale_run_id"]
    repo_id = uuid.uuid4().int % 2_000_000_000
    pr_number = (uuid.uuid4().int % 9999) + 1
    async with sm() as s:
        async with s.begin():
            await s.execute(
                text(
                    "INSERT INTO core.pull_request_reviews "
                    "(review_id, provider, repo_id, pr_number, provider_pr_id, status, current_run_id) "
                    "VALUES (:rid, 'github', :repo, :prn, :ppr, 'open', NULL)"
                ),
                {"rid": review_id, "repo": repo_id, "prn": pr_number, "ppr": f"pr-{repo_id}-{pr_number}"},
            )
            await s.execute(
                text(
                    "INSERT INTO core.review_runs (run_id, review_id, trigger_type, lifecycle_state) "
                    "VALUES (:run, :rid, 'pr_opened', 'PENDING')"
                ),
                {"run": current_run_id, "rid": review_id},
            )
            await s.execute(
                text(
                    "INSERT INTO core.review_runs (run_id, review_id, trigger_type, lifecycle_state) "
                    "VALUES (:run, :rid, 'pr_synchronize', 'PENDING')"
                ),
                {"run": stale_run_id, "rid": review_id},
            )
            if not op.get("current_null"):
                await s.execute(
                    text(
                        "UPDATE core.pull_request_reviews SET current_run_id = :run WHERE review_id = :rid"
                    ),
                    {"run": current_run_id, "rid": review_id},
                )
    return {"id": op["id"], "ok": True}


async def _op_preseed(sm: async_sessionmaker, op: dict[str, Any]) -> dict[str, Any]:
    """Pre-insert a posted_reviews row (the LOST-claim winner). `age_seconds` shifts posted_at into the past."""
    pr_id = op["pr_id"]
    marker = f"<!-- codemaster:review-marker:{pr_id} -->"
    gid = op.get("github_review_id")
    outcome = op["publication_outcome"]
    age = int(op.get("age_seconds", 0))
    async with sm() as s:
        async with s.begin():
            await s.execute(
                text(
                    "INSERT INTO core.posted_reviews "
                    "(pr_id, marker, github_review_id, publication_outcome, posted_at) "
                    "VALUES (:pid, :marker, :gid, :outcome, now() - make_interval(secs => :age))"
                ),
                {"pid": pr_id, "marker": marker, "gid": gid, "outcome": outcome, "age": age},
            )
    return {"id": op["id"], "ok": True}


async def _op_read_row(sm: async_sessionmaker, op: dict[str, Any]) -> dict[str, Any]:
    async with sm() as s:
        res = await s.execute(
            text(
                "SELECT github_review_id, publication_outcome "
                "FROM core.posted_reviews WHERE pr_id = :pid"
            ),
            {"pid": op["pr_id"]},
        )
        row = res.first()
    if row is None:
        return {"id": op["id"], "ok": True, "row": None}
    gid = None if row[0] is None else int(row[0])
    return {"id": op["id"], "ok": True, "row": {"github_review_id": gid, "publication_outcome": row[1]}}


async def _op_cleanup(sm: async_sessionmaker, op: dict[str, Any]) -> dict[str, Any]:
    async with sm() as s:
        async with s.begin():
            await s.execute(
                text("DELETE FROM core.posted_reviews WHERE pr_id = :pid"), {"pid": op["pr_id"]}
            )
            await s.execute(
                text("DELETE FROM audit.workflow_events WHERE run_id = ANY(:runs)"),
                {"runs": op["run_ids"]},
            )
            await s.execute(
                text("UPDATE core.pull_request_reviews SET current_run_id = NULL WHERE review_id = :rid"),
                {"rid": op["review_id"]},
            )
            await s.execute(
                text("DELETE FROM core.review_runs WHERE run_id = ANY(:runs)"), {"runs": op["run_ids"]}
            )
            await s.execute(
                text("DELETE FROM core.pull_request_reviews WHERE review_id = :rid"),
                {"rid": op["review_id"]},
            )
    return {"id": op["id"], "ok": True}


async def _op_do_post(sm: async_sessionmaker, op: dict[str, Any]) -> dict[str, Any]:
    stub = StubGhClient(op.get("script", {}).get("createReview", []))
    kwargs = _build_kwargs(op["input"])
    in_flight_override = op.get("in_flight_window_seconds")
    if in_flight_override is not None:
        import os

        os.environ["CODEMASTER_POST_REVIEW_IN_FLIGHT_WINDOW_SECONDS"] = str(in_flight_override)
    result: PostedReviewV1 = await _do_post(gh_client=stub, session_factory=sm, **kwargs)
    return {
        "id": op["id"],
        "ok": True,
        "result": json.loads(result.model_dump_json()),
        "calls": stub.calls,
    }


_OPS = {
    "seed": _op_seed,
    "preseed": _op_preseed,
    "read_row": _op_read_row,
    "cleanup": _op_cleanup,
    "do_post": _op_do_post,
}


async def _main() -> None:
    engine = create_async_engine(DSN)
    sm = async_sessionmaker(engine, expire_on_commit=False)
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            op = json.loads(line)
            handler = _OPS.get(op["op"])
            try:
                if handler is None:
                    raise ValueError(f"unknown op {op['op']!r}")
                out = await handler(sm, op)
            except Exception as e:  # noqa: BLE001 — parity capture of raise + type
                out = {
                    "id": op.get("id"),
                    "ok": False,
                    "err_class": type(e).__name__,
                    "err": f"{type(e).__name__}: {e}"[:300],
                }
            sys.stdout.write(json.dumps(out, sort_keys=True) + "\n")
            sys.stdout.flush()
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(_main())
