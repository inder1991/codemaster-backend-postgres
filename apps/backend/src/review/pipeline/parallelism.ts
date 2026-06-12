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

// W1.9a (C2): the ONE cancellation predicate (degradation.ts) — the fail-soft slot must NEVER record
// a cancellation as a chunk failure (a lost-lease/supersede abort or a workflow cancel propagates).
// Sandbox-safe: degradation.ts is already part of the workflow bundle (no new runtime edges).
import { isCancellation } from "./degradation.js";

/**
 * Abort-class error NAMES that must PROPAGATE out of the fail-soft fan-out even when a failureSlot
 * is supplied (wave-1 adversarial-review fix). Name-matched (the CS4.3 posture) so this
 * workflow-bundle-safe module never imports runner code:
 *   * THROTTLE faults — the CS4.4/W1.9c layering parks the whole JOB attempt-free at the
 *     Retry-After/resetAt hint via the runner's deferRetry; recording a throttle as a chunk
 *     degradation would permanently lose the chunk and settle the review 'done'. MUST mirror
 *     runner/retry_hints.ts THROTTLE_ERROR_NAMES — pinned in lockstep by parallelism.test.ts.
 *   * TerminalCancelError — the de-Temporal shell's composed-abort fault (mutex loss / supersede /
 *     hard timeout); isCancellation also recognizes it, listed here for the lockstep pin.
 */
export const FANOUT_ABORT_CLASS_ERROR_NAMES: ReadonlySet<string> = new Set([
  "GitHubRateLimitExceeded",
  "LlmRateLimitError",
  "TerminalCancelError",
]);

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

/** W1.9a (C2): one failed chunk dispatch, as recorded by the failure-isolation slot. `error` is the
 *  verbatim rejection (the orchestrator re-raises it on the all-chunks-failed path so the typed
 *  retryable/non-retryable classification survives). */
export type ChunkDispatchFailure = {
  readonly chunkIndex: number;
  readonly chunkId: string;
  readonly path: string;
  readonly error: unknown;
};

/** W1.9a (C2): the caller-provided failure-isolation slot. When supplied, a rejecting dispatch is
 *  recorded here (in chunk-INPUT order — replay-deterministic regardless of completion order) and
 *  its peers COMPLETE instead of the legacy first-error-wins abort. Cancellation is NEVER recorded —
 *  it propagates (the degradation.ts isCancellation discipline). */
export type ChunkFailureSlot = {
  recordFailure(failure: ChunkDispatchFailure): void;
};

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
//
// FIX #11 — CANCEL-PEERS HARDENING DIVERGENCE (owner-requested; NOT a 1:1 port detail).
// ───────────────────────────────────────────────────────────────────────────────────────────────
// Python's `anyio.create_task_group()` CANCELS every peer task the instant one task raises — tasks
// still parked at `async with semaphore` (not yet inside `invoke`) are cancelled before they ever
// dispatch, so the task-group never schedules the not-yet-started chunks on a hard failure.
//
// The original worker-pool port did NOT reproduce that: `Promise.all` rejects when the first worker
// throws, but the OTHER in-flight workers keep pulling the shared cursor and dispatching `invoke`
// for later chunks (wasted LLM spend + larger Temporal history). JS has no task-cancellation
// primitive, so we model it cooperatively: a shared `aborted` boolean flag (set when ANY worker's
// `invoke()` rejects). Every worker checks the flag BEFORE pulling/dispatching its next chunk and
// stops as soon as it is set. This is the closest faithful analog of anyio's "cancel peers on first
// exception" — bounded to a check-before-the-next-dispatch (we cannot interrupt the one `invoke`
// already awaiting, exactly as anyio cannot un-issue an in-flight syscall).
//
// SANDBOX / REPLAY SAFETY: the abort flag is a plain boolean mutated by ordinary control flow — NO
// new clock/RNG/network/crypto and NO new non-determinism. The flag only suppresses *additional*
// dispatches on a path that was already going to throw, so the success path (and its deterministic
// slot-ordered fan-in) is byte-for-byte unchanged. The first rejection still propagates: each worker
// rethrows after setting the flag, so `Promise.all` surfaces the first-observed error verbatim.
//
// W1.9a (C2) — FAILURE-ISOLATION SLOT (fail-soft mode; owner-requested hardening DIVERGENCE from the
// frozen Python first-error-wins task-group).
// ───────────────────────────────────────────────────────────────────────────────────────────────
// With `options.failureSlot` supplied, a rejecting dispatch DEGRADES instead of aborting the fan-out:
// the failure is recorded into an index-keyed slot (mirroring the result-slot idiom) and the worker
// CONTINUES pulling chunks — peers are NOT cancelled, and the failed chunk simply contributes zero
// findings at fan-in. After the pool settles, the recorded failures are replayed onto the caller's
// slot in chunk-INPUT order (replay-deterministic regardless of completion order; the same
// determinism guarantee as the result fan-in). EXCEPTIONS THAT STILL ABORT: cancellation
// (isCancellation — Temporal CancelledFailure / the abort-shaped lost-lease supersede) is NEVER
// recorded as a chunk failure; it sets the abort flag and propagates verbatim, exactly as in the
// legacy mode. Without `failureSlot` the legacy first-error-wins contract above is unchanged.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export async function fanOutReview(
  chunks: ReadonlyArray<DiffChunkV1>,
  invoke: InvokeChunkFn,
  options: {
    readonly concurrency?: number;
    readonly threading?: ChunkThreadingV1;
    readonly failureSlot?: ChunkFailureSlot;
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

  // FIX #11: shared cooperative-cancellation flag (anyio task-group "cancel peers on first
  // exception" analog). Set when any worker's `invoke()` rejects; every worker checks it BEFORE
  // pulling/dispatching its next chunk and stops. Plain boolean → replay-safe, no non-determinism.
  let aborted = false;

  // W1.9a (C2): index-keyed failure slots (fail-soft mode only). A failed dispatch records here and
  // peers continue; the recorded failures are replayed onto options.failureSlot in INPUT order after
  // the pool settles. Plain data writes → replay-safe, no new non-determinism.
  const failureSlots: Array<ChunkDispatchFailure | undefined> = new Array<
    ChunkDispatchFailure | undefined
  >(chunks.length).fill(undefined);

  const worker = async (): Promise<void> => {
    for (let idx = next(); idx < chunks.length; idx = next()) {
      // Stop scheduling the moment a peer has failed — do NOT pull/dispatch this (or any further)
      // chunk. Mirrors anyio cancelling tasks still parked at `async with semaphore`.
      if (aborted) {
        return;
      }
      try {
        // eslint-disable-next-line security/detect-object-injection -- `idx` is a bounded numeric cursor into local arrays, not user input
        const raw = await invoke(chunks[idx]!, threading);
        // eslint-disable-next-line security/detect-object-injection -- `idx` is a bounded numeric cursor into a local array, not user input
        slots[idx] = coerceChunkResult(raw);
      } catch (err) {
        // Cancellation ALWAYS aborts the fan-out (never a degradation record): signal peers to stop,
        // then re-raise verbatim. Without a failureSlot every failure takes this path — the legacy
        // first-error-wins contract (the first-observed error propagates through `Promise.all`).
        if (
          options.failureSlot === undefined ||
          isCancellation(err) ||
          (err instanceof Error && FANOUT_ABORT_CLASS_ERROR_NAMES.has(err.name))
        ) {
          aborted = true;
          throw err;
        }
        // W1.9a (C2) fail-soft: record the failure into its index-keyed slot and CONTINUE — peers
        // are not cancelled; this chunk contributes zero findings at fan-in. (The per-chunk
        // stageOutcome in the orchestrator already logged the CS8 WARN + record_stage(error) before
        // re-raising into this catch.)
        // eslint-disable-next-line security/detect-object-injection -- `idx` is a bounded numeric cursor into a local array, not user input
        recordFailureSlot(failureSlots, idx, chunks[idx]!, err);
      }
    }
  };

  const poolSize = Math.min(concurrency, chunks.length);
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < poolSize; w += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // W1.9a (C2): replay the recorded failures onto the caller's slot in chunk-INPUT order — the
  // replay-deterministic order (completion order is not deterministic across replays).
  if (options.failureSlot !== undefined) {
    for (const failure of failureSlots) {
      if (failure !== undefined) {
        options.failureSlot.recordFailure(failure);
      }
    }
  }

  // Fan-in in INPUT order. Slots are all filled on the success path; a rejected dispatch would have
  // propagated through Promise.all above before reaching here — except in fail-soft mode, where a
  // recorded-failure index legitimately holds no result (the chunk contributes zero findings).
  const outFindings: Array<ReviewFindingV1> = [];
  const outIntents: Array<ArbitrationIntentV1> = [];
  for (let idx = 0; idx < slots.length; idx += 1) {
    // eslint-disable-next-line security/detect-object-injection -- `idx` is a bounded numeric cursor into local arrays, not user input
    const slot = slots[idx];
    if (slot === undefined) {
      // eslint-disable-next-line security/detect-object-injection -- `idx` is a bounded numeric cursor into a local array, not user input
      if (failureSlots[idx] !== undefined) {
        continue; // fail-soft: the failed chunk contributes zero findings + zero intents.
      }
      // istanbul ignore next — defensive: unreachable on the success path (mirrors the Python asserts).
      throw new Error("fanOutReview: result slot unexpectedly empty after fan-in");
    }
    const [findings, intents] = slot;
    outFindings.push(...findings);
    outIntents.push(...intents);
  }
  return [outFindings, outIntents];
}

/** W1.9a (C2): record one failed dispatch into its index-keyed slot (fail-soft mode). Factored out
 *  so the worker's catch routes through a named record* call — the degradation IS recorded here (the
 *  silent-degradation gate's rule-3 record discipline), then surfaced by the orchestrator as the
 *  "N of M chunks failed review" note after fan-in. */
function recordFailureSlot(
  failureSlots: Array<ChunkDispatchFailure | undefined>,
  idx: number,
  chunk: DiffChunkV1,
  error: unknown,
): void {
  // eslint-disable-next-line security/detect-object-injection -- `idx` is a bounded numeric cursor into a local array, not user input
  failureSlots[idx] = {
    chunkIndex: idx,
    chunkId: chunk.chunk_id,
    path: chunk.path,
    error,
  };
}
