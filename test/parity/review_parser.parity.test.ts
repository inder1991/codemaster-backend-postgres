import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { load as yamlLoad } from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "./canonical.js";
import { pyParse, shutdownReviewParserRef, type BlockInput, type ParsedDicts } from "./review_parser_oracle.js";
import { parseWithSkipMalformed } from "#backend/review/chunk_response_parser.js";
import type { ArbitrationIntentV1 } from "#contracts/arbitration_intent.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

afterAll(() => {
  shutdownReviewParserRef();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tier-1 parity: prove the TS `parseWithSkipMalformed` (per-block skip-malformed loop → inv-14 scope
// drop → inv-15 evidence-refs subset enforcement) is byte-equal to the frozen Python
// `_parse_with_skip_malformed` (vendor/codemaster-py/codemaster/review/activities.py), driven over the
// dedicated ref (tools/parity/run_review_parser_ref.py).
//
// Block inputs come from the real `response.content` of the frozen review_chunk cassettes
// (clean / five_findings / fifty_findings / malformed_block) AS WELL AS constructed cases that exercise
// the scope-authority drop + the three `allowedEvidenceIds` modes (null / empty-set / subset).
//
// A finding's `confidence` is a bare Python float that cannot byte-round-trip through the canonicalizer
// (1.0 vs "1"); it is STRIPPED from the canonical compare on both sides and asserted STRUCTURALLY — the
// established bare-float handling. An arbitration intent's `confidence` is a Pydantic Decimal serialized
// as a STRING ("0.9"), so it survives the canonical compare verbatim (no strip needed).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url)); // <repo>/test/parity
const CASSETTE_DIR = join(HERE, "..", "..", "vendor", "codemaster-py", "tests", "cassettes", "bedrock", "review_chunk");

/** Load the `response.content` blocks list out of a frozen review_chunk cassette YAML. */
function cassetteBlocks(name: string): Array<BlockInput> {
  const doc = yamlLoad(readFileSync(join(CASSETTE_DIR, `${name}.yaml`), "utf8")) as {
    readonly response?: { readonly content?: ReadonlyArray<BlockInput> };
  };
  return [...(doc.response?.content ?? [])];
}

/** Build one well-formed `report_finding` tool_use block dict. */
function findingBlock(id: string, input: Record<string, unknown>): BlockInput {
  return {
    type: "tool_use",
    id,
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

/** Deep-clone a value with every `confidence` key removed (the bare-float strip for findings only). */
function stripFindingConfidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripFindingConfidence);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "confidence") continue;
      out[k] = stripFindingConfidence(v);
    }
    return out;
  }
  return value;
}

/** Serialize a TS parser result into the same `{findings, intents}` model_dump shape the Python emits. */
function tsToDicts(result: {
  readonly findings: ReadonlyArray<ReviewFindingV1>;
  readonly intents: ReadonlyArray<ArbitrationIntentV1>;
}): ParsedDicts {
  return {
    findings: result.findings.map((f) => ({ ...f })),
    intents: result.intents.map((i) => ({ ...i })),
  };
}

/** The confidence floats of each FINDING, in order — the structural assertion the canonical strip omits. */
function findingConfidences(dicts: ParsedDicts): Array<number> {
  return dicts.findings.map((x) => x["confidence"] as number);
}

/**
 * Run the SAME blocks + allowedEvidenceIds through the TS parser and the frozen Python, and assert
 * byte-equality of the whole `{findings, intents}` result. Finding `confidence` is stripped from the
 * canonical diff and asserted structurally; intent `confidence` (Decimal-string) survives the canonical
 * compare. Returns the Python dicts so a caller can make extra structural assertions.
 */
async function assertParity(
  blocks: ReadonlyArray<BlockInput>,
  allowedEvidenceIds: ReadonlyArray<string> | null,
): Promise<ParsedDicts> {
  const allowedSet = allowedEvidenceIds === null ? null : new Set(allowedEvidenceIds);
  const ts = tsToDicts(parseWithSkipMalformed(blocks, { allowedEvidenceIds: allowedSet }));
  const py = await pyParse(blocks, allowedEvidenceIds);

  // Byte-equal result (finding confidence stripped). canonicalize key-sorts recursively + normalizes.
  expect(canonicalize(stripFindingConfidence(ts))).toBe(canonicalize(stripFindingConfidence(py)));
  // Finding confidence floats match structurally, in order.
  expect(findingConfidences(ts)).toEqual(findingConfidences(py));
  return py;
}

describe("review-response parser _parse_with_skip_malformed parity (Pydantic ↔ TS)", () => {
  it("clean cassette — text-only block → 0 findings, 0 intents", async () => {
    const py = await assertParity(cassetteBlocks("clean"), null);
    expect(py.findings).toHaveLength(0);
    expect(py.intents).toHaveLength(0);
  }, 30_000);

  it("five_findings cassette — 5 report_finding blocks (+ a text block) → 5 findings", async () => {
    const py = await assertParity(cassetteBlocks("five_findings"), null);
    expect(py.findings).toHaveLength(5);
    expect(py.findings.map((x) => x["title"])).toEqual([
      "off-by-one",
      "extract helper",
      "missing docstring",
      "SQL injection",
      "N+1 query",
    ]);
  }, 30_000);

  it("fifty_findings cassette — 50 report_finding blocks → 50 findings", async () => {
    const py = await assertParity(cassetteBlocks("fifty_findings"), null);
    expect(py.findings).toHaveLength(50);
  }, 30_000);

  it("malformed_block cassette — bad block SKIPPED, the 2 good ones kept", async () => {
    const py = await assertParity(cassetteBlocks("malformed_block"), null);
    expect(py.findings).toHaveLength(2);
    expect(py.findings.map((x) => x["title"])).toEqual(["good-1", "good-2"]);
  }, 30_000);

  it("scope drop — cross_chunk + pr_global findings DROPPED (activity is chunk-scoped)", async () => {
    const blocks = [
      findingBlock("t1", { title: "keep", scope: "chunk_observed" }),
      findingBlock("t2", { title: "drop-cc", start_line: 2, end_line: 2, scope: "cross_chunk" }),
      findingBlock("t3", { title: "drop-pg", start_line: 3, end_line: 3, scope: "pr_global" }),
    ];
    const py = await assertParity(blocks, null);
    expect(py.findings).toHaveLength(1);
    expect(py.findings[0]!["title"]).toBe("keep");
  }, 30_000);

  it("evidence null — validation disabled; non-empty refs kept untouched", async () => {
    const blocks = [findingBlock("t1", { evidence_refs: ["ev_0123456789abcdef"] })];
    const py = await assertParity(blocks, null);
    expect(py.findings).toHaveLength(1);
    expect(py.findings[0]!["evidence_refs"]).toEqual(["ev_0123456789abcdef"]);
  }, 30_000);

  it("evidence empty-set — any non-empty refs DROPPED (frozenset() forbids all)", async () => {
    const blocks = [findingBlock("t1", { evidence_refs: ["ev_0123456789abcdef"] })];
    const py = await assertParity(blocks, []);
    expect(py.findings).toHaveLength(0);
  }, 30_000);

  it("evidence empty-set — a finding with EMPTY refs passes (SHOULD-not-MUST)", async () => {
    const blocks = [findingBlock("t1", { evidence_refs: [] })];
    const py = await assertParity(blocks, []);
    expect(py.findings).toHaveLength(1);
  }, 30_000);

  it("evidence subset — refs ⊆ allowed → kept", async () => {
    const blocks = [findingBlock("t1", { evidence_refs: ["ev_0123456789abcdef"] })];
    const py = await assertParity(blocks, ["ev_0123456789abcdef", "ev_fedcba9876543210"]);
    expect(py.findings).toHaveLength(1);
    expect(py.findings[0]!["evidence_refs"]).toEqual(["ev_0123456789abcdef"]);
  }, 30_000);

  it("evidence subset — a ref NOT in allowed → DROPPED", async () => {
    const blocks = [findingBlock("t1", { evidence_refs: ["ev_aaaaaaaaaaaaaaaa"] })];
    const py = await assertParity(blocks, ["ev_0123456789abcdef"]);
    expect(py.findings).toHaveLength(0);
  }, 30_000);

  it("evidence subset — partial overlap (one in, one out) → DROPPED (subset is all-or-nothing)", async () => {
    const blocks = [
      findingBlock("t1", { evidence_refs: ["ev_0123456789abcdef", "ev_aaaaaaaaaaaaaaaa"] }),
    ];
    const py = await assertParity(blocks, ["ev_0123456789abcdef"]);
    expect(py.findings).toHaveLength(0);
  }, 30_000);

  // NOTE on arbitration `confidence`: the LLM tool schema declares `confidence: {"type": "number"}`, so
  // the WIRE carries a JSON number. The frozen Python `ArbitrationIntentV1` is a LAX Pydantic `Decimal`
  // that COERCES a float `0.9` → `Decimal('0.9')` and keeps the intent. The TS `ArbitrationIntentV1`
  // contract now coerces the numeric wire form identically (libs/contracts/src/arbitration_intent.v1.ts),
  // so the parser keeps the intent on BOTH sides — see the numeric-confidence parity case below. This
  // string case proves the round-tripped Decimal-STRING form (which both contracts also accept) routes
  // identically; both string and numeric inputs are now byte-equal across Python ↔ TS.
  it("arbitration intent — a report_arbitration_intent block → 1 intent (Decimal-string confidence)", async () => {
    const blocks: Array<BlockInput> = [
      {
        type: "tool_use",
        id: "a1",
        name: "report_arbitration_intent",
        input: {
          target_finding_id: "00000000-0000-4000-8000-000000000000",
          action: "SUPPRESS",
          confidence: "0.9",
          reason: "false positive on this PR",
        },
      },
    ];
    const py = await assertParity(blocks, null);
    expect(py.findings).toHaveLength(0);
    expect(py.intents).toHaveLength(1);
    // Decimal serializes to the string form — survives the canonical compare verbatim.
    expect(py.intents[0]!["confidence"]).toBe("0.9");
  }, 30_000);

  it("mixed — findings + a malformed block + an intent + a scope-drop in ONE response", async () => {
    const blocks: Array<BlockInput> = [
      findingBlock("t1", { title: "keep" }),
      findingBlock("t2-bad", { file: undefined }), // strip required field → malformed → skipped
      findingBlock("t3", { title: "drop-cc", start_line: 2, end_line: 2, scope: "cross_chunk" }),
      {
        type: "tool_use",
        id: "a1",
        name: "report_arbitration_intent",
        input: {
          target_finding_id: "11111111-1111-4111-8111-111111111111",
          action: "SUPPRESS",
          confidence: "0.95",
          reason: "tier-1 false positive",
        },
      },
    ];
    // Strip the undefined `file` so the JSON block has no `file` key at all (true malformed shape).
    const t2 = blocks[1]!["input"] as Record<string, unknown>;
    delete t2["file"];

    const py = await assertParity(blocks, null);
    expect(py.findings).toHaveLength(1);
    expect(py.findings[0]!["title"]).toBe("keep");
    expect(py.intents).toHaveLength(1);
  }, 30_000);

  // Numeric confidence is the REALISTIC LLM wire form (tool schema declares `{"type": "number"}`).
  // The contract fix in arbitration_intent.v1.ts coerces the number → canonical decimal string exactly
  // as Python's lax Pydantic Decimal does, so the parser now KEEPS the intent on both sides and the
  // serialized confidence is byte-equal ("0.9"). (This case was previously a pinned KNOWN-DIVERGENCE
  // before the contract was fixed.)
  it("arbitration intent — numeric confidence (the realistic wire form) → 1 intent, byte-equal Python ↔ TS", async () => {
    const numericBlock: Array<BlockInput> = [
      {
        type: "tool_use",
        id: "a1",
        name: "report_arbitration_intent",
        input: {
          target_finding_id: "00000000-0000-4000-8000-000000000000",
          action: "SUPPRESS",
          confidence: 0.9, // JS number — what the LLM tool schema (`type: number`) actually emits
          reason: "false positive",
        },
      },
    ];
    const py = await assertParity(numericBlock, null);
    expect(py.findings).toHaveLength(0);
    expect(py.intents).toHaveLength(1);
    // Both sides coerce the numeric wire form to the canonical Decimal string.
    expect(py.intents[0]!["confidence"]).toBe("0.9");
  }, 30_000);
});
