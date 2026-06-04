"""consumer_search activity — Sprint 11 / S11.3.1.

Given a removed-or-changed public symbol, return up to 20
``ConsumerHitV1`` rows ordered by confidence (high → medium →
low) and then by stable secondary keys for determinism.

The activity is the bridge between the persistence layer
(S11.2.1's ``SymbolReferenceRepoPort``) and the review prompt
builder (S11.3.2). The prompt builder wraps the result inside a
``<knowledge trust="trusted">`` block so the LLM treats it as
authoritative cross-repo context.

Truncation: when raw results exceed ``max_hits``, the cap fires
and ``truncated=True`` is surfaced. The renderer (S11.3.2) lifts
the flag into a ``<!-- truncated -->`` marker.
"""

from __future__ import annotations

from typing import Final

from codemaster.symbols.references_port import SymbolReferenceRepoPort
from contracts.symbol_graph.v1 import (
    ConsumerHitV1,
    ReferenceConfidence,
    RemovedOrChangedSymbolV1,
    RetrievedConsumersV1,
    SymbolReferenceV1,
)


DEFAULT_MAX_HITS: Final = 20


# Locked confidence ranking — lower number = better.
_CONFIDENCE_RANK: Final[dict[ReferenceConfidence, int]] = {
    "high": 0,
    "medium": 1,
    "low": 2,
}


def _sort_key(ref: SymbolReferenceV1) -> tuple:
    """Order rows for deterministic display:
    1. confidence (high → medium → low)
    2. consumer_repo_id (stable)
    3. consumer_relative_path
    4. consumer_line
    5. kind (so import_match precedes call_shape_match for the
       same site)
    """
    return (
        _CONFIDENCE_RANK.get(ref.confidence, 99),
        str(ref.consumer_repo_id),
        ref.consumer_relative_path,
        ref.consumer_line,
        ref.kind,
    )


def _to_hit(ref: SymbolReferenceV1) -> ConsumerHitV1:
    return ConsumerHitV1(
        consumer_repo_id=ref.consumer_repo_id,
        consumer_relative_path=ref.consumer_relative_path,
        consumer_line=ref.consumer_line,
        confidence=ref.confidence,
        excerpt=ref.excerpt,
    )


def _build_retrieved(
    *,
    target: RemovedOrChangedSymbolV1,
    refs: tuple[SymbolReferenceV1, ...],
    max_hits: int,
) -> RetrievedConsumersV1:
    """Pure helper shared by per-target and batched flows."""
    refs_sorted = sorted(refs, key=_sort_key)
    best_per_site: dict[tuple, SymbolReferenceV1] = {}
    for r in refs_sorted:
        site = (r.consumer_repo_id, r.consumer_relative_path, r.consumer_line)
        existing = best_per_site.get(site)
        if existing is None:
            best_per_site[site] = r
            continue
        if _CONFIDENCE_RANK[r.confidence] < _CONFIDENCE_RANK[existing.confidence]:
            best_per_site[site] = r
    deduped = sorted(best_per_site.values(), key=_sort_key)
    truncated = len(deduped) > max_hits
    capped = deduped[:max_hits]
    return RetrievedConsumersV1(
        target=target,
        hits=tuple(_to_hit(r) for r in capped),
        truncated=truncated,
    )


async def batch_consumer_search(
    *,
    targets: tuple[RemovedOrChangedSymbolV1, ...],
    references_repo: SymbolReferenceRepoPort,
    max_hits: int = DEFAULT_MAX_HITS,
) -> tuple[RetrievedConsumersV1, ...]:
    """Batched variant for the per-PR multi-symbol path.

    Issues ONE call to ``references_repo.list_for_targets`` for all
    targets — production: a single SQL ``WHERE target_symbol_id =
    ANY(:ids)`` query — then groups the results in-process. Stops a
    200-symbol PR from degenerating into 200 round-trips (S11.T1).
    """
    if not targets:
        return ()
    target_ids = tuple(t.target_symbol_id for t in targets)
    grouped = await references_repo.list_for_targets(target_symbol_ids=target_ids)
    return tuple(
        _build_retrieved(
            target=t,
            refs=grouped.get(t.target_symbol_id, ()),
            max_hits=max_hits,
        )
        for t in targets
    )


async def consumer_search(
    *,
    target: RemovedOrChangedSymbolV1,
    references_repo: SymbolReferenceRepoPort,
    max_hits: int = DEFAULT_MAX_HITS,
) -> RetrievedConsumersV1:
    """Look up consumer-site references for one target and return
    the top ``max_hits`` ordered by confidence.

    Multiple references at the same ``(consumer_repo_id, path,
    line)`` (e.g., import_match + call_shape_match on the same
    site) are collapsed to a single best-confidence hit before
    the cap is applied — the prompt would otherwise burn slots
    on duplicates.

    Wrapped in the locked ``consumer_search`` OTel span so the
    per-target lookup latency is visible in Tempo without each
    caller emitting their own span.
    """
    from codemaster.observability.otel import span as _otel_span

    with _otel_span(
        "consumer_search",
        target_symbol_id=str(target.target_symbol_id),
        max_hits=max_hits,
    ):
        return await _consumer_search_impl(
            target=target,
            references_repo=references_repo,
            max_hits=max_hits,
        )


async def _consumer_search_impl(
    *,
    target: RemovedOrChangedSymbolV1,
    references_repo: SymbolReferenceRepoPort,
    max_hits: int,
) -> RetrievedConsumersV1:
    refs = await references_repo.list_for_target(target_symbol_id=target.target_symbol_id)
    refs_sorted = sorted(refs, key=_sort_key)

    # Collapse same-site duplicates: keep the best-confidence row
    # per (consumer_repo_id, relative_path, line).
    best_per_site: dict[tuple, SymbolReferenceV1] = {}
    for r in refs_sorted:
        site = (r.consumer_repo_id, r.consumer_relative_path, r.consumer_line)
        existing = best_per_site.get(site)
        if existing is None:
            best_per_site[site] = r
            continue
        if _CONFIDENCE_RANK[r.confidence] < _CONFIDENCE_RANK[existing.confidence]:
            best_per_site[site] = r

    deduped = sorted(best_per_site.values(), key=_sort_key)

    truncated = len(deduped) > max_hits
    capped = deduped[:max_hits]

    return RetrievedConsumersV1(
        target=target,
        hits=tuple(_to_hit(r) for r in capped),
        truncated=truncated,
    )
