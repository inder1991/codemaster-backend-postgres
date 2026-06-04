// OutputSafetyValidator — 1:1 port of codemaster/security/output_safety.py.
//
// Validates LLM-emitted comments before they leave the model client. Five checks (all always run, so
// the decision carries every fired reason): length, privileged-tag, secret (delegates to the ported
// detectSecrets), tool-call shape, and internal_claim_uncited (validate_finding only). The validator
// does NOT modify text — it returns a go/no-go OutputSafetyDecisionV1 and the caller decides.

import { type SecretFindingV1 } from "#contracts/secret_detection.v1.js";
import {
  type OutputSafetyDecisionV1 as OutputSafetyDecision,
  type OutputSafetyReason,
} from "#contracts/output_safety.v1.js";

import { detectSecrets } from "../redact/secret_detector.js";

/** 64 KiB-ish cap (GitHub's single-comment hard limit is 65536; headroom for wrapper formatting). */
export const MAX_OUTPUT_CHARS = 60_000;

/** Tag fragments the model is forbidden from emitting (case-insensitive substring match). */
const FORBIDDEN_TAG_FRAGMENTS: ReadonlyArray<string> = [
  '<diff trust="trusted"',
  "<system>",
  "<knowledge trust=",
  "<instructions",
  "<trusted",
  "<untrusted",
];

// Tool-call shapes the model is forbidden from emitting. The pattern SOURCE strings are kept verbatim
// from the Python `re.compile(...)` args so both the match AND the `detail` diagnostic (which embeds
// Python's `pattern.pattern` repr) are byte-identical. JS `\s`/`\b` differ from Python only on exotic
// unicode whitespace / word boundaries, which do not occur around these ASCII JSON tokens.
const FORBIDDEN_TOOL_CALL_PATTERN_SOURCES: ReadonlyArray<string> = [
  "<tool_use\\b",
  '"type"\\s*:\\s*"tool_use"',
  '"type"\\s*:\\s*"tool_call"',
  "\\bfunction_call\\s*:\\s*\\{",
  '"function_call"\\s*:\\s*\\{',
  '"name"\\s*:\\s*"[^"]+"\\s*,\\s*"arguments"\\s*:\\s*\\{',
];
const FORBIDDEN_TOOL_CALL_PATTERNS: ReadonlyArray<RegExp> = FORBIDDEN_TOOL_CALL_PATTERN_SOURCES.map(
  (source) => new RegExp(source, "i"),
);

/** High-signal phrases that mark a body as asserting team practice (S10.1.4). Tight to avoid FPs. */
const INTERNAL_CLAIM_PHRASES: ReadonlyArray<string> = [
  "team practice",
  "team standard",
  "team convention",
  "our convention",
  "our standard",
  "our team",
  "we use",
  "we prefer",
  "we follow",
  "we always",
  "we never",
  "this codebase prefers",
];

/** Python `repr()` for our ASCII fragment/pattern strings: single-quoted, `\`→`\\`, `'`→`\'`, `"` kept. */
function pyRepr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Python list-of-str repr: `['a', 'b']`. */
function pyReprList(values: ReadonlyArray<string>): string {
  return `[${values.map(pyRepr).join(", ")}]`;
}

/** Case-insensitive substring match against the locked phrase set. Mirrors `_has_internal_claim`. */
function hasInternalClaim(body: string): boolean {
  const lowered = body.toLowerCase();
  return INTERNAL_CLAIM_PHRASES.some((phrase) => lowered.includes(phrase));
}

/** The subset of ReviewFindingV1 that validate_finding reads. */
type FindingLike = {
  readonly title: string;
  readonly body: string;
  readonly suggestion?: string | null;
  readonly sources: ReadonlyArray<unknown>;
};

/** A secret detector: `(text) => SecretFindingV1[]`. Defaults to the ported pattern detector. */
type SecretDetector = (text: string) => Array<SecretFindingV1>;

/** Run the documented output-safety checks on an LLM completion. Mirrors `OutputSafetyValidator`. */
export class OutputSafetyValidator {
  private readonly detect: SecretDetector;
  private readonly maxOutputChars: number;

  public constructor(
    { secretDetector, maxOutputChars }: { secretDetector?: SecretDetector; maxOutputChars?: number } = {},
  ) {
    this.detect = secretDetector ?? detectSecrets;
    this.maxOutputChars = maxOutputChars ?? MAX_OUTPUT_CHARS;
  }

  public validate(text: string): OutputSafetyDecision {
    const reasons: Array<OutputSafetyReason> = [];
    const details: Array<string> = [];

    // 1. length
    if (text.length > this.maxOutputChars) {
      reasons.push("length_exceeded");
      details.push(`output ${text.length} chars exceeds cap of ${this.maxOutputChars}`);
    }

    // 2. privileged tag (first match only)
    const lowered = text.toLowerCase();
    for (const fragment of FORBIDDEN_TAG_FRAGMENTS) {
      if (lowered.includes(fragment.toLowerCase())) {
        reasons.push("privileged_tag_emitted");
        details.push(`forbidden tag fragment: ${pyRepr(fragment)}`);
        break;
      }
    }

    // 3. secret leak
    const secretFindings = this.detect(text);
    if (secretFindings.length > 0) {
      reasons.push("secret_leaked");
      const kinds = [...new Set(secretFindings.map((f) => f.kind))].sort();
      details.push(`secret detector kinds: ${pyReprList(kinds)}`);
    }

    // 4. tool-call shape (first match only)
    for (let i = 0; i < FORBIDDEN_TOOL_CALL_PATTERNS.length; i++) {
      if (FORBIDDEN_TOOL_CALL_PATTERNS[i]!.test(text)) {
        reasons.push("tool_call_shape_emitted");
        details.push(`matched tool-call pattern: ${pyRepr(FORBIDDEN_TOOL_CALL_PATTERN_SOURCES[i]!)}`);
        break;
      }
    }

    if (reasons.length > 0) {
      const detail = details.join("; ").slice(0, 512);
      return {
        schema_version: 1,
        decision: "block",
        reasons,
        detail,
        findings: reasons.includes("secret_leaked") ? secretFindings : [],
      };
    }
    return { schema_version: 1, decision: "allow", reasons: [], detail: "", findings: [] };
  }

  public validateFinding(finding: FindingLike): OutputSafetyDecision {
    const textParts = [finding.title, finding.body];
    if (finding.suggestion) {
      textParts.push(finding.suggestion);
    }
    const text = textParts.join("\n\n");
    const base = this.validate(text);

    const reasons: Array<OutputSafetyReason> = [...base.reasons];
    const details: Array<string> = base.detail ? [base.detail] : [];

    if (hasInternalClaim(finding.body) && finding.sources.length === 0) {
      reasons.push("internal_claim_uncited");
      details.push("body asserts team practice but no sources cited");
    }

    if (reasons.length > 0) {
      const detail = details.filter((d) => d).join("; ").slice(0, 512);
      // base.findings is empty when base allowed (validate's contract), so this is a no-op for
      // citation-only blocks — mirrors the Python comment.
      return { schema_version: 1, decision: "block", reasons, detail, findings: base.findings };
    }
    return { schema_version: 1, decision: "allow", reasons: [], detail: "", findings: [] };
  }
}
