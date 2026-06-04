// Unit test for the review-response parser primitive parseToolUse + ReviewFindingParseError
// (apps/backend/src/backend/review/tool_schema.ts). The byte-for-byte (blocks → findings/intents)
// behavior is proven against the frozen Python in test/parity/review_parser.parity.test.ts (which drives
// the higher-level _parse_with_skip_malformed that wraps parseToolUse); THIS file pins the
// parseToolUse-level contract directly: the malformed-detection TRIGGERS (which raise vs which silently
// skip) + the block-routing policy (non-tool-use / unknown-name ignored).
import { describe, expect, it } from "vitest";

import { parseToolUse, ReviewFindingParseError } from "#backend/review/tool_schema.js";

/** Build one well-formed `report_finding` tool_use block dict. */
function findingBlock(input: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "tool_use",
    id: "x",
    name: "report_finding",
    input: {
      file: "a.py",
      start_line: 1,
      end_line: 1,
      severity: "issue",
      category: "bug",
      title: "t",
      body: "b",
      confidence: 0.9,
      ...input,
    },
  };
}

describe("parseToolUse — block routing", () => {
  it("non-tool_use blocks (text / image) are ignored", () => {
    const [findings, intents] = parseToolUse([
      { type: "text", text: "hello" },
      { type: "image", source: {} },
    ]);
    expect(findings).toHaveLength(0);
    expect(intents).toHaveLength(0);
  });

  it("tool_use blocks with an UNKNOWN name are ignored (forward-compat)", () => {
    const [findings, intents] = parseToolUse([
      { type: "tool_use", id: "u1", name: "some_future_tool", input: { x: 1 } },
    ]);
    expect(findings).toHaveLength(0);
    expect(intents).toHaveLength(0);
  });

  it("a well-formed report_finding block parses to one ReviewFindingV1 with contract defaults", () => {
    const [findings] = parseToolUse([findingBlock({ title: "ok" })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toBe("ok");
    expect(findings[0]!.scope).toBe("chunk_observed");
    expect(findings[0]!.sources).toEqual([]);
    expect(findings[0]!.evidence_refs).toEqual([]);
  });

  it("a well-formed report_arbitration_intent block parses to one ArbitrationIntentV1", () => {
    const [findings, intents] = parseToolUse([
      {
        type: "tool_use",
        id: "a1",
        name: "report_arbitration_intent",
        input: {
          target_finding_id: "00000000-0000-4000-8000-000000000000",
          action: "SUPPRESS",
          confidence: "0.9",
          reason: "false positive",
        },
      },
    ]);
    expect(findings).toHaveLength(0);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.confidence).toBe("0.9");
  });
});

describe("parseToolUse — report_finding malformed TRIGGERS (raise ReviewFindingParseError)", () => {
  it("missing input → raises, carrying the block id + an input-missing reason", () => {
    let err: unknown;
    try {
      parseToolUse([{ type: "tool_use", id: "no-input", name: "report_finding" }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReviewFindingParseError);
    const e = err as ReviewFindingParseError;
    expect(e.blockId).toBe("no-input");
    expect(e.reason).toBe("tool_use.input is missing or not an object");
    expect(e.message).toBe("block no-input: tool_use.input is missing or not an object");
  });

  it("non-object input (array) → raises with the input-missing reason", () => {
    expect(() =>
      parseToolUse([{ type: "tool_use", id: "arr", name: "report_finding", input: [] }]),
    ).toThrow(ReviewFindingParseError);
  });

  it("contract validation failure (missing required fields) → raises with the parse-error reason", () => {
    let err: unknown;
    try {
      parseToolUse([{ type: "tool_use", id: "bad", name: "report_finding", input: { file: "a.py" } }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReviewFindingParseError);
    const e = err as ReviewFindingParseError;
    expect(e.blockId).toBe("bad");
    expect(e.reason.length).toBeGreaterThan(0);
  });

  it("missing id falls back to the <no-id> sentinel in the raised error", () => {
    let err: unknown;
    try {
      parseToolUse([{ type: "tool_use", name: "report_finding" }]);
    } catch (e) {
      err = e;
    }
    expect((err as ReviewFindingParseError).blockId).toBe("<no-id>");
  });
});

describe("parseToolUse — report_arbitration_intent malformed is SILENTLY skipped (defensive Form-B posture)", () => {
  it("missing input → skipped (no raise, no intent)", () => {
    const [findings, intents] = parseToolUse([
      { type: "tool_use", id: "a-no-input", name: "report_arbitration_intent" },
    ]);
    expect(findings).toHaveLength(0);
    expect(intents).toHaveLength(0);
  });

  it("contract validation failure → skipped + onArbitrationSkip hook fires with structured fields", () => {
    const skips: Array<{ readonly blockId: string; readonly errorClass: string; readonly errorMsg: string }> = [];
    const [, intents] = parseToolUse(
      [
        {
          type: "tool_use",
          id: "a-bad",
          name: "report_arbitration_intent",
          input: { target_finding_id: "not-a-uuid", action: "SUPPRESS", confidence: "0.9", reason: "r" },
        },
      ],
      { onArbitrationSkip: (info) => skips.push(info) },
    );
    expect(intents).toHaveLength(0);
    expect(skips).toHaveLength(1);
    expect(skips[0]!.blockId).toBe("a-bad");
    expect(skips[0]!.errorMsg.length).toBeGreaterThan(0);
  });
});
