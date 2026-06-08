// Lexical instruction-pattern detection for Confluence content — 1:1 port of the frozen Python
// vendor/codemaster-py/codemaster/ingest/confluence/injection_patterns.py.
//
// Detects six pattern classes (semantic injection is OUT of this layer's scope — the structural
// defense is the system prompt + reference-material framing downstream). PURE function: no I/O, no
// clock, no random. Idempotent.
//
// PATTERN_SET_VERSION is bumped whenever the pattern set changes; the adversarial-corpus regression
// test asserts >=95% detection per version.
//
// Regex translation notes (Python `re` -> JS RegExp):
//   - re.IGNORECASE                  -> "i" flag
//   - re.MULTILINE                   -> "m" flag (so `^` anchors at each line start)
//   - the hidden_directive zero-width / bidi class                -> "u" flag (unicode code points)
//   - `\b`, `\s`, `.{0,40}` etc. have identical semantics in JS.
// Every pattern is ported VERBATIM from the frozen module so the lexical contract is byte-identical.

// Re-exported from the already-ported contract so the allow-list is single-sourced (the Pydantic
// _validate_flags AfterValidator and this detector both read the same frozenset).
export { PATTERN_CLASSES } from "#contracts/sanitized_page.v1.js";

export const PATTERN_SET_VERSION = 1 as const;

const ROLE_OVERRIDE: ReadonlyArray<RegExp> = [
  /\byou are now\b/i,
  /\bpretend to be\b/i,
  // eslint-disable-next-line security/detect-unsafe-regex -- 1:1 port of the frozen Python regex; `(an? )?` is an optional single token followed by a non-overlapping alternation, no nested/ambiguous quantifiers, so no catastrophic backtracking (heuristic false positive)
  /\bact as (an? )?(unrestricted|jailbroken|admin|root)\b/i,
  /\broleplay (as|the role of)\b/i,
  /\b(you|your role) is (now|to be)\b/i,
];

const INSTRUCTION_NEGATION: ReadonlyArray<RegExp> = [
  /\bignore (all |the )?previous (instructions?|prompts?|rules?)\b/i,
  /\bdisregard (the |all |your )?(previous|prior|earlier) (instructions?|prompts?)\b/i,
  /\bforget (the |your )?(instructions?|rules?|guidelines?)\b/i,
  /\boverride (the |all )?(rules?|policies?|constraints?)\b/i,
  /\bdo not follow\b.{0,40}\b(instructions?|rules?|guidelines?)\b/i,
];

const SYSTEM_PROMPT_LEAK: ReadonlyArray<RegExp> = [
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /^\s*system\s*:/im,
  /<\|system\|>/i,
  /\bsystem prompt\b\s*[:=]/i,
  /^\s*\[INST\]/im,
];

const OUTPUT_FORMAT_HIJACK: ReadonlyArray<RegExp> = [
  /\brespond (only |exclusively )?(with|in) (JSON|XML|YAML)\b/i,
  /\bformat your (reply|response|answer) as\b/i,
  /\boutput (only |exactly )(the )?(following|below)\b/i,
  /\breply with (only|just) (the )?(word|token|phrase)\b/i,
  /\breturn (exactly|only) (the )?(string|value)\b/i,
];

const JAILBREAK_PHRASING: ReadonlyArray<RegExp> = [
  /\b(DAN|STAN|DUDE|AIM) mode\b/i,
  /\bdo anything now\b/i,
  /\bhypothetically(,|\s+speaking)/i,
  /\bfor (educational|research) purposes\b.{0,40}\b(ignore|bypass)\b/i,
  /\bdeveloper mode\b/i,
];

// zero-width chars (U+200B-U+200F), BOM (U+FEFF), soft hyphen (U+00AD), and the LRE/RLE/PDF/LRO/RLO
// bidi override marks (U+202A-U+202E). Built from explicit `\u` escapes (rather than a literal
// containing invisible code points) so the source stays readable and lint-clean; the `u` flag makes
// the class operate on code points exactly as the frozen Python re.compile did. The class
// intentionally detects the PRESENCE of any single invisible/bidi code point (including the
// zero-width joiner) as an evasion signal; it never needs to combine them.
/* eslint-disable no-misleading-character-class -- presence-detection class, never combining (1:1 port) */
const HIDDEN_DIRECTIVE_INVISIBLE = new RegExp(
  "[\\u200b\\u200c\\u200d\\u200e\\u200f\\ufeff\\u00ad\\u202a-\\u202e]",
  "u",
);
/* eslint-enable no-misleading-character-class */

const HIDDEN_DIRECTIVE: ReadonlyArray<RegExp> = [
  HIDDEN_DIRECTIVE_INVISIBLE,
  // tag-like attributes hiding directives.
  /\bstyle\s*=\s*["']\s*display\s*:\s*none\b/i,
  // HTML comment with imperative content.
  /<!--\s*(?:ignore|bypass|approve|skip)\b/i,
];

const CLASS_PATTERNS: ReadonlyArray<readonly [string, ReadonlyArray<RegExp>]> = [
  ["role_override", ROLE_OVERRIDE],
  ["instruction_negation", INSTRUCTION_NEGATION],
  ["system_prompt_leak", SYSTEM_PROMPT_LEAK],
  ["output_format_hijack", OUTPUT_FORMAT_HIJACK],
  ["jailbreak_phrasing", JAILBREAK_PHRASING],
  ["hidden_directive", HIDDEN_DIRECTIVE],
];

/**
 * Scan `body` for lexical injection patterns. Return the matched class names.
 *
 * PURE: no I/O, no clock, no random. Idempotent.
 */
export function detectInjectionFlags(body: string): ReadonlySet<string> {
  if (!body) {
    return new Set<string>();
  }
  const matched = new Set<string>();
  for (const [className, patterns] of CLASS_PATTERNS) {
    if (patterns.some((p) => p.test(body))) {
      matched.add(className);
    }
  }
  return matched;
}
