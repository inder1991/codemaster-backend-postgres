/**
 * `dedupFindings` activity — dedupes linter-derived + LLM-derived findings in two stages:
 *
 *   combined      = linter_findings + llm_findings
 *   after_exact   = aggregateExact(combined)                 — PURE (no I/O)
 *   after_semantic, skipped = await aggregateSemantic(after_exact, embedder)   — EMBEDS over the network
 *
 * ## Why an ACTIVITY (the sandbox boundary — ADR-0065/0066)
 *
 * The semantic stage calls `embedder.embed(...)` — a NETWORK round-trip. The orchestrator + workflow body
 * run inside the Temporal V8 workflow sandbox, which is deterministic + network/crypto/clock-FREE
 * (ADR-0065/0066). A network call there is forbidden. Therefore the dedup MUST be a Temporal activity
 * that holds the live {@link EmbeddingsPort} and runs in the NORMAL Node activity runtime; the
 * orchestrator DISPATCHES it via the typed activity port. The live embedder is the holder's constructor
 * collaborator, never threaded into the workflow body.
 *
 * ## Fail-open behaviour
 *
 * Fail-open on embedder failure: the catch lives in the shared `aggregateSemantic` seam
 * (aggregation_semantic.ts), so an embedder outage degrades to exact-only dedup rather than failing the
 * activity. The `semantic_skipped` flag is surfaced on the {@link DedupedFindingsV1} envelope so the
 * workflow body can record the degradation outcome.
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047
 *
 * Single positional envelope: the two finding arrays are {@link DedupFindingsInputV1} fields; the embedder
 * is the holder's constructor collaborator (a live network client, never on the wire).
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Runs in the NORMAL Node activity runtime — NOT the workflow V8-isolate sandbox. The exact-dedup stage
 * is pure; the semantic stage performs the network embed. No clock, no random, no DB.
 *
 * ## Workflow-phase wiring boundary
 *
 * FOLLOW-UP-dedup-findings-orchestrator-wiring: the orchestrator (orchestrator.ts) is OWNED by the
 * Workflow phase and is NOT touched here. When that phase wires Step 6, it adds a `dedupFindings` typed
 * port to ReviewActivityPorts and dispatches this activity between fan-out (Step 5) and aggregate
 * (Step 7). This module exports the registered activity + its bound-method holder + the pure core only;
 * build_activities wires the holder.
 */

import { aggregateExact } from "#backend/review/aggregation.js";
import { aggregateSemantic } from "#backend/review/aggregation_semantic.js";

import type { EmbeddingsPort } from "#backend/adapters/embeddings_port.js";
import type { DedupFindingsInputV1, DedupedFindingsV1 } from "#contracts/dedup_findings.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

/**
 * The dedup core (early-return short-circuits + 2-stage dedup):
 *
 *   if linter.length === 0 && llm.length === 0      → return ([], false)
 *   if linter.length === 0                          → return (llm, false)
 *   if llm.length === 0                             → return (linter, false)
 *   combined         = linter + llm                 (linter FIRST — order matters for tie-breaks)
 *   afterExact       = aggregateExact(combined)
 *   afterSemantic, semanticSkipped = await aggregateSemantic(afterExact, embedder)
 *   return (afterSemantic, semanticSkipped)
 *
 * The COMBINED ORDER is significant: `aggregateExact` preserves first-occurrence ordering, so the linter
 * findings win title/severity ties (the linter's stable rule_id stays in the title — deterministic +
 * maintainer-friendly).
 *
 * Returns `[findings, semanticSkipped]` so the activity wrapper can surface the skip flag on the output
 * envelope. `semanticSkipped` is `false` on the three early-return short-circuits (nothing degraded),
 * and on the ≥2 path it is whatever `aggregateSemantic` reports (true iff the embedder failed / returned
 * a wrong vector count).
 *
 * We deliberately do NOT emit a stray console log here — the activity wrapper / workflow body owns
 * structured observability; a bare log would diverge from the platform's stage-outcome contract.
 *
 * Exported so the Tier-1 parity oracle can drive the same logic the activity runs. The `embedder` is
 * optional: a real {@link EmbeddingsPort} runs the cosine-merge; `undefined` takes the fail-open
 * no-embed path — how the parity oracle forces the deterministic path.
 */
export async function doDedupLinterWithLlm(
  linterFindings: ReadonlyArray<ReviewFindingV1>,
  llmFindings: ReadonlyArray<ReviewFindingV1>,
  embedder?: EmbeddingsPort,
): Promise<[Array<ReviewFindingV1>, boolean]> {
  if (linterFindings.length === 0 && llmFindings.length === 0) {
    return [[], false];
  }
  if (linterFindings.length === 0) {
    return [[...llmFindings], false];
  }
  if (llmFindings.length === 0) {
    return [[...linterFindings], false];
  }

  // Linter findings FIRST so they win first-occurrence tie-breaks in dedup.
  const combined = [...linterFindings, ...llmFindings];
  const afterExact = aggregateExact(combined);
  const [afterSemantic, semanticSkipped] = await aggregateSemantic(afterExact, embedder);
  return [afterSemantic, semanticSkipped];
}

/**
 * Bound-method holder for the `dedup_findings` activity. The worker composition root constructs it with
 * the resolved platform {@link EmbeddingsPort} and registers its `dedupFindings` bound method:
 *
 *     const dedup = new DedupFindingsActivity({ embedder: resolveEmbeddingsConsumer(...) });
 *     const activities = { ...others, dedupFindings: dedup.dedupFindings };
 *
 * `dedupFindings` is an arrow property so it stays bound when destructured into the activities map
 * (Temporal registers the function value directly, losing `this`).
 */
export class DedupFindingsActivity {
  private readonly embedder: EmbeddingsPort;

  public constructor({ embedder }: { embedder: EmbeddingsPort }) {
    this.embedder = embedder;
  }

  /**
   * The registered activity: dedupe `input.linter_findings` + `input.llm_findings` via the
   * exact-then-semantic chain (real embedder) and return the {@link DedupedFindingsV1} envelope.
   *
   * Fail-open: an embedder failure degrades to exact-only dedup (`semantic_skipped=true`) rather than
   * throwing — the semantic-aggregation step catches the embedder error.
   */
  public readonly dedupFindings = async (
    input: DedupFindingsInputV1,
  ): Promise<DedupedFindingsV1> => {
    const [findings, semanticSkipped] = await doDedupLinterWithLlm(
      input.linter_findings,
      input.llm_findings,
      this.embedder,
    );
    return {
      schema_version: input.schema_version,
      findings,
      semantic_skipped: semanticSkipped,
    };
  };
}
