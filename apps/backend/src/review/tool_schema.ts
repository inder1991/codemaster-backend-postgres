// `parseToolUse` + ReviewFindingParseError — the parser for Anthropic `tool_use` response blocks.
// The JSON-schema constants + tool NAMES live in #backend/llm/review_prompt.js (imported here, not
// redefined).
//
// The parser turns `tool_use` blocks into typed envelopes — `ReviewFindingV1` (Form A,
// `report_finding`) and `ArbitrationIntentV1` (Form B, `report_arbitration_intent`). It is the
// deterministic inv-14/15 enforcement seam's first stage: blocks → (findings, intents). PURE — no
// clock, no random, no DB, no I/O.
//
// Parser policy:
//   * Non-`tool_use` blocks (text / images / etc.) are ignored.
//   * `tool_use` blocks with an UNKNOWN `name` are ignored (forward-compat — future tools can ship
//     without breaking the parser).
//   * Malformed `report_finding` blocks RAISE {@link ReviewFindingParseError} carrying the offending
//     block's `id`. The caller (chunk_response_parser.ts::parseWithSkipMalformed) catches per-block,
//     logs, and skips the one bad block — keeping the rest.
//   * Malformed `report_arbitration_intent` blocks are SILENTLY skipped (defensive posture for the new
//     Form-B channel — LLM drift on the new tool must not take down the pipeline). A structured WARN
//     is logged so operators can detect emission drift.
//
// MALFORMED-detection triggers for `report_finding`:
//   1. `input` is missing or NOT a plain object → raise (reason "tool_use.input is missing or not an
//      object").
//   2. coercion + contract validation failure (Zod parse throws) → raise (reason = the parse error
//      message).
// Coercion goes through #backend/llm/contract_coercion.js::coerceForContract (string-length coercion
// before contract validation).

import { coerceForContract } from "#backend/llm/contract_coercion.js";
import { ARBITRATION_INTENT_TOOL_NAME, REVIEW_TOOL_NAME } from "#backend/llm/review_prompt.js";

import { ArbitrationIntentV1 } from "#contracts/arbitration_intent.v1.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

/**
 * Raised when a `report_finding` tool block cannot be validated. Carries the originating `blockId` so
 * the caller can log a precise marker without retaining the payload itself. `name` is set for
 * instanceof-free discrimination; message format: `"block {blockId}: {reason}"`.
 */
export class ReviewFindingParseError extends Error {
  public readonly blockId: string;
  public readonly reason: string;

  public constructor(args: { readonly blockId: string; readonly reason: string }) {
    super(`block ${args.blockId}: ${args.reason}`);
    this.name = "ReviewFindingParseError";
    this.blockId = args.blockId;
    this.reason = args.reason;
  }
}

/** True iff `value` is a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse Anthropic tool-use response blocks into `[findings, intents]`, routing by `name`:
 *   * `report_finding`            → {@link ReviewFindingV1}   (Form A)
 *   * `report_arbitration_intent` → {@link ArbitrationIntentV1} (Form B)
 *
 * Non-tool-use blocks and tool-use blocks with unknown names are silently ignored. Per-block
 * malformed-skip semantics differ by type: `report_finding` RAISES {@link ReviewFindingParseError} (the
 * caller catches + skips); `report_arbitration_intent` silently skips (defensive Form-B posture). Returns
 * a `[ReviewFindingV1[], ArbitrationIntentV1[]]` tuple.
 *
 * `onArbitrationSkip` is an OPTIONAL hook invoked once per silently-skipped malformed arbitration block
 * (default: no-op). It carries the structured fields a warning log would emit, so the caller can wire
 * logging without this pure parser reaching for a logger seam.
 */
export function parseToolUse(
  blocks: ReadonlyArray<Record<string, unknown>>,
  options: {
    readonly onArbitrationSkip?:
      | ((info: { readonly blockId: string; readonly errorClass: string; readonly errorMsg: string }) => void)
      | undefined;
  } = {},
): [Array<ReviewFindingV1>, Array<ArbitrationIntentV1>] {
  const onArbitrationSkip = options.onArbitrationSkip;
  const findings: Array<ReviewFindingV1> = [];
  const intents: Array<ArbitrationIntentV1> = [];

  for (const block of blocks) {
    // Non-object blocks are skipped.
    if (!isPlainObject(block)) {
      continue;
    }
    if (block["type"] !== "tool_use") {
      continue;
    }
    const name = block["name"];
    const rawId = block["id"];
    const blockId = rawId === undefined ? "<no-id>" : String(rawId);
    const payload = block["input"];

    if (name === REVIEW_TOOL_NAME) {
      // Trigger 1: missing / non-object input → raise.
      if (!isPlainObject(payload)) {
        throw new ReviewFindingParseError({
          blockId,
          reason: "tool_use.input is missing or not an object",
        });
      }
      // Trigger 2: coercion + contract validation failure → raise with the parse error message.
      try {
        const coerced = coerceForContract(payload, ReviewFindingV1, { blockId });
        findings.push(ReviewFindingV1.parse(coerced));
      } catch (e) {
        throw new ReviewFindingParseError({ blockId, reason: e instanceof Error ? e.message : String(e) });
      }
    } else if (name === ARBITRATION_INTENT_TOOL_NAME) {
      // Defensive skip on the new Form-B channel — LLM drift here must not take down the pipeline.
      if (!isPlainObject(payload)) {
        continue;
      }
      try {
        const coercedIntent = coerceForContract(payload, ArbitrationIntentV1, { blockId });
        intents.push(ArbitrationIntentV1.parse(coercedIntent));
      } catch (exc) {
        // Defensive skip on malformed intent — surface a structured WARN so operators can detect LLM
        // emission drift (e.g. confidence > 3 decimal places, action casing). Emission is delegated
        // to the optional hook to keep the parser pure.
        onArbitrationSkip?.({
          blockId,
          errorClass: exc instanceof Error ? exc.name : "Error",
          errorMsg: (exc instanceof Error ? exc.message : String(exc)).slice(0, 512),
        });
        continue;
      }
    }
    // else: unknown tool name → silently skip (forward-compat).
  }

  return [findings, intents];
}
