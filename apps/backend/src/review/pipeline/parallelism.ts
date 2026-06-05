// Per-workflow chunk parallelism — 1:1 port of the frozen Python
// vendor/codemaster-py/codemaster/review/parallelism.py (Sprint 8 / S8.2.3).
//
// `fanOutReview` runs at most `concurrency` review-chunk dispatches at a time. The default
// CHUNK_CONCURRENCY_DEFAULT = 4 matches the Sprint-6 routing-policy slot; callers can override
// per-installation when policy widens.
//
// Return-shape (Python Phase B, 2026-05-16): the helper returns a 2-tuple
// `[findings, arbitrationIntents]` so the Tier-2 LLM's arbitration intents propagate up to the
// workflow body for Phase D's arbitration layer.
//
// GATE COLLAPSE (this is a NEW Temporal workflow type → no Python histories → every gate's TRUE
// branch is straight-line code). Two collapses are baked into this port:
//
//   1. `bedrock-review-chunk-envelope` (gates.ts COLLAPSED_GATES, disposition collapse-on): the
//      per-chunk callable ALWAYS returns the typed ReviewChunkResponseV1 envelope. The Python's
//      legacy `tuple[ReviewFindingV1, ...]` return path (the unpatched/in-flight-history branch)
//      is the dead/false branch and is NOT ported. `coerceChunkResult` therefore operates over the
//      envelope ONLY.
//
//   2. The Python's `_callable_accepts_kwarg` runtime `inspect.signature` introspection (the
//      `forward_tier1` / `forward_statuses` / `forward_manifest` dance) existed solely to keep
//      legacy test fakes — that only accept a bare `chunk` positional — call-compatible. In the TS
//      port the chunk callable has ONE fixed typed signature (`InvokeChunkFn`): the threading
//      payload (tier1Findings / toolStatuses / prTopologyManifest) is ALWAYS passed as the typed
//      second argument. There is no false branch to port, so the introspection is dropped.
//
// SANDBOX SAFETY (ADR-0065/0066): runs inside the Temporal V8 workflow sandbox. DETERMINISTIC +
// crypto/clock/network-FREE. NO Date.now / new Date() / Math.random / node:crypto / fetch / timers /
// DB. The ONLY await is the injected `invoke` port (a Temporal activity dispatch). The bounded
// limiter is a plain-Promise worker pool over a shared monotonic cursor: results are written to an
// index-keyed slot array and read back in INPUT order (not completion order), so fan-in is
// replay-deterministic regardless of which dispatch resolves first.

import type { DiffChunkV1 } from "#contracts/diff_chunking.v1.js";
import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import type { ToolStatusV1 } from "#contracts/tool_status.v1.js";
import type { PRTopologyEntryV1 } from "#contracts/pr_topology.v1.js";
import type { ReviewChunkResponseV1 } from "#contracts/review_chunk_response.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import type { ArbitrationIntentV1 } from "#contracts/arbitration_intent.v1.js";

/** Default per-PR chunk-review concurrency. Matches the Sprint-6 routing-policy slot
 *  (CHUNK_CONCURRENCY_DEFAULT in parallelism.py:43). */
export const CHUNK_CONCURRENCY_DEFAULT = 4;

/** Linter-aware per-chunk threading payload forwarded into every chunk dispatch.
 *
 *  Mirrors the Python `fan_out_review` kwargs that the workflow body's `_review_chunk` closure
 *  threads into the per-chunk `ReviewContextV1` envelope:
 *    - tier1Findings / toolStatuses (Phase B, 2026-05-16) — the static-analysis context.
 *    - prTopologyManifest (v8 R-5, 2026-05-23) — PR-level topology so the per-chunk LLM has
 *      PR-scope awareness (invariant 13).
 *
 *  Per gate collapse #2 above, this payload is ALWAYS passed (the Python's `_callable_accepts_kwarg`
 *  opt-in introspection is the dead legacy-fake branch and is not ported). */
export type ChunkThreadingV1 = {
  readonly tier1Findings: ReadonlyArray<AnalysisFindingV1>;
  readonly toolStatuses: ReadonlyArray<ToolStatusV1>;
  readonly prTopologyManifest: ReadonlyArray<PRTopologyEntryV1>;
};

/** The per-chunk dispatch callable. The workflow injects a closure that wraps the typed
 *  `reviewChunk` activity port (which always returns the ReviewChunkResponseV1 envelope — the
 *  `bedrock-review-chunk-envelope` collapse-on path). Unit tests inject a stub. */
export type InvokeChunkFn = (
  chunk: DiffChunkV1,
  threading: ChunkThreadingV1,
) => Promise<ReviewChunkResponseV1>;

/** The fan-in result: `[allFindings, allArbitrationIntents]`, both in chunk-input order. */
export type FanOutResult = readonly [
  ReadonlyArray<ReviewFindingV1>,
  ReadonlyArray<ArbitrationIntentV1>,
];

/** Per-chunk normalized result: `(findings, intents)`. */
type CoercedChunkResult = readonly [
  ReadonlyArray<ReviewFindingV1>,
  ReadonlyArray<ArbitrationIntentV1>,
];

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// coerceChunkResult (parallelism.py:51 `_coerce_chunk_result`)
//
// Normalize a chunk-review return to `[findings, intents]`. Per the `bedrock-review-chunk-envelope`
// collapse-on gate the input is ALWAYS the typed ReviewChunkResponseV1 envelope, so this is a minimal
// typed projection. The Python's legacy `tuple[ReviewFindingV1, ...]` branch (`return tuple(raw), ()`)
// is the dead/false branch and is not ported.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function coerceChunkResult(raw: ReviewChunkResponseV1): CoercedChunkResult {
  return [raw.findings, raw.arbitration_intents];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// fanOutReview (parallelism.py:81 `fan_out_review`)
//
// Invoke `invoke(chunk, threading)` for each chunk, at most `concurrency` concurrently. The findings
// and intents tuples preserve chunk-INPUT ordering (not completion ordering) — load-bearing for
// Temporal replay determinism. On the first dispatch rejecting, the rejection propagates and the
// fan-in result is discarded (the externally-observable "first error re-raised, success ordering
// preserved" contract of the Python task-group).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export async function fanOutReview(
  chunks: ReadonlyArray<DiffChunkV1>,
  invoke: InvokeChunkFn,
  options: {
    readonly concurrency?: number;
    readonly threading?: ChunkThreadingV1;
  } = {},
): Promise<FanOutResult> {
  const concurrency = options.concurrency ?? CHUNK_CONCURRENCY_DEFAULT;
  const threading: ChunkThreadingV1 = options.threading ?? {
    tier1Findings: [],
    toolStatuses: [],
    prTopologyManifest: [],
  };

  if (concurrency <= 0) {
    throw new Error("concurrency must be positive");
  }
  if (chunks.length === 0) {
    return [[], []];
  }

  // Index-keyed result slots — each dispatch writes its own slot, so the order is independent of
  // completion order (the replay-determinism guarantee). `undefined` is the not-yet-filled sentinel
  // (the Python `None` slot); on the success path every slot is filled before fan-in.
  const slots: Array<CoercedChunkResult | undefined> = new Array<CoercedChunkResult | undefined>(
    chunks.length,
  ).fill(undefined);

  // Bounded-concurrency worker pool: spawn min(concurrency, n) workers, each pulling the next chunk
  // index off a shared monotonic cursor until the input is exhausted. This caps in-flight dispatches
  // at `concurrency` (the Python `anyio.Semaphore(concurrency)` bound) using only Promises — NO
  // timers, NO clock, NO RNG (sandbox-safe).
  let cursor = 0;
  const next = (): number => {
    const idx = cursor;
    cursor += 1;
    return idx;
  };

  const worker = async (): Promise<void> => {
    for (let idx = next(); idx < chunks.length; idx = next()) {
      // eslint-disable-next-line security/detect-object-injection -- `idx` is a bounded numeric cursor into local arrays, not user input
      const raw = await invoke(chunks[idx]!, threading);
      // eslint-disable-next-line security/detect-object-injection -- `idx` is a bounded numeric cursor into a local array, not user input
      slots[idx] = coerceChunkResult(raw);
    }
  };

  const poolSize = Math.min(concurrency, chunks.length);
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < poolSize; w += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Fan-in in INPUT order. Slots are all filled on the success path; a rejected dispatch would have
  // propagated through Promise.all above before reaching here.
  const outFindings: Array<ReviewFindingV1> = [];
  const outIntents: Array<ArbitrationIntentV1> = [];
  for (const slot of slots) {
    // istanbul ignore next — defensive: unreachable on the success path (mirrors the Python asserts).
    if (slot === undefined) {
      throw new Error("fanOutReview: result slot unexpectedly empty after fan-in");
    }
    const [findings, intents] = slot;
    outFindings.push(...findings);
    outIntents.push(...intents);
  }
  return [outFindings, outIntents];
}
